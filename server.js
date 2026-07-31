const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// O Node.js lê automaticamente do .env ou do container Docker
const EVOLUTION_URL = process.env.EVOLUTION_URL;
const API_KEY = process.env.API_KEY; 
const INSTANCE_NAME = process.env.INSTANCE_NAME;

app.use(express.json());
app.use(express.static('public'));

// Webhook para RECEBER mensagens do WhatsApp
app.post('/webhook', (req, res) => {
    const data = req.body;
    
    // Verifica se é uma mensagem recebida
    if (data.event === 'messages.upsert') {
        const msg = data.data;
        
        // Garante que não é mensagem enviada por você mesmo via celular
        if (!msg.key.fromMe) {
            const payload = {
                id: msg.key.id,
                remoteJid: msg.key.remoteJid,
                pushName: msg.pushName || 'Cliente',
                text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || 'Mensagem sem texto',
                fromMe: false
            };

            // Envia para o HTML via Socket.io
            io.emit('nova_mensagem', payload);
        }
    }

    return res.status(200).json({ status: 'success' });
});

// Socket.io para ENVIAR mensagens do Painel -> Evolution API -> WhatsApp
io.on('connection', (socket) => {
    console.log('Atendente conectado no painel:', socket.id);

    socket.on('enviar_mensagem', async (dados) => {
        const { remoteJid, text } = dados;

        try {
            // Envia a mensagem para a Evolution API
            const response = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': API_KEY
                },
                body: JSON.stringify({
                    number: remoteJid,
                    text: text
                })
            });

            if (response.ok) {
                // Desenha a mensagem enviada na tela do atendente
                socket.emit('mensagem_enviada', {
                    remoteJid,
                    text,
                    fromMe: true
                });
            } else {
                console.error('Erro ao enviar via Evolution API:', await response.text());
            }
        } catch (error) {
            console.error('Erro de conexão com Evolution API:', error);
        }
    });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
    console.log(`Servidor de Chat rodando na porta ${PORT}`);
});