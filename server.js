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
        console.log(`Current rooms: ${Array.from(gameRooms.keys()).join(', ')}`);
        
        if (callback) callback({ success: true, roomCode: roomCode });
        io.to(roomCode).emit('playerJoined', gameRoom.players);
        io.to(roomCode).emit('hostReady', true);
    });

    // Join an existing game
    socket.on('joinGame', (data, callback) => {
        const { roomCode, playerName } = data;
        const gameRoom = gameRooms.get(roomCode);
        
        console.log(`Join request for room: ${roomCode}, player: ${playerName}`);
        console.log(`Game room exists?`, !!gameRoom);
        
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
        
        console.log(`👤 Player ${socket.id} (${newPlayer.name}) joined room ${roomCode}`);
        console.log(`Players in room: ${gameRoom.players.map(p => p.name).join(', ')}`);
        
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
                console.log(`✅ Player ${player.name} is ready in room ${roomCode}`);
                io.to(roomCode).emit('playerReadyUpdate', gameRoom.players);
                
                const allReady = gameRoom.players.every(p => p.isReady === true);
                const fullPlayers = gameRoom.players.length === gameRoom.config.numPlayers;
                
                console.log(`All ready? ${allReady}, Full players? ${fullPlayers}`);
                
                if (allReady && fullPlayers) {
                    console.log(`🎉 All players ready in room ${roomCode}`);
                    io.to(roomCode).emit('allPlayersReady');
                }
            }
        }
    });

    // Start the draft
    socket.on('startDraft', async (roomCode) => {
        console.log(`🎯 START DRAFT requested for room: ${roomCode} by ${socket.id}`);
        
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) {
            console.log(`❌ Game room not found: ${roomCode}`);
            socket.emit('startDraftError', 'Game room not found');
            return;
        }
        
        console.log(`Game room found. Host is: ${gameRoom.host}, requesting: ${socket.id}`);
        
        if (gameRoom.host !== socket.id) {
            console.log(`❌ Only host can start. Host: ${gameRoom.host}, Requestor: ${socket.id}`);
            socket.emit('startDraftError', 'Only the host can start the draft');
            return;
        }
        
        const allReady = gameRoom.players.every(p => p.isReady === true);
        const correctCount = gameRoom.players.length === gameRoom.config.numPlayers;
        
        console.log(`All ready: ${allReady}, Correct player count: ${correctCount}`);
        
        if (!allReady || !correctCount) {
            socket.emit('startDraftError', 'Not all players are ready');
            return;
        }
        
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
                socket.emit('startDraftError', `No items found for category "${category}"`);
                return;
            }
            
            console.log(`Loaded ${items.length} items from ${category}`);
            
            const draftState = initializeDraftState(gameRoom.players, gameRoom.config, items);
            gameRoom.gameState = 'drafting';
            gameRoom.draftState = draftState;
            
            console.log(`📢 Broadcasting draftStarted to room: ${roomCode}`);
            io.to(roomCode).emit('draftStarted', draftState);
            
            // Send turn change immediately after draft started
            const firstPlayer = draftState.currentPlayer;
            console.log(`📢 First player: ${firstPlayer.name} (${firstPlayer.id})`);
            console.log(`📢 Broadcasting turnChange to room: ${roomCode}`);
            
            io.to(roomCode).emit('turnChange', {
                playerId: firstPlayer.id,
                playerName: firstPlayer.name,
                timeRemaining: draftState.timerSeconds
            });
            
            console.log(`✅ Draft started successfully for room ${roomCode}`);
            
        } catch (error) {
            console.error('Error loading items for draft:', error);
            socket.emit('startDraftError', `Failed to load draft items: ${error.message}`);
        }
    });

   // Re-join room (for draft page)
socket.on('joinGameRoom', (roomCode) => {
    console.log(`🔄 Player ${socket.id} rejoining room ${roomCode}`);
    const gameRoom = gameRooms.get(roomCode);
    
    if (gameRoom) {
        // Check if this socket is already in the players list
        const existingPlayerIndex = gameRoom.players.findIndex(p => p.id === socket.id);
        const wasHost = gameRoom.host === socket.id;
        
        if (existingPlayerIndex === -1) {
            // This is a new socket connection for an existing player
            // Find the player by name or by old ID stored in localStorage?
            console.log(`⚠️ Player ${socket.id} not found in players list, but rejoining room ${roomCode}`);
            
            // For host, update the host ID
            if (wasHost) {
                console.log(`👑 Updating host ID from ${gameRoom.host} to ${socket.id}`);
                gameRoom.host = socket.id;
                
                // Also update the player in the list
                const hostPlayerIndex = gameRoom.players.findIndex(p => p.name === 'Host');
                if (hostPlayerIndex !== -1) {
                    gameRoom.players[hostPlayerIndex].id = socket.id;
                    console.log(`✅ Updated host player ID to ${socket.id}`);
                }
            }
        }
        
        socket.join(roomCode);
        console.log(`✅ Player ${socket.id} (${socket.id === gameRoom.host ? 'HOST' : 'player'}) joined room ${roomCode}`);
        
        if (gameRoom.draftState && gameRoom.gameState === 'drafting') {
            console.log(`📢 Sending draft state to rejoining player`);
            socket.emit('draftStarted', gameRoom.draftState);
            
            const currentPlayer = gameRoom.draftState.currentPlayer;
            if (currentPlayer) {
                console.log(`📢 Sending turn info to rejoining player: ${currentPlayer.name} (${currentPlayer.id})`);
                socket.emit('turnChange', {
                    playerId: currentPlayer.id,
                    playerName: currentPlayer.name,
                    timeRemaining: gameRoom.draftState.timerSeconds
                });
            }
        } else {
            console.log(`📢 Sending player list to rejoining player`);
            socket.emit('playerJoined', gameRoom.players);
        }
    } else {
        console.log(`❌ Room ${roomCode} not found for rejoining player`);
        socket.emit('error', 'Game room not found');
    }
});

