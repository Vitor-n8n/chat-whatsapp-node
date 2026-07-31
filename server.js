const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Variáveis de Ambiente
const EVOLUTION_URL = process.env.EVOLUTION_URL;
const API_KEY = process.env.API_KEY; 
const INSTANCE_NAME = process.env.INSTANCE_NAME; 

// 1. Configuração do Postgres
const pool = new Pool({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.POSTGRES_PORT || 5432,
});

// Cria a tabela de mensagens caso não exista
pool.query(`
    CREATE TABLE IF NOT EXISTS mensagens (
        id SERIAL PRIMARY KEY,
        remote_jid VARCHAR(100),
        push_name VARCHAR(100),
        texto TEXT,
        from_me BOOLEAN,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).then(() => console.log('✅ Tabela do Postgres verificada')).catch(console.error);

// 2. Configuração do Redis
const redisClient = redis.createClient({ url: `redis://${process.env.REDIS_HOST}:6379` });
redisClient.on('error', (err) => console.error('Erro no Redis', err));
redisClient.connect().then(() => console.log('✅ Redis conectado'));

app.use(express.json());
app.use(express.static('public'));

// Webhook para RECEBER mensagens
app.post('/webhook', async (req, res) => {
    const data = req.body;
    
    if (data.event === 'messages.upsert') {
        const msg = data.data;
        
        if (!msg.key.fromMe) {
            const payload = {
                remoteJid: msg.key.remoteJid,
                pushName: msg.pushName || 'Cliente',
                text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Mensagem sem texto',
                fromMe: false
            };

            // Salva a mensagem recebida no Postgres
            await pool.query(
                'INSERT INTO mensagens (remote_jid, push_name, texto, from_me) VALUES ($1, $2, $3, $4)',
                [payload.remoteJid, payload.pushName, payload.text, payload.fromMe]
            );

            io.emit('nova_mensagem', payload);
        }
    }
    return res.status(200).json({ status: 'success' });
});

// Socket.io
io.on('connection', async (socket) => {
    console.log('Atendente conectado:', socket.id);

    // Quando o atendente conecta, busca as últimas 50 mensagens do banco e envia para a tela
    try {
        const historico = await pool.query('SELECT * FROM mensagens ORDER BY criado_em ASC LIMIT 50');
        socket.emit('historico_mensagens', historico.rows);
    } catch (error) {
        console.error('Erro ao buscar histórico:', error);
    }

    // Quando o atendente ENVIA uma mensagem
    socket.on('enviar_mensagem', async (dados) => {
        const { remoteJid, text } = dados;

        try {
            const response = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': API_KEY },
                body: JSON.stringify({ number: remoteJid, text: text })
            });

            if (response.ok) {
                // Salva a mensagem enviada no Postgres
                await pool.query(
                    'INSERT INTO mensagens (remote_jid, push_name, texto, from_me) VALUES ($1, $2, $3, $4)',
                    [remoteJid, 'Você', text, true]
                );

                socket.emit('mensagem_enviada', { remoteJid, text, fromMe: true });
            }
        } catch (error) {
            console.error('Erro ao enviar mensagem:', error);
        }
    });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});