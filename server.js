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

            // Handle animal logs from WebSocket same as Webhook
            if (data.type === 'animal_log' && data.animals && data.animals.length > 0) {
                // Broadcast this animal log to OTHER connected clients (like the autojoiner)
                broadcast(data);

                // Server-Side Deduplication Logic
                const animals = data.animals;
                let hasNewItems = false;
                const payloadOccurrenceMap = {};

                for (const animal of animals) {
                    const rawName = animal.Name || "Unknown";
                    const rawGen = animal.Generation || "";
                    const baseKey = `${data.jobId}_${rawName}_${rawGen}`;
                    
                    payloadOccurrenceMap[baseKey] = (payloadOccurrenceMap[baseKey] || 0) + 1;
                    const occurrenceIndex = payloadOccurrenceMap[baseKey];
                    const uniqueKey = `${baseKey}_#${occurrenceIndex}`;

                    if (!recentLogs.has(uniqueKey)) {
                        hasNewItems = true;
                    }
                }

                if (hasNewItems) {
                    const refreshOccurrenceMap = {};
                    
                    for (const animal of animals) {
                        const rawName = animal.Name || "Unknown";
                        const rawGen = animal.Generation || "";
                        const baseKey = `${data.jobId}_${rawName}_${rawGen}`;
                        
                        refreshOccurrenceMap[baseKey] = (refreshOccurrenceMap[baseKey] || 0) + 1;
                        const occurrenceIndex = refreshOccurrenceMap[baseKey];
                        const uniqueKey = `${baseKey}_#${occurrenceIndex}`;

                        if (recentLogs.has(uniqueKey)) {
                            clearTimeout(recentLogs.get(uniqueKey));
                        }
                        
                        const timeoutId = setTimeout(() => recentLogs.delete(uniqueKey), 60000);
                        recentLogs.set(uniqueKey, timeoutId);
                    }

                    console.log('Received WebSocket message with NEW items:', msgString);
                    console.log("WebSocket: Adding to Discord queue...");
                    messageQueue.push(data);
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

const recentLogs = new Map();

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;

    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const payload = messageQueue[0];
        
        try {
            const result = await sendToDiscord(payload);
            
            if (result.success) {
                messageQueue.shift();
                await new Promise(resolve => setTimeout(resolve, 4000));
            } else if (result.rateLimited) {
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

app.get('/logs', (req, res) => {
    res.status(200).send("This endpoint expects a POST request with log data. The server is working! 🟢");
});

app.post('/logs', (req, res) => {
    const data = req.body;
    console.log('Received Webhook data:', JSON.stringify(data, null, 2));

    broadcast({ type: 'webhook_forward', data: data });

    if (data.type === 'animal_log' && data.animals && data.animals.length > 0) {
        const animals = data.animals;
        let hasNewItems = false;
        const payloadOccurrenceMap = {};

        for (const animal of animals) {
            const rawName = animal.Name || "Unknown";
            const rawGen = animal.Generation || "";
            const baseKey = `${data.jobId}_${rawName}_${rawGen}`;
            
            payloadOccurrenceMap[baseKey] = (payloadOccurrenceMap[baseKey] || 0) + 1;
            const occurrenceIndex = payloadOccurrenceMap[baseKey];
            const uniqueKey = `${baseKey}_#${occurrenceIndex}`;

            if (!recentLogs.has(uniqueKey)) {
                hasNewItems = true;
            }
        }

        if (hasNewItems) {
            const refreshOccurrenceMap = {};
            
            for (const animal of animals) {
                const rawName = animal.Name || "Unknown";
                const rawGen = animal.Generation || "";
                const baseKey = `${data.jobId}_${rawName}_${rawGen}`;
                
                refreshOccurrenceMap[baseKey] = (refreshOccurrenceMap[baseKey] || 0) + 1;
                const occurrenceIndex = refreshOccurrenceMap[baseKey];
                const uniqueKey = `${baseKey}_#${occurrenceIndex}`;

                if (recentLogs.has(uniqueKey)) {
                    clearTimeout(recentLogs.get(uniqueKey));
                }
                
                const timeoutId = setTimeout(() => recentLogs.delete(uniqueKey), 60000);
                recentLogs.set(uniqueKey, timeoutId);
            }
            
            console.log("Adding to Discord queue (Webhook)...");
            messageQueue.push(data);
            processQueue();
        }
    }

    res.status(200).send('Data received');
});

async function sendToDiscord(payload) {
    if (!DISCORD_WEBHOOK_URL) {
        console.log("Discord Webhook URL not set. Skipping Discord notification.");
        return { success: false };
    }

    const animals = payload.animals;
    const jobId = payload.jobId;
    
    const parseGen = (genStr) => {
        if (!genStr) return 0;
        let clean = genStr.replace('$', '').replace('/s', '').replace(/,/g, '');
        let multiplier = 1;
        
        if (clean.includes('K')) {
            multiplier = 1000;
            clean = clean.replace('K', '');
        } else if (clean.includes('M')) {
            multiplier = 1000000;
            clean = clean.replace('M', '');
        } else if (clean.includes('B')) {
            multiplier = 1000000000;
            clean = clean.replace('B', '');
        }
        
        return parseFloat(clean) * multiplier;
    };
    
    // Sort animals by generation (High to Low)
    animals.sort((a, b) => {
        return parseGen(b.Generation) - parseGen(a.Generation);
    });

    const counts = {};
    let hasCarpet = false;
    let hasDuel = false;
    
    // First pass: Determine title status and create smart grouping keys
    animals.forEach(a => {
        if (a.Plot === "Carpet") {
            hasCarpet = true;
        }
        if (a.IsDuel === true) {
            hasDuel = true;
        }
        
        const rawName = a.Name || "";
        const rawGen = a.Generation || "";
        const rawPlot = a.Plot || "UserPlot"; // Default to "UserPlot" if Plot is missing/null
        
        // Smart Grouping Key: Name + Generation + Plot
        const nameKey = rawName.replace(/\s+/g, "").toLowerCase();
        const genKey = rawGen.replace(/\s+/g, "").toLowerCase();
        const plotKey = rawPlot.replace(/\s+/g, "").toLowerCase();
        
        const key = `${nameKey}|${genKey}|${plotKey}`; 
        
        counts[key] = (counts[key] || 0) + 1;
        a._groupKey = key;
    });

    const descriptionLines = [];
    const processedKeys = new Set();
    
    // Second pass: Generate lines using the smart grouping
    animals.forEach(a => {
        const key = a._groupKey;
        
        // Only process each unique key once
        if (processedKeys.has(key)) return;
        
        const count = counts[key] || 1;
        const countStr = `${count}x `;
        const genStr = a.Generation ? ` ${a.Generation}` : '';
        
        // The plot text is intentionally omitted from the final line output
        descriptionLines.push(`${countStr}${a.Name}${genStr}`);
        processedKeys.add(key);
    });

    const titlePrefix = hasDuel ? "[Duel] 🛡️ " : "";
    const carpetEmoji = hasCarpet ? " 🌹" : "";

    const embed = {
        title: `🐈 ${titlePrefix}Animals Detected!${carpetEmoji}`,
        color: 0x2F3136,
        description: `**Server Job ID:** \`${jobId}\`\n\n` + 
                     "```\n" + 
                     descriptionLines.join('\n') + 
                     "\n```",
        footer: {
            text: `Overview | ${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}`
        }
    };

    try {
        const response = await axios.post(`${DISCORD_WEBHOOK_URL}?wait=true`, {
            embeds: [embed]
        });
        return { success: true };
    } catch (error) {
        console.error("Failed to send to Discord:", error.message);
        if (error.response && error.response.status === 429) {
            const retryAfter = error.response.data.retry_after || 60;
            return { success: false, rateLimited: true, retryAfter: retryAfter };
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

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server.listen(port, () => {
    console.log(`Bridge server listening on port ${port}`);
}).on('error', (err) => {
    console.error('Server failed to start:', err);
});
