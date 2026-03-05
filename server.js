const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const app = express();
const port = 3000;

// Configuration
// REPLACE THIS WITH YOUR DISCORD WEBHOOK URL
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1465114831249215488/47sTKMrvCBs8r54cAiR47xR21lNWQcinL-16bKfITil-4wkPdB3_LhHMMHC2TdVVbOIq"; 

// Middleware to parse JSON bodies
app.use(bodyParser.json());

// Uptime Endpoint (For UptimeRobot/Render)
app.get('/', (req, res) => {
    res.status(200).send("Bridge Server is Online! 🟢");
});

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected WebSocket clients
const clients = new Set();

wss.on('connection', (ws) => {
    console.log('New WebSocket client connected');
    clients.add(ws);

    ws.on('message', (message) => {
        const msgString = message.toString();
        
        try {
            const data = JSON.parse(msgString);
            
            // Ignore ping messages to keep console clean
            if (data.type === 'ping') return;

            // console.log('Received WebSocket message:', msgString); // Commented out to reduce noise

            // Handle animal logs from WebSocket same as Webhook
            if (data.type === 'animal_log' && data.animals && data.animals.length > 0) {
                // Broadcast this animal log to OTHER connected clients (like the autojoiner)
                broadcast(data);

                // Server-Side Deduplication
                const uniqueAnimals = [];
                for (const animal of data.animals) {
                    const key = `${data.jobId}_${animal.Name}_${animal.Generation || ''}`;
                    if (!recentLogs.has(key)) {
                        recentLogs.add(key);
                        uniqueAnimals.push(animal);
                        setTimeout(() => recentLogs.delete(key), 60000);
                    } else {
                        // console.log(`[Server] Suppressed duplicate (WS): ${animal.Name}`);
                    }
                }

                if (uniqueAnimals.length > 0) {
                    // Log the raw message ONLY if it's not a duplicate (User Request)
                    console.log('Received WebSocket message:', msgString);
                    
                    const payload = { ...data, animals: uniqueAnimals };
                    console.log("WebSocket: Adding to Discord queue...");
                    messageQueue.push(payload);
                    processQueue();
                }
            }
        } catch (e) {
            console.error("Failed to parse WebSocket message:", e);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        clients.delete(ws);
    });
});

const messageQueue = [];
let isProcessingQueue = false;

// Server-Side Deduplication Cache
const recentLogs = new Set();

// Worker function to process the queue
async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;

    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const payload = messageQueue[0]; // Peek first, remove only if successful or non-recoverable
        
        try {
            const result = await sendToDiscord(payload);
            
            if (result.success) {
                messageQueue.shift(); // Remove from queue
                // Wait 4 seconds to be safe (15 requests per minute)
                await new Promise(resolve => setTimeout(resolve, 4000));
            } else if (result.rateLimited) {
                // Increment retry count to prevent infinite loops
                payload.retryCount = (payload.retryCount || 0) + 1;
                
                if (payload.retryCount > 5) {
                    console.error("[QUEUE] Message failed 5 times (Rate Limit). Dropping it.");
                    messageQueue.shift();
                } else {
                    const waitTime = (result.retryAfter || 60) * 1000;
                    console.warn(`[QUEUE PAUSED] Rate Limit hit (Attempt ${payload.retryCount}/5). Waiting ${waitTime/1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    console.log("[QUEUE RESUMED] Retrying message...");
                }
            } else {
                // Other error, drop message
                console.warn("Dropping message due to unknown error.");
                messageQueue.shift();
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            console.error("Queue fatal error:", error);
            messageQueue.shift();
        }
    }

    isProcessingQueue = false;
}

// Updated Webhook Endpoint
app.get('/logs', (req, res) => {
    res.status(200).send("This endpoint expects a POST request with log data. The server is working! 🟢");
});

app.post('/logs', (req, res) => {
    const data = req.body;
    console.log('Received Webhook data:', JSON.stringify(data, null, 2));

    // Broadcast to WebSocket clients
    broadcast({ type: 'webhook_forward', data: data });

    // Send to Discord (Via Queue)
    if (data.type === 'animal_log' && data.animals && data.animals.length > 0) {
        // Server-Side Deduplication
        const uniqueAnimals = [];
        
        for (const animal of data.animals) {
            const key = `${data.jobId}_${animal.Name}_${animal.Generation || ''}`;
            if (!recentLogs.has(key)) {
                recentLogs.add(key);
                uniqueAnimals.push(animal);
                // Expire cache after 60 seconds
                setTimeout(() => recentLogs.delete(key), 60000);
            } else {
                // console.log(`[Server] Suppressed duplicate: ${animal.Name}`);
            }
        }
        
        if (uniqueAnimals.length > 0) {
            // Create a new payload with only unique animals
            const payload = { ...data, animals: uniqueAnimals };
            console.log("Adding to Discord queue...");
            messageQueue.push(payload);
            processQueue();
        }
    } else {
        console.log("Skipping Discord: Condition failed. Type:", data.type, "Animals:", data.animals ? data.animals.length : "None");
    }

    res.status(200).send('Data received');
});

    // ... (rest of the connection logic)

async function sendToDiscord(payload) {
    if (!DISCORD_WEBHOOK_URL) {
        console.log("Discord Webhook URL not set. Skipping Discord notification.");
        return { success: false };
    }

    const animals = payload.animals;
    const jobId = payload.jobId;
    
    // Create a rich embed for Discord
    // Group animals by Name + Generation + Owner
    const animalCounts = {};
    for (const a of animals) {
        const owner = a.Plot || "Unknown";
        const key = `${a.Name}|${a.Generation || ''}|${owner}`;
        if (!animalCounts[key]) {
            animalCounts[key] = { count: 0, name: a.Name, gen: a.Generation, owner: owner };
        }
        animalCounts[key].count++;
    }

    const descriptionLines = Object.values(animalCounts).map(item => {
        let line = `${item.count}x ${item.name}`;
        if (item.gen) {
            line += ` ${item.gen}`;
        }
        line += ` [${item.owner}]`;
        return line;
    });

    const embed = {
        title: "🐈  Animals Detected!",
        color: 0x2F3136, // Dark Gray (Discord Background Color)
        description: `**Server Job ID:** \`${jobId}\`\n\n` + 
                     "```\n" + 
                     descriptionLines.join('\n') + 
                     "\n```" +
                     `\n**<t:${Math.floor(Date.now() / 1000)}:R> | 𝐎𝐯𝐞𝐫𝐕𝐢𝐞𝐰 𝐀𝐉 👁**`,
        footer: {
            text: `Scan Time: ${new Date().toLocaleTimeString()}`
        }
    };

    try {
        console.log("Sending POST request to Discord Webhook...");
        
        // Add wait=true to get the message ID back (Optional now, but harmless to keep)
        const response = await axios.post(`${DISCORD_WEBHOOK_URL}?wait=true`, {
            embeds: [embed]
        });
        
        console.log("Sent notification to Discord.");
        
        return { success: true };
    } catch (error) {
        console.error("Failed to send to Discord:", error.message);
        if (error.response) {
             console.error("Discord Response Status:", error.response.status);
             
             // Check for Rate Limit (429)
             if (error.response.status === 429) {
                 const retryAfter = error.response.data.retry_after || 60;
                 console.warn(`[RATE LIMIT] Discord blocked us! Retry after: ${retryAfter} seconds.`);
                 return { success: false, rateLimited: true, retryAfter: retryAfter };
             }
        }
        return { success: false, rateLimited: false };
    }
}

function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

// Error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server.listen(port, () => {
    console.log(`Bridge server listening on port ${port}`);
    console.log(`Webhook URL: http://localhost:${port}/logs`);
    console.log(`WebSocket URL: ws://localhost:${port}`);
}).on('error', (err) => {
    console.error('Server failed to start:', err);
});
