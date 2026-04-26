const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize Socket.IO with proper CORS
const io = socketIo(server, {
    cors: {
        origin: [
            'https://draftanything.vercel.app',
            'https://draft-frontend.vercel.app',
            'http://localhost:5500',
            'http://localhost:3000',
            'http://127.0.0.1:5500',
            'http://127.0.0.1:3000'
        ],
        methods: ["GET", "POST", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

const pgPool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: {
        require: true,
        rejectUnauthorized: false
    }
});

// CORS for Express routes
app.use(cors({
    origin: [
        'https://draftanything.vercel.app',
        'https://draft-frontend.vercel.app',
        'http://localhost:5500',
        'http://localhost:3000',
        'http://127.0.0.1:5500',
        'http://127.0.0.1:3000'
    ],
    credentials: true
}));

app.use(express.json());

// Store active game rooms
const gameRooms = new Map();

// ==================== API ROUTES ====================

// Get all available categories - only those with live = 'yes'
app.get('/api/categories', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT table_name, number_of_items 
            FROM draft_choices 
            WHERE live = 'yes'
            ORDER BY table_name
        `);
        
        console.log('Categories returned:', result.rows);
        
        const categories = result.rows.map(row => ({
            table_name: row.table_name,
            item_count: parseInt(row.number_of_items)
        }));
        
        res.json({ success: true, categories: categories });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get items with scores from specific category
app.get('/api/items/:category/with-scores', async (req, res) => {
    const { category } = req.params;
    
    try {
        const tableCheck = await pgPool.query(
            'SELECT table_name FROM draft_choices WHERE table_name = $1',
            [category]
        );
        
        if (tableCheck.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'Invalid category' });
        }
        
        const result = await pgPool.query(
            `SELECT item_name, score FROM ${category} ORDER BY item_name`
        );
        res.json({ success: true, items: result.rows, category: category });
    } catch (error) {
        console.error('Error fetching items with scores:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        await pgPool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: error.message 
        });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Draft Game API',
        version: '2.0.0',
        status: 'running',
        endpoints: {
            categories: 'GET /api/categories',
            itemsWithScores: 'GET /api/items/:category/with-scores',
            health: 'GET /api/health'
        },
        websocket: 'Socket.IO enabled for multiplayer'
    });
});

// ==================== SOCKET.IO MULTIPLAYER ====================

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Create a new game room
    socket.on('createGame', (gameConfig, callback) => {
        const roomCode = generateRoomCode();
        const gameRoom = {
            roomCode: roomCode,
            host: socket.id,
            players: [{
                id: socket.id,
                name: gameConfig.playerName || 'Host',
                isReady: true
            }],
            config: gameConfig,
            gameState: 'waiting',
            draftState: null,
            createdAt: Date.now()
        };
        
        gameRooms.set(roomCode, gameRoom);
        socket.join(roomCode);
        
        console.log(`Game created: ${roomCode} by ${socket.id}`);
        
        if (callback) callback({ success: true, roomCode: roomCode });
        io.to(roomCode).emit('playerJoined', gameRoom.players);
        io.to(roomCode).emit('hostReady', true);
    });

    // Join an existing game
    socket.on('joinGame', (data, callback) => {
        const { roomCode, playerName } = data;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) {
            if (callback) callback({ success: false, error: 'Room not found' });
            return;
        }
        
        if (gameRoom.players.length >= gameRoom.config.numPlayers) {
            if (callback) callback({ success: false, error: 'Room is full' });
            return;
        }
        
        const newPlayer = {
            id: socket.id,
            name: playerName || `Player ${gameRoom.players.length + 1}`,
            isReady: false
        };
        
        gameRoom.players.push(newPlayer);
        socket.join(roomCode);
        
        console.log(`Player ${socket.id} joined room ${roomCode}`);
        
        if (callback) callback({ success: true, roomCode: roomCode });
        io.to(roomCode).emit('playerJoined', gameRoom.players);
        io.to(roomCode).emit('playerCount', gameRoom.players.length);
    });

    // Player ready status
    socket.on('playerReady', (roomCode) => {
        const gameRoom = gameRooms.get(roomCode);
        if (gameRoom) {
            const player = gameRoom.players.find(p => p.id === socket.id);
            if (player) {
                player.isReady = true;
                io.to(roomCode).emit('playerReadyUpdate', gameRoom.players);
                
                const allReady = gameRoom.players.every(p => p.isReady === true);
                const fullPlayers = gameRoom.players.length === gameRoom.config.numPlayers;
                
                if (allReady && fullPlayers) {
                    io.to(roomCode).emit('allPlayersReady');
                }
            }
        }
    });

    // Start the draft
    socket.on('startDraft', async (roomCode) => {
        console.log(`Start draft requested for room: ${roomCode} by ${socket.id}`);
        
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) {
            socket.emit('startDraftError', 'Game room not found');
            return;
        }
        
        if (gameRoom.host !== socket.id) {
            socket.emit('startDraftError', 'Only the host can start the draft');
            return;
        }
        
        const allReady = gameRoom.players.every(p => p.isReady === true);
        const correctCount = gameRoom.players.length === gameRoom.config.numPlayers;
        
        if (!allReady || !correctCount) {
            socket.emit('startDraftError', 'Not all players are ready');
            return;
        }
        
        console.log(`Starting draft for room: ${roomCode}`);
        
        try {
            const items = await loadGameItems(gameRoom.config.category);
            const draftState = initializeDraftState(gameRoom.players, gameRoom.config, items);
            
            gameRoom.gameState = 'drafting';
            gameRoom.draftState = draftState;
            
            io.to(roomCode).emit('draftStarted', draftState);
        } catch (error) {
            console.error('Error loading items for draft:', error);
            socket.emit('startDraftError', 'Failed to load draft items');
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        for (const [roomCode, gameRoom] of gameRooms.entries()) {
            const playerIndex = gameRoom.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const wasHost = gameRoom.host === socket.id;
                gameRoom.players.splice(playerIndex, 1);
                
                io.to(roomCode).emit('playerLeft', gameRoom.players);
                
                if (gameRoom.players.length === 0) {
                    gameRooms.delete(roomCode);
                    console.log(`Room ${roomCode} deleted (empty)`);
                } else if (wasHost && gameRoom.players.length > 0) {
                    gameRoom.host = gameRoom.players[0].id;
                    io.to(roomCode).emit('hostChanged', gameRoom.host);
                }
                break;
            }
        }
    });
});

// Helper functions
function generateRoomCode() {
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
}

async function loadGameItems(category) {
    const result = await pgPool.query(
        `SELECT item_name, score FROM ${category} ORDER BY item_name`
    );
    return result.rows;
}

function initializeDraftState(players, config, items) {
    const draftOrder = generateDraftOrder(players.length, config.numRounds, config.draftType);
    return {
        players: players.map(p => ({ id: p.id, name: p.name })),
        availableItems: items.map(i => i.item_name),
        itemsWithScores: items,
        playersItems: players.map(() => []),
        draftOrder: draftOrder,
        currentPickIndex: 0,
        currentPlayer: players[draftOrder[0].playerIndex],
        numRounds: config.numRounds,
        timerSeconds: config.timerMinutes * 60,
        category: config.category,
        categoryName: config.categoryName
    };
}

function generateDraftOrder(numPlayers, numRounds, draftType) {
    const order = [];
    for (let round = 1; round <= numRounds; round++) {
        if (draftType === 'snake' && round % 2 === 0) {
            for (let i = numPlayers - 1; i >= 0; i--) {
                order.push({ playerIndex: i, round: round });
            }
        } else {
            for (let i = 0; i < numPlayers; i++) {
                order.push({ playerIndex: i, round: round });
            }
        }
    }
    return order;
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`🔌 Socket.IO ready for multiplayer!`);
    console.log(`\n📋 API endpoints ready:`);
    console.log(`   GET /api/categories - Get all categories`);
    console.log(`   GET /api/items/:category/with-scores - Get items with scores`);
    console.log(`   GET /api/health - Health check`);
    console.log(`\n✅ Ready to accept API requests\n`);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await pgPool.end();
    process.exit(0);
});

module.exports = pgPool;