// Sync player ID when reconnecting
socket.on('syncPlayerId', (data) => {
    const { roomCode, newSocketId } = data;
    const gameRoom = gameRooms.get(roomCode);
    
    if (gameRoom) {
        const playerIndex = gameRoom.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            console.log(`🔄 Syncing player ID for ${gameRoom.players[playerIndex].name}`);
            gameRoom.players[playerIndex].id = newSocketId;
            
            if (gameRoom.host === socket.id) {
                gameRoom.host = newSocketId;
            }
            
            if (gameRoom.draftState) {
                // Update draft state player IDs
                const draftPlayerIndex = gameRoom.draftState.players.findIndex(p => p.id === socket.id);
                if (draftPlayerIndex !== -1) {
                    gameRoom.draftState.players[draftPlayerIndex].id = newSocketId;
                }
                
                if (gameRoom.draftState.currentPlayer && gameRoom.draftState.currentPlayer.id === socket.id) {
                    gameRoom.draftState.currentPlayer.id = newSocketId;
                }
            }
        }
    }
});

    // Make a pick during draft
    socket.on('makePick', (data) => {
        const { roomCode, itemName } = data;
        console.log(`📦 Pick received: ${itemName} in room ${roomCode} from ${socket.id}`);
        
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom || gameRoom.gameState !== 'drafting') {
            socket.emit('pickError', 'Game not in drafting state');
            return;
        }
        
        const draft = gameRoom.draftState;
        const currentPick = draft.draftOrder[draft.currentPickIndex];
        
        if (!currentPick) {
            socket.emit('pickError', 'No current pick');
            return;
        }
        
        const currentPlayer = draft.players[currentPick.playerIndex];
        
        if (currentPlayer.id !== socket.id) {
            console.log(`Not your turn! Current: ${currentPlayer.name}, Your: ${socket.id}`);
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
            playerName: currentPlayer.name,
            item: itemName
        });
        
        draft.currentPickIndex++;
        
        if (draft.currentPickIndex >= draft.draftOrder.length) {
            console.log(`🏁 Draft complete for room ${roomCode}`);
            const results = calculateResults(draft.players, draft.playersItems);
            io.to(roomCode).emit('draftComplete', results);
        } else {
            const nextPick = draft.draftOrder[draft.currentPickIndex];
            draft.currentPlayer = draft.players[nextPick.playerIndex];
            
            console.log(`➡️ Next turn: ${draft.currentPlayer.name} (${draft.currentPlayer.id})`);
            
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
                const disconnectedPlayer = gameRoom.players[playerIndex];
                const wasHost = gameRoom.host === socket.id;
                gameRoom.players.splice(playerIndex, 1);
                
                console.log(`👋 ${disconnectedPlayer.name} left room ${roomCode}`);
                io.to(roomCode).emit('playerLeft', gameRoom.players);
                
                if (gameRoom.players.length === 0) {
                    gameRooms.delete(roomCode);
                    console.log(`🗑️ Room ${roomCode} deleted`);
                } else if (wasHost && gameRoom.players.length > 0) {
                    gameRoom.host = gameRoom.players[0].id;
                    console.log(`👑 New host: ${gameRoom.players[0].name}`);
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
    if (!category) throw new Error('Category is required');
    
    const safeCategory = category.replace(/[^a-z_]/gi, '');
    console.log(`Loading items from table: ${safeCategory}`);
    
    const tableCheck = await pgPool.query(`
        SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)
    `, [safeCategory]);
    
    if (!tableCheck.rows[0].exists) {
        throw new Error(`Table "${safeCategory}" does not exist`);
    }
    
    const result = await pgPool.query(
        `SELECT item_name, score FROM "${safeCategory}" ORDER BY item_name`
    );
    
    return result.rows;
}

function initializeDraftState(players, config, items) {
    console.log(`Initializing draft state for ${players.length} players, ${items.length} items`);
    
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
        categoryName: config.categoryName || config.category,
        draftType: config.draftType
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
    return players.map((player, index) => ({
        playerId: player.id,
        playerName: player.name,
        totalScore: playersItems[index].reduce((sum, item) => sum + (item.score || 0), 0),
        items: playersItems[index]
    })).sort((a, b) => b.totalScore - a.totalScore);
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