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

// --- Discord Helper Functions ---

// Cache for Animal Images (Start with empty, fill dynamically)
const ANIMAL_IMAGES = {};

// Helper to fetch image from Fandom Wiki
async function fetchWikiImage(animalName) {
    if (!animalName) return null;

    // Check cache first
    if (ANIMAL_IMAGES[animalName]) {
        return ANIMAL_IMAGES[animalName];
    }

    try {
        // Format URL: Replace spaces with underscores
        const wikiUrl = `https://stealabrainrot.fandom.com/wiki/${animalName.split(' ').join('_')}`;
        console.log(`[Wiki Fetch] Fetching image for: ${animalName} from ${wikiUrl}`);

        const response = await axios.get(wikiUrl, {
            timeout: 5000, // 5s timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        // Regex to find og:image meta tag
        // <meta property="og:image" content="https://static.wikia.nocookie.net/..." />
        const match = response.data.match(/property="og:image"\s+content="([^"]+)"/i);
        
        if (match && match[1]) {
            const imageUrl = match[1];
            console.log(`[Wiki Fetch] Found image: ${imageUrl}`);
            ANIMAL_IMAGES[animalName] = imageUrl; // Cache it
            return imageUrl;
        } else {
            console.log(`[Wiki Fetch] No og:image found for ${animalName}`);
            ANIMAL_IMAGES[animalName] = "NOT_FOUND"; // Cache failure to avoid refetching
            return null;
        }
    } catch (error) {
        console.error(`[Wiki Fetch] Failed for ${animalName}: ${error.message}`);
        ANIMAL_IMAGES[animalName] = "NOT_FOUND";
        return null;
    }
}

// Helper to parse generation strings (e.g., "250M/s") into numbers for comparison
function parseGeneration(genStr) {
    if (!genStr) return 0;
    // Remove '/s' and commas, trim whitespace
    const cleanStr = genStr.toString().replace(/\/s/gi, '').replace(/,/g, '').trim();
    
    // Regex to separate number and suffix
    const match = cleanStr.match(/^([\d\.]+)([a-zA-Z]*)$/);
    if (!match) return 0;
    
    const val = parseFloat(match[1]);
    const suffix = match[2].toLowerCase();
    
    const multipliers = {
        'k': 1e3,
        'm': 1e6,
        'b': 1e9,
        't': 1e12,
        'q': 1e15, 'qa': 1e15,
        'qi': 1e18,
        'sx': 1e21,
        'sp': 1e24,
        'oc': 1e27,
        'no': 1e30,
        'dc': 1e33
    };
    
    return val * (multipliers[suffix] || 1);
}

async function sendToDiscord(payload) {
    if (!DISCORD_WEBHOOK_URL) {
        console.log("Discord Webhook URL not set. Skipping Discord notification.");
        return { success: false };
    }

    const animals = payload.animals;
    const jobId = payload.jobId;
    
    // 1. Find the "Best" Animal (Highest Generation)
    let bestAnimal = null;
    let maxGenValue = -1;

    for (const animal of animals) {
        const genVal = parseGeneration(animal.Generation);
        if (genVal > maxGenValue) {
            maxGenValue = genVal;
            bestAnimal = animal;
        }
    }
    
    // Fallback: If parsing failed or list is empty, use the first one
    if (!bestAnimal && animals.length > 0) {
        bestAnimal = animals[0];
    }

    // 2. Group animals by Name + Generation for the description list
    const animalCounts = {};
    for (const a of animals) {
        const key = `${a.Name}|${a.Generation || ''}`;
        if (!animalCounts[key]) {
            animalCounts[key] = { count: 0, name: a.Name, gen: a.Generation };
        }
        animalCounts[key].count++;
    }

    const descriptionLines = Object.values(animalCounts).map(item => {
        let line = `${item.count}x ${item.name}`;
        if (item.gen) {
            line += ` ${item.gen}`;
        }
        return line;
    });

    // 3. Construct the Embed Title
    // "Name Generation" (e.g., "Dragon Cannelloni 250M/s")
    const embedTitle = bestAnimal 
        ? `${bestAnimal.Name} ${bestAnimal.Generation || ''}`.trim()
        : "Animals Detected";

    // 4. Try to fetch/find image for the best animal
    let imageUrl = null;
    let wikiUrl = null;
    if (bestAnimal) {
        // Construct Wiki URL for the user to click
        const safeName = bestAnimal.Name.split(' ').join('_');
        wikiUrl = `https://stealabrainrot.fandom.com/wiki/${safeName}`;
        
        // Fetch image (or get from cache)
        imageUrl = await fetchWikiImage(bestAnimal.Name);
        if (imageUrl === "NOT_FOUND") imageUrl = null;
    }

    const embed = {
        title: embedTitle,
        url: wikiUrl, // Make title clickable
        color: 0x2F3136, // Dark Gray
        description: `**Server Job ID:** \`${jobId}\`\n\n` + 
                     "```\n" + 
                     descriptionLines.join('\n') + 
                     "\n```",
        footer: {
            text: `Overview | ${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}`
        }
    };

    // 5. Add Image/Thumbnail if found
    if (imageUrl) {
        embed.thumbnail = { url: imageUrl };
    }

    try {
        console.log("Sending POST request to Discord Webhook...");
        
        // Add wait=true to get the message ID back
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
