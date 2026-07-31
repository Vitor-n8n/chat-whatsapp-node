const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // Limite aumentado para 100MB

// Aumenta o limite de JSON para aceitar arquivos em Base64 grandes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Variáveis de Ambiente
const EVOLUTION_URL = process.env.EVOLUTION_URL;
const API_KEY = process.env.API_KEY; 
const INSTANCE_NAME = process.env.INSTANCE_NAME; 

// Configuração do Postgres
const pool = new Pool({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.POSTGRES_PORT || 5432,
});

// Configuração do Redis
const redisClient = redis.createClient({ url: `redis://${process.env.REDIS_HOST}:6379` });
redisClient.on('error', (err) => console.error('Erro no Redis', err));
redisClient.connect().then(() => console.log('✅ Redis conectado'));

// Busca lista de contatos
async function buscarListaContatos() {
    const query = `
        SELECT 
            m.remote_jid,
            COALESCE(
                (SELECT push_name FROM mensagens WHERE remote_jid = m.remote_jid AND from_me = false AND push_name IS NOT NULL AND push_name != 'Você' ORDER BY criado_em DESC LIMIT 1),
                split_part(m.remote_jid, '@', 1)
            ) AS push_name,
            m.texto AS ultima_mensagem,
            m.media_type,
            m.criado_em,
            (SELECT COUNT(*) FROM mensagens WHERE remote_jid = m.remote_jid AND lida = false AND from_me = false) AS nao_lidas
        FROM mensagens m
        INNER JOIN (
            SELECT remote_jid, MAX(criado_em) AS max_criado
            FROM mensagens
            GROUP BY remote_jid
        ) ultimas ON m.remote_jid = ultimas.remote_jid AND m.criado_em = ultimas.max_criado
        ORDER BY m.criado_em DESC;
    `;
    const res = await pool.query(query);
    return res.rows;
}

// Webhook para RECEBER mensagens da Evolution API
app.post('/webhook', async (req, res) => {
    const data = req.body;
    
    if (data.event === 'messages.upsert') {
        const msg = data.data;
        
        if (!msg.key.fromMe) {
            const text = msg.message?.conversation || 
                         msg.message?.extendedTextMessage?.text || 
                         msg.message?.imageMessage?.caption || 
                         msg.message?.documentMessage?.caption || 
                         '';

            let mediaUrl = null;
            let mediaType = null;

            if (msg.message?.imageMessage) {
                mediaType = 'image';
                mediaUrl = msg.message.imageMessage.url || null;
            } else if (msg.message?.documentMessage) {
                mediaType = 'document';
                mediaUrl = msg.message.documentMessage.url || null;
            }

            const payload = {
                remoteJid: msg.key.remoteJid,
                pushName: msg.pushName || 'Cliente',
                text: text || (mediaType === 'image' ? '📷 Imagem' : mediaType === 'document' ? '📄 Documento' : 'Mensagem sem texto'),
                mediaUrl,
                mediaType,
                fromMe: false,
                lida: false
            };

            await pool.query(
                'INSERT INTO mensagens (remote_jid, push_name, texto, media_url, media_type, from_me, lida) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [payload.remoteJid, payload.pushName, payload.text, payload.mediaUrl, payload.mediaType, payload.fromMe, payload.lida]
            );

            io.emit('nova_mensagem', payload);

            const contatos = await buscarListaContatos();
            io.emit('lista_contatos', contatos);
        }
    }
    return res.status(200).json({ status: 'success' });
});

// ROTA HTTP DEDICADA PARA ENVIAR MENSAGEM / MÍDIA (Evita travar o Socket)
app.post('/api/enviar-mensagem', async (req, res) => {
    const { remoteJid, text, mediaBase64, mediaType, fileName } = req.body;

    try {
        let endpoint = `${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`;
        let bodyData = { number: remoteJid, text: text || '' };

        if (mediaBase64) {
            endpoint = `${EVOLUTION_URL}/message/sendMedia/${INSTANCE_NAME}`;
            const base64Pura = mediaBase64.includes(',') ? mediaBase64.split(',')[1] : mediaBase64;

            bodyData = {
                number: remoteJid,
                media: base64Pura,
                mediatype: mediaType === 'image' ? 'image' : 'document',
                fileName: fileName || 'arquivo',
                caption: text || ''
            };
        }

        console.log(`📡 Disparando para Evolution API (${endpoint})...`);

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
            body: JSON.stringify(bodyData)
        });

        const responseData = await response.json();

        if (response.ok) {
            const nomeContatoRes = await pool.query(
                "SELECT push_name FROM mensagens WHERE remote_jid = $1 AND from_me = false ORDER BY criado_em DESC LIMIT 1",
                [remoteJid]
            );
            const nomeContato = nomeContatoRes.rows[0]?.push_name || remoteJid.split('@')[0];

            await pool.query(
                'INSERT INTO mensagens (remote_jid, push_name, texto, media_url, media_type, from_me, lida) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [remoteJid, nomeContato, text || (mediaType === 'image' ? '📷 Imagem' : '📄 Documento'), mediaBase64, mediaType, true, true]
            );

            const msgPayload = { remoteJid, text, mediaUrl: mediaBase64, mediaType, fromMe: true };
            io.emit('mensagem_enviada', msgPayload);

            const contatos = await buscarListaContatos();
            io.emit('lista_contatos', contatos);

            return res.json({ success: true });
        } else {
            console.error('❌ Erro na Evolution API:', responseData);
            return res.status(400).json({ error: responseData });
        }
    } catch (error) {
        console.error('❌ Erro Interno ao enviar:', error);
        return res.status(500).json({ error: error.message });
    }
});

// Socket.io para leituras e eventos em tempo real
io.on('connection', async (socket) => {
    console.log('Atendente conectado:', socket.id);

    try {
        const contatos = await buscarListaContatos();
        socket.emit('lista_contatos', contatos);
    } catch (err) {
        console.error('Erro ao buscar lista de contatos:', err);
    }

    socket.on('carregar_conversa', async (remoteJid) => {
        try {
            await pool.query(
                'UPDATE mensagens SET lida = TRUE WHERE remote_jid = $1 AND from_me = FALSE',
                [remoteJid]
            );

            const historico = await pool.query(
                'SELECT * FROM mensagens WHERE remote_jid = $1 ORDER BY criado_em ASC',
                [remoteJid]
            );
            
            socket.emit('historico_conversa', { remoteJid, mensagens: historico.rows });

            const contatos = await buscarListaContatos();
            io.emit('lista_contatos', contatos);
        } catch (err) {
            console.error('Erro ao carregar conversa:', err);
        }
    });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});