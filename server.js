const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static('public'));
app.use(express.json());

const clients = new Map();
const sessionsDir = './.wacache';

if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

// 🔑 PHONE NUMBER LINKING ENDPOINT
app.post('/api/link-phone', async (req, res) => {
    const { phoneNumber } = req.body; // "1234567890"
    
    try {
        const client = await createLinkedDeviceClient(phoneNumber);
        res.json({
            success: true,
            phoneNumber,
            linkCode: await client.generatePhoneLinkCode(), // 8-digit code
            instructions: "Enter this 8-digit code in WhatsApp > Linked Devices > Link with phone number"
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get 8-digit linking code
app.get('/api/link-code/:phoneNumber', async (req, res) => {
    const client = clients.get(req.params.phoneNumber);
    if (client) {
        res.json({ code: await client.getLinkCode() });
    } else {
        res.status(404).json({ error: 'No active session' });
    }
});

app.get('/api/status/:phoneNumber', (req, res) => {
    const client = clients.get(req.params.phoneNumber);
    res.json({
        connected: !!client?.info?.isReady,
        authenticated: !!client?.info?.isAuthenticated,
        phoneNumber: req.params.phoneNumber
    });
});

// Serve UI
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

async function createLinkedDeviceClient(phoneNumber) {
    const sessionId = phoneNumber.replace(/\D/g, '');
    
    if (clients.has(sessionId)) return clients.get(sessionId);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `phone-link-${sessionId}`,
            dataPath: `${sessionsDir}/${sessionId}`
        }),
        // Linked device browser profile
        puppeteer: {
            headless: true,
            userDataDir: `./user_data/${sessionId}`,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        },
        // Multi-device linked session
        session: {
            phoneNumber: `+1${sessionId}`, // Auto-detect country
            linkType: 'phone'
        }
    });

    // Linked device events (NO QR)
    client.on('authenticated', () => {
        console.log(`✅ ${sessionId} linked via phone`);
        io.emit(`phone:${sessionId}:linked`);
    });

    client.on('ready', () => {
        console.log(`🚀 ${sessionId} active - ${client.info.wid.user}`);
        io.emit(`phone:${sessionId}:ready`);
        
        client.getChats().then(chats => {
            io.emit(`phone:${sessionId}:chats`, chats.slice(0, 50));
        });
    });

    client.on('message', msg => {
        io.emit(`phone:${sessionId}:message`, {
            chatId: msg.from,
            body: msg.body,
            fromMe: msg.fromMe,
            time: msg.t,
            sender: msg.from
        });
    });

    await client.initialize();
    clients.set(sessionId, client);
    return client;
}

// Real-time messaging
io.on('connection', socket => {
    socket.on('join-phone', phoneNumber => {
        socket.join(`phone:${phoneNumber}`);
        socket.phoneNumber = phoneNumber;
    });

    socket.on('send-to-phone', async ({ phoneNumber, chatId, message }) => {
        const client = clients.get(phoneNumber);
        if (client?.info?.isReady) {
            await client.sendMessage(chatId, message);
        }
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 WhatsApp Phone Linker: http://localhost:3000');
});
