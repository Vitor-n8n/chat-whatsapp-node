const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Permite ler JSONs do Webhook
app.use(express.json());

// Serve os arquivos da pasta 'public' (onde fica a tela HTML)
app.use(express.static('public'));

// Rota do Webhook com tratamento para o JSON da Evolution API
app.post('/webhook', (req, res) => {
    const body = req.body;

    console.log('\n--- NOVA MENSAGEM DO WHATSAPP ---');

    // 1. Extrai o nome do contato (ou o número de telefone se não tiver nome)
    const nomeCliente = body.data?.pushName 
        || body.data?.key?.remoteJid?.replace(/\D/g, '') 
        || 'Cliente';

    // 2. Extrai o texto da mensagem (trata texto simples e mensagens com resposta)
    const textoMensagem = body.data?.message?.conversation 
        || body.data?.message?.extendedTextMessage?.text 
        || 'Mensagem sem texto (Mídia/Sticker)';

    // Objeto formatado para o nosso Frontend
    const mensagemTratada = {
        cliente: nomeCliente,
        texto: textoMensagem
    };

    console.log(`De: ${mensagemTratada.cliente} | Texto: ${mensagemTratada.texto}`);

    // Dispara para a tela em tempo real via Socket.io
    io.emit('nova_mensagem', mensagemTratada);

    res.status(200).send('OK');
});

// Evento quando o navegador se conecta
io.on('connection', (socket) => {
    console.log('Um atendente/tela se conectou no sistema!');
});

// Liga o servidor
server.listen(3002, () => {
    console.log('Servidor de Chat rodando com WebSockets na porta 3002!');
});