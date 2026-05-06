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
    transports: ['polling', 'websocket'],
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

// ==================== SIMPLE DRAFT API ROUTES ====================

// Get all simple draft categories
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

// Get items for a simple draft category
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
            `SELECT item_name, CAST(COALESCE(score, 0) AS FLOAT) as score FROM "${safeCategory}" ORDER BY item_name`
        );
        
        console.log(`Found ${result.rows.length} items in ${category}`);
        res.json({ success: true, items: result.rows, category: category });
    } catch (error) {
        console.error('Error fetching items with scores:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== DYNAMIC DRAFT API ROUTES ====================

// Get all dynamic draft categories (templates)
app.get('/api/dynamic-categories', async (req, res) => {
    try {
        const tableCheck = await pgPool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'dynamic_draft_choices'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            console.log('dynamic_draft_choices table does not exist yet');
            return res.json({ success: true, categories: [] });
        }
        
        const result = await pgPool.query(`
            SELECT table_name, number_of_rounds, live
            FROM dynamic_draft_choices 
            WHERE live = 'yes'
            ORDER BY table_name
        `);
        
        const categories = result.rows.map(row => ({
            table_name: row.table_name,
            number_of_rounds: parseInt(row.number_of_rounds) || 0
        }));
        
        console.log(`Found ${categories.length} dynamic templates`);
        res.json({ success: true, categories: categories });
    } catch (error) {
        console.error('Error fetching dynamic categories:', error);
        res.json({ success: true, categories: [] });
    }
});

// Get items for a dynamic draft template
app.get('/api/dynamic-items/:tableName/with-scores', async (req, res) => {
    const { tableName } = req.params;
    
    try {
        console.log(`Fetching items for dynamic template: ${tableName}`);
        
        const templateCheck = await pgPool.query(
            'SELECT table_name FROM dynamic_draft_choices WHERE table_name = $1',
            [tableName]
        );
        
        if (templateCheck.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Template not found' });
        }
        
        const safeTable = tableName.replace(/[^a-z_]/gi, '');
        
        const tableExists = await pgPool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = $1
            )
        `, [safeTable]);
        
        if (!tableExists.rows[0].exists) {
            console.log(`Item table ${safeTable} does not exist yet`);
            return res.json({ success: true, items: [] });
        }
        
        const result = await pgPool.query(
            `SELECT item_name, category, CAST(COALESCE(score, 0) AS FLOAT) as score 
             FROM "${safeTable}" 
             ORDER BY item_name`
        );
        
        console.log(`Found ${result.rows.length} items in ${tableName}`);
        res.json({ success: true, items: result.rows });
    } catch (error) {
        console.error('Error fetching dynamic items:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get draft positions for a template (slot order)
app.get('/api/dynamic-positions/:tableName', async (req, res) => {
    const { tableName } = req.params;
    
    try {
        const result = await pgPool.query(`
            SELECT slot, position 
            FROM dynamic_draft_positions 
            WHERE table_name = $1
            ORDER BY slot ASC
        `, [tableName]);
        
        res.json({ success: true, positions: result.rows });
    } catch (error) {
        console.error('Error fetching draft positions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== HEALTH CHECK ====================

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
            simple: {
                categories: 'GET /api/categories',
                items: 'GET /api/items/:category/with-scores'
            },
            dynamic: {
                categories: 'GET /api/dynamic-categories',
                items: 'GET /api/dynamic-items/:tableName/with-scores',
                positions: 'GET /api/dynamic-positions/:tableName'
            },
            health: 'GET /api/health'
        },
        websocket: 'Socket.IO enabled for multiplayer'
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
    const result = await pgPool.query(
        `SELECT item_name, CAST(COALESCE(score, 0) AS FLOAT) as score FROM "${safeCategory}" ORDER BY item_name`
    );
    
    return result.rows;
}

async function loadDynamicGameItems(tableName) {
    if (!tableName) throw new Error('Table name is required');
    
    const safeTable = tableName.replace(/[^a-z_]/gi, '');
    const result = await pgPool.query(
        `SELECT item_name, category, CAST(COALESCE(score, 0) AS FLOAT) as score FROM "${safeTable}" ORDER BY item_name`
    );
    
    return result.rows;
}

async function loadDraftPositions(tableName) {
    if (!tableName) throw new Error('Table name is required');
    
    const result = await pgPool.query(`
        SELECT slot, position 
        FROM dynamic_draft_positions 
        WHERE table_name = $1
        ORDER BY slot ASC
    `, [tableName]);
    
    return result.rows;
}

function generateRandomPlayerOrder(numPlayers) {
    const order = Array.from({ length: numPlayers }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

function generateSnakeDraftOrder(numPlayers, numRounds) {
    const draftOrder = [];
    let pickNumber = 1;
    
    console.log(`=== GENERATING SNAKE DRAFT ORDER ===`);
    console.log(`Players: ${numPlayers}, Rounds: ${numRounds}`);
    
    for (let round = 1; round <= numRounds; round++) {
        if (round % 2 === 1) {
            // Odd rounds: ascending order (0,1,2,3...)
            console.log(`Round ${round} (ODD): Ascending order`);
            for (let i = 0; i < numPlayers; i++) {
                draftOrder.push({
                    playerIndex: i,
                    round: round,
                    pickNumber: pickNumber++
                });
                console.log(`  Pick ${pickNumber-1}: Player Index ${i}`);
            }
        } else {
            // Even rounds: descending order (numPlayers-1, numPlayers-2, ..., 0)
            console.log(`Round ${round} (EVEN): Descending order`);
            for (let i = numPlayers - 1; i >= 0; i--) {
                draftOrder.push({
                    playerIndex: i,
                    round: round,
                    pickNumber: pickNumber++
                });
                console.log(`  Pick ${pickNumber-1}: Player Index ${i}`);
            }
        }
    }
    
    console.log(`=== TOTAL PICKS: ${draftOrder.length} ===`);
    return draftOrder;
}

function initializeDraftState(players, config, items) {
    const randomPlayerOrder = generateRandomPlayerOrder(players.length);
    
    // Reorder players based on random order for display
    const orderedPlayers = randomPlayerOrder.map(idx => players[idx]);
    const orderedPlayersItems = randomPlayerOrder.map(() => []);
    
    // Generate the draft order based on the type
    let draftOrder = [];
    const numPlayers = players.length;
    const numRounds = config.numRounds;
    
    if (config.draftType === 'snake') {
        draftOrder = generateSnakeDraftOrder(numPlayers, numRounds);
    } else if (config.draftType === 'random') {
        // Random order each round
        let pickNumber = 1;
        for (let round = 1; round <= numRounds; round++) {
            const shuffled = Array.from({ length: numPlayers }, (_, i) => i);
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            for (let i = 0; i < numPlayers; i++) {
                draftOrder.push({
                    playerIndex: shuffled[i],
                    round: round,
                    pickNumber: pickNumber++
                });
            }
        }
    } else {
        // Regular sequential order
        let pickNumber = 1;
        for (let round = 1; round <= numRounds; round++) {
            for (let i = 0; i < numPlayers; i++) {
                draftOrder.push({
                    playerIndex: i,
                    round: round,
                    pickNumber: pickNumber++
                });
            }
        }
    }
    
    // Log the draft order for debugging
    console.log(`=== DRAFT ORDER (${config.draftType}) ===`);
    console.log(`Players in display order: ${orderedPlayers.map(p => p.name).join(', ')}`);
    draftOrder.forEach(pick => {
        console.log(`Pick ${pick.pickNumber}: Round ${pick.round}, Player: ${orderedPlayers[pick.playerIndex]?.name} (Index ${pick.playerIndex})`);
    });
    console.log('================================');
    
    return {
        players: orderedPlayers.map(p => ({ id: p.id, name: p.name })),
        originalPlayers: players.map(p => ({ id: p.id, name: p.name })),
        randomPlayerOrder: randomPlayerOrder,
        availableItems: items.map(i => i.item_name),
        itemsWithScores: items.map(i => ({ item_name: i.item_name, score: parseFloat(i.score) || 0 })),
        playersItems: orderedPlayersItems,
        draftOrder: draftOrder,
        currentPickIndex: 0,
        currentPlayer: orderedPlayers[draftOrder[0].playerIndex],
        numRounds: config.numRounds,
        timerSeconds: config.timerMinutes * 60,
        category: config.category,
        categoryName: config.categoryName || config.category,
        draftType: config.draftType,
        draftMode: 'simple'
    };
}

function initializeDynamicDraftState(players, config, items, positions) {
    const numRounds = positions.length;
    const randomPlayerOrder = generateRandomPlayerOrder(players.length);
    
    // Reorder players based on random order for display
    const orderedPlayers = randomPlayerOrder.map(idx => players[idx]);
    const orderedPlayersItems = randomPlayerOrder.map(() => []);
    
    const itemsArrayWithScores = items.map(item => ({
        item_name: item.item_name,
        score: parseFloat(item.score) || 0,
        category: item.category || null
    }));
    
    // Generate the draft order based on the type
    let draftOrder = [];
    const numPlayers = players.length;
    
    if (config.draftType === 'snake') {
        draftOrder = generateSnakeDraftOrder(numPlayers, numRounds);
    } else if (config.draftType === 'random') {
        let pickNumber = 1;
        for (let round = 1; round <= numRounds; round++) {
            const shuffled = Array.from({ length: numPlayers }, (_, i) => i);
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            for (let i = 0; i < numPlayers; i++) {
                draftOrder.push({
                    playerIndex: shuffled[i],
                    round: round,
                    pickNumber: pickNumber++
                });
            }
        }
    } else {
        let pickNumber = 1;
        for (let round = 1; round <= numRounds; round++) {
            for (let i = 0; i < numPlayers; i++) {
                draftOrder.push({
                    playerIndex: i,
                    round: round,
                    pickNumber: pickNumber++
                });
            }
        }
    }
    
    console.log(`Initialized dynamic draft with ${itemsArrayWithScores.length} items, ${positions.length} rounds`);
    
    // Log the draft order for debugging
    console.log(`=== DYNAMIC DRAFT ORDER (${config.draftType}) ===`);
    console.log(`Players in display order: ${orderedPlayers.map(p => p.name).join(', ')}`);
    draftOrder.forEach(pick => {
        console.log(`Pick ${pick.pickNumber}: Round ${pick.round}, Player: ${orderedPlayers[pick.playerIndex]?.name} (Index ${pick.playerIndex})`);
    });
    console.log('============================================');
    
    return {
        players: orderedPlayers.map(p => ({ id: p.id, name: p.name })),
        originalPlayers: players.map(p => ({ id: p.id, name: p.name })),
        randomPlayerOrder: randomPlayerOrder,
        availableItems: itemsArrayWithScores.map(i => i.item_name),
        itemsWithScores: itemsArrayWithScores,
        playersItems: orderedPlayersItems,
        draftOrder: draftOrder,
        currentPickIndex: 0,
        currentPlayer: orderedPlayers[draftOrder[0].playerIndex],
        numRounds: numRounds,
        timerSeconds: config.timerMinutes * 60,
        categoryName: config.templateDisplayName,
        draftType: config.draftType,
        draftMode: 'dynamic',
        positions: positions
    };
}

function calculateFinalResults(draft) {
    const results = [];
    
    for (let i = 0; i < draft.players.length; i++) {
        let totalScore = 0;
        let bestPick = null;
        let worstPick = null;
        
        for (const item of draft.playersItems[i]) {
            const itemScore = parseFloat(item.score) || 0;
            totalScore += itemScore;
            
            if (!bestPick || itemScore > bestPick.score) {
                bestPick = { name: item.name, score: itemScore };
            }
            if (!worstPick || itemScore < worstPick.score) {
                worstPick = { name: item.name, score: itemScore };
            }
        }
        
        results.push({
            playerIndex: i,
            playerName: draft.players[i].name,
            totalScore: totalScore,
            bestPick: bestPick,
            worstPick: worstPick,
            items: draft.playersItems[i]
        });
    }
    
    results.sort((a, b) => b.totalScore - a.totalScore);
    
    let currentPlace = 1;
    let previousScore = null;
    results.forEach((player, index) => {
        if (previousScore !== null && player.totalScore < previousScore) {
            currentPlace = index + 1;
        }
        player.place = currentPlace;
        previousScore = player.totalScore;
    });
    
    return results;
}

// ==================== SOCKET.IO MULTIPLAYER ====================

io.on('connection', (socket) => {
    console.log('🟢 New client connected:', socket.id);

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
        
        console.log(`🎮 Game created: ${roomCode}`);
        
        if (callback) callback({ success: true, roomCode: roomCode });
        io.to(roomCode).emit('playerJoined', gameRoom.players);
        io.to(roomCode).emit('hostReady', true);
    });

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
        
        console.log(`👤 Player ${newPlayer.name} joined room ${roomCode}`);
        
        if (callback) callback({ success: true, roomCode: roomCode });
        io.to(roomCode).emit('playerJoined', gameRoom.players);
        io.to(roomCode).emit('playerCount', gameRoom.players.length);
    });

    socket.on('checkGameMode', (data, callback) => {
        const { roomCode } = data;
        console.log(`🔍 Checking game mode for room: ${roomCode}`);
        
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) {
            if (callback) callback({ success: false, error: 'Room not found' });
            return;
        }
        
        const draftMode = gameRoom.config.draftMode || 'simple';
        console.log(`📋 Room ${roomCode} has draft mode: ${draftMode}`);
        
        if (callback) callback({ success: true, draftMode: draftMode });
    });

    socket.on('playerReady', (roomCode) => {
        const gameRoom = gameRooms.get(roomCode);
        if (gameRoom) {
            const player = gameRoom.players.find(p => p.id === socket.id);
            if (player) {
                player.isReady = true;
                console.log(`✅ Player ${player.name} is ready`);
                io.to(roomCode).emit('playerReadyUpdate', gameRoom.players);
                
                const allReady = gameRoom.players.every(p => p.isReady === true);
                const fullPlayers = gameRoom.players.length === gameRoom.config.numPlayers;
                
                if (allReady && fullPlayers) {
                    console.log(`🎉 All players ready!`);
                    io.to(roomCode).emit('allPlayersReady');
                }
            }
        }
    });

    socket.on('syncPlayerId', (data) => {
        const { roomCode, oldSocketId, newSocketId } = data;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) return;
        
        for (let i = 0; i < gameRoom.players.length; i++) {
            if (gameRoom.players[i].id === oldSocketId) {
                gameRoom.players[i].id = newSocketId;
                if (gameRoom.host === oldSocketId) gameRoom.host = newSocketId;
                break;
            }
        }
    });

    socket.on('broadcastGameData', (data) => {
        const { roomCode, gameData } = data;
        console.log(`📡 Broadcasting game data to room ${roomCode}`);
        socket.to(roomCode).emit('gameData', gameData);
    });

    socket.on('requestGameData', (roomCode) => {
        console.log(`📡 Joiner requested game data for room ${roomCode}`);
    });

    socket.on('startDraft', async (roomCode) => {
        console.log(`🎯 START DRAFT requested for room: ${roomCode}`);
        
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
        if (!allReady || gameRoom.players.length !== gameRoom.config.numPlayers) {
            socket.emit('startDraftError', 'Not all players are ready');
            return;
        }
        
        const draftMode = gameRoom.config.draftMode || 'simple';
        
        try {
            let draftState;
            
            if (draftMode === 'simple') {
                const category = gameRoom.config.category;
                if (!category) {
                    socket.emit('startDraftError', 'No category selected');
                    return;
                }
                const items = await loadGameItems(category);
                if (!items || items.length === 0) {
                    socket.emit('startDraftError', `No items found for category "${category}"`);
                    return;
                }
                draftState = initializeDraftState(gameRoom.players, gameRoom.config, items);
            } else {
                const tableName = gameRoom.config.templateName;
                if (!tableName) {
                    socket.emit('startDraftError', 'No template selected');
                    return;
                }
                
                const items = await loadDynamicGameItems(tableName);
                if (!items || items.length === 0) {
                    socket.emit('startDraftError', `No items found for template "${tableName}"`);
                    return;
                }
                
                const positions = await loadDraftPositions(tableName);
                if (!positions || positions.length === 0) {
                    socket.emit('startDraftError', `No draft positions found for template "${tableName}"`);
                    return;
                }
                
                draftState = initializeDynamicDraftState(gameRoom.players, gameRoom.config, items, positions);
            }
            
            gameRoom.gameState = 'drafting';
            gameRoom.draftState = draftState;
            
            io.to(roomCode).emit('draftStarted', draftState);
            
            const firstPlayer = draftState.currentPlayer;
            io.to(roomCode).emit('turnChange', {
                playerId: firstPlayer.id,
                playerName: firstPlayer.name,
                timeRemaining: draftState.timerSeconds
            });
            
            console.log(`✅ Draft started for room ${roomCode}`);
            
        } catch (error) {
            console.error('Error:', error);
            socket.emit('startDraftError', `Failed to load draft items: ${error.message}`);
        }
    });

    socket.on('joinGameRoom', (roomCode) => {
        const gameRoom = gameRooms.get(roomCode);
        
        if (gameRoom) {
            socket.join(roomCode);
            
            if (gameRoom.draftState && gameRoom.gameState === 'drafting') {
                socket.emit('draftStarted', gameRoom.draftState);
                
                const currentPlayer = gameRoom.draftState.currentPlayer;
                if (currentPlayer) {
                    socket.emit('turnChange', {
                        playerId: currentPlayer.id,
                        playerName: currentPlayer.name,
                        timeRemaining: gameRoom.draftState.timerSeconds
                    });
                }
            } else {
                socket.emit('playerJoined', gameRoom.players);
            }
        }
    });

    socket.on('makePick', async (data) => {
        const { roomCode, itemName } = data;
        console.log(`📦 Pick: ${itemName} from ${socket.id}`);
        
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
            socket.emit('pickError', 'Not your turn');
            return;
        }
        
        const itemIndex = draft.availableItems.findIndex(
            i => i.toLowerCase() === itemName.toLowerCase()
        );
        
        if (itemIndex === -1) {
            console.log(`Item "${itemName}" not found. Available items:`, draft.availableItems);
            socket.emit('pickError', 'Item not available');
            return;
        }
        
        const actualItemName = draft.availableItems[itemIndex];
        
        let baseScore = 0;
        if (Array.isArray(draft.itemsWithScores)) {
            const scoreItem = draft.itemsWithScores.find(i => i.item_name === actualItemName);
            baseScore = scoreItem ? parseFloat(scoreItem.score) : 0;
        } else if (draft.itemsWithScores && typeof draft.itemsWithScores === 'object') {
            baseScore = draft.itemsWithScores[actualItemName] || 0;
        }
        
        draft.availableItems.splice(itemIndex, 1);
        draft.playersItems[currentPick.playerIndex].push({
            name: actualItemName,
            score: baseScore,
            baseScore: baseScore
        });
        
        io.to(roomCode).emit('pickMade', {
            playerId: socket.id,
            playerName: currentPlayer.name,
            item: actualItemName,
            score: baseScore
        });
        
        draft.currentPickIndex++;
        
        if (draft.currentPickIndex >= draft.draftOrder.length) {
            const results = calculateFinalResults(draft);
            io.to(roomCode).emit('draftComplete', results);
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

    socket.on('disconnect', () => {
        console.log('🔴 Client disconnected:', socket.id);
        
        for (const [roomCode, gameRoom] of gameRooms.entries()) {
            const playerIndex = gameRoom.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                gameRoom.players.splice(playerIndex, 1);
                io.to(roomCode).emit('playerLeft', gameRoom.players);
                
                if (gameRoom.players.length === 0) {
                    gameRooms.delete(roomCode);
                    console.log(`🗑️ Room ${roomCode} deleted`);
                }
                break;
            }
        }
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`✅ Ready to accept requests\n`);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await pgPool.end();
    process.exit(0);
});

module.exports = pgPool;