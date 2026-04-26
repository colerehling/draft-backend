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

app.get('/api/categories', async (req, res) => {
    try {
        const result = await pgPool.query(`
            SELECT table_name, number_of_items 
            FROM draft_choices 
            WHERE live = 'yes'
            ORDER BY table_name
        `);
        
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

app.get('/api/items/:category/with-scores', async (req, res) => {
    const { category } = req.params;
    
    try {
        console.log(`Fetching items for category: ${category}`);
        
        const tableCheck = await pgPool.query(
            'SELECT table_name FROM draft_choices WHERE table_name = $1',
            [category]
        );
        
        if (tableCheck.rows.length === 0) {
            return res.status(400).json({ success: false, error: 'Invalid category' });
        }
        
        // Use parameterized query with identifier - IMPORTANT: sanitize the table name
        const safeCategory = category.replace(/[^a-z_]/gi, '');
        const result = await pgPool.query(
            `SELECT item_name, score FROM "${safeCategory}" ORDER BY item_name`
        );
        
        console.log(`Found ${result.rows.length} items in ${category}`);
        res.json({ success: true, items: result.rows, category: category });
    } catch (error) {
        console.error('Error fetching items with scores:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
    console.log('🟢 New client connected:', socket.id);

    // Create a new game room
    socket.on('createGame', (gameConfig, callback) => {
        console.log('Creating game with config:', gameConfig);
        
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
        
        console.log(`🎮 Game created: ${roomCode} by ${socket.id}`);
        console.log(`Category in config: ${gameConfig.category}`);
        
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
        
        console.log(`👤 Player ${socket.id} joined room ${roomCode}`);
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
        console.log(`🎯 Start draft requested for room: ${roomCode} by ${socket.id}`);
        
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
        
        // Get the category from config
        const category = gameRoom.config.category;
        console.log(`Loading items for category: ${category}`);
        
        if (!category) {
            socket.emit('startDraftError', 'No category selected');
            return;
        }
        
        try {
            const items = await loadGameItems(category);
            
            if (!items || items.length === 0) {
                console.error(`No items found for category: ${category}`);
                socket.emit('startDraftError', `No items found for category "${category}". Please check the database.`);
                return;
            }
            
            console.log(`Loaded ${items.length} items from ${category}`);
            
            const draftState = initializeDraftState(gameRoom.players, gameRoom.config, items);
            gameRoom.gameState = 'drafting';
            gameRoom.draftState = draftState;
            
            io.to(roomCode).emit('draftStarted', draftState);
            console.log(`✅ Draft started for room ${roomCode}`);
            
        } catch (error) {
            console.error('Error loading items for draft:', error);
            socket.emit('startDraftError', `Failed to load draft items: ${error.message}`);
        }
    });

    // Re-join room (for draft page)
    socket.on('joinGameRoom', (roomCode) => {
        const gameRoom = gameRooms.get(roomCode);
        if (gameRoom) {
            socket.join(roomCode);
            console.log(`🔄 Player ${socket.id} rejoined room ${roomCode}`);
            
            if (gameRoom.draftState) {
                socket.emit('draftStarted', gameRoom.draftState);
            }
        }
    });

    // Make a pick during draft
    socket.on('makePick', (data) => {
        const { roomCode, itemName } = data;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom || gameRoom.gameState !== 'drafting') return;
        
        const draft = gameRoom.draftState;
        const currentPick = draft.draftOrder[draft.currentPickIndex];
        
        if (!currentPick || draft.players[currentPick.playerIndex].id !== socket.id) {
            socket.emit('pickError', 'Not your turn');
            return;
        }
        
        const itemIndex = draft.availableItems.indexOf(itemName);
        if (itemIndex === -1) {
            socket.emit('pickError', 'Item not available');
            return;
        }
        
        const scoreItem = draft.itemsWithScores.find(i => i.item_name === itemName);
        const score = scoreItem ? scoreItem.score : 0;
        
        draft.availableItems.splice(itemIndex, 1);
        draft.playersItems[currentPick.playerIndex].push({ name: itemName, score: score });
        
        io.to(roomCode).emit('pickMade', {
            playerId: socket.id,
            item: itemName
        });
        
        draft.currentPickIndex++;
        
        if (draft.currentPickIndex >= draft.draftOrder.length) {
            io.to(roomCode).emit('draftComplete', calculateResults(draft.players, draft.playersItems));
        } else {
            const nextPick = draft.draftOrder[draft.currentPickIndex];
            draft.currentPlayer = draft.players[nextPick.playerIndex];
            io.to(roomCode).emit('turnChange', {
                playerId: draft.currentPlayer.id,
                playerName: draft.currentPlayer.name,
                timeRemaining: draft.timerSeconds
            });
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('🔴 Client disconnected:', socket.id);
        
        for (const [roomCode, gameRoom] of gameRooms.entries()) {
            const playerIndex = gameRoom.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const wasHost = gameRoom.host === socket.id;
                gameRoom.players.splice(playerIndex, 1);
                
                io.to(roomCode).emit('playerLeft', gameRoom.players);
                
                if (gameRoom.players.length === 0) {
                    gameRooms.delete(roomCode);
                    console.log(`🗑️ Room ${roomCode} deleted (empty)`);
                } else if (wasHost && gameRoom.players.length > 0) {
                    gameRoom.host = gameRoom.players[0].id;
                    io.to(roomCode).emit('hostChanged', gameRoom.host);
                }
                break;
            }
        }
    });
});

// ==================== HELPER FUNCTIONS ====================

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

async function loadGameItems(category) {
    console.log(`loadGameItems called with category: ${category}`);
    
    if (!category) {
        throw new Error('Category is required');
    }
    
    // Sanitize the category name to prevent SQL injection
    const safeCategory = category.replace(/[^a-z_]/gi, '');
    console.log(`Safe category name: ${safeCategory}`);
    
    // First, check if the table exists
    const tableCheck = await pgPool.query(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = $1
        )
    `, [safeCategory]);
    
    if (!tableCheck.rows[0].exists) {
        throw new Error(`Table "${safeCategory}" does not exist`);
    }
    
    // Then fetch items
    const result = await pgPool.query(
        `SELECT item_name, score FROM "${safeCategory}" ORDER BY item_name`
    );
    
    console.log(`Found ${result.rows.length} items in ${safeCategory}`);
    return result.rows;
}

function initializeDraftState(players, config, items) {
    console.log(`Initializing draft state with ${items.length} items for ${players.length} players`);
    console.log(`Config category: ${config.category}`);
    
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
        categoryName: config.categoryName || config.category
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

function calculateResults(players, playersItems) {
    return players.map((player, index) => {
        const totalScore = playersItems[index].reduce((sum, item) => sum + (item.score || 0), 0);
        return {
            playerId: player.id,
            playerName: player.name,
            totalScore: totalScore,
            items: playersItems[index]
        };
    }).sort((a, b) => b.totalScore - a.totalScore);
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`🔌 Socket.IO ready for multiplayer!`);
    console.log(`✅ Ready to accept API requests\n`);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await pgPool.end();
    process.exit(0);
});

module.exports = pgPool;