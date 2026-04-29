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
const draftChemistryData = new Map(); // Store chemistry for each draft session

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
            `SELECT item_name, CAST(COALESCE(score, 0) AS FLOAT) as score FROM "${safeCategory}" ORDER BY item_name`
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

// ==================== DYNAMIC DRAFT API ENDPOINTS ====================

// Get all dynamic draft templates
app.get('/api/dynamic-templates', async (req, res) => {
    try {
        const templates = await pgPool.query(`
            SELECT ddc.*, 
                   COALESCE(
                       (SELECT json_agg(json_build_object('slot_name', dds.slot_name, 'slot_order', dds.slot_order, 'description', dds.description) ORDER BY dds.slot_order)
                        FROM dynamic_draft_slots dds WHERE dds.template_id = ddc.id
                   ), '[]'::json) as slots
            FROM dynamic_draft_choices ddc
            WHERE ddc.is_active = true
            ORDER BY ddc.id
        `);
        res.json({ success: true, templates: templates.rows });
    } catch (error) {
        console.error('Error fetching dynamic templates:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get slots for a specific template
app.get('/api/dynamic-template/:templateName/slots', async (req, res) => {
    const { templateName } = req.params;
    try {
        const result = await pgPool.query(`
            SELECT dds.slot_name, dds.slot_order, dds.description
            FROM dynamic_draft_slots dds
            JOIN dynamic_draft_choices ddc ON ddc.id = dds.template_id
            WHERE ddc.template_name = $1
            ORDER BY dds.slot_order
        `, [templateName]);
        res.json({ success: true, slots: result.rows });
    } catch (error) {
        console.error('Error fetching template slots:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get items for a specific template and category
app.get('/api/dynamic-items/:templateName/:category', async (req, res) => {
    const { templateName, category } = req.params;
    try {
        // Get the table name from the template
        const templateResult = await pgPool.query(
            'SELECT table_name FROM dynamic_draft_choices WHERE template_name = $1',
            [templateName]
        );
        
        if (templateResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Template not found' });
        }
        
        const tableName = templateResult.rows[0].table_name;
        
        // Query items from the specific table
        const items = await pgPool.query(
            `SELECT item_name, score FROM "${tableName}" WHERE category = $1 ORDER BY item_name`,
            [category]
        );
        
        res.json({ success: true, items: items.rows, category: category });
    } catch (error) {
        console.error('Error fetching dynamic items:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all items for a template (by category)
app.get('/api/dynamic-all-items/:templateName', async (req, res) => {
    const { templateName } = req.params;
    try {
        const templateResult = await pgPool.query(
            'SELECT table_name FROM dynamic_draft_choices WHERE template_name = $1',
            [templateName]
        );
        
        if (templateResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Template not found' });
        }
        
        const tableName = templateResult.rows[0].table_name;
        
        const items = await pgPool.query(
            `SELECT item_name, category, score FROM "${tableName}" ORDER BY category, item_name`
        );
        
        // Group by category
        const groupedItems = {};
        items.rows.forEach(item => {
            if (!groupedItems[item.category]) {
                groupedItems[item.category] = [];
            }
            groupedItems[item.category].push({
                item_name: item.item_name,
                score: item.score
            });
        });
        
        res.json({ success: true, items: groupedItems });
    } catch (error) {
        console.error('Error fetching all dynamic items:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== CHEMISTRY FUNCTIONS ====================

async function checkChemistry(category, items, newItem) {
    const tableName = category;
    console.log(`Checking chemistry for ${newItem} in ${tableName}`);
    
    const chemistryResults = {
        synergies: [],
        conflicts: [],
        totalEffect: 0
    };
    
    for (const existingItem of items) {
        const result = await pgPool.query(`
            SELECT effect_type, points, combo_name 
            FROM item_synergies 
            WHERE table_name = $1 
            AND ((item1_name = $2 AND item2_name = $3) OR (item1_name = $3 AND item2_name = $2))
        `, [tableName, existingItem.name, newItem]);
        
        if (result.rows.length > 0) {
            const chem = result.rows[0];
            if (chem.effect_type === 'synergy') {
                chemistryResults.synergies.push({
                    with: existingItem.name,
                    points: chem.points,
                    comboName: chem.combo_name
                });
                chemistryResults.totalEffect += chem.points;
            } else if (chem.effect_type === 'conflict') {
                chemistryResults.conflicts.push({
                    with: existingItem.name,
                    points: chem.points,
                    comboName: chem.combo_name
                });
                chemistryResults.totalEffect += chem.points;
            }
        }
    }
    
    return chemistryResults;
}

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
        
        console.log(`👤 Player ${newPlayer.name} joined room ${roomCode}`);
        
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

    // Sync player ID when reconnecting (for draft page)
    socket.on('syncPlayerId', (data) => {
        const { roomCode, oldSocketId, newSocketId } = data;
        console.log(`🔄 Sync request: old=${oldSocketId}, new=${newSocketId}`);
        
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) {
            console.log(`❌ Room ${roomCode} not found`);
            return;
        }
        
        for (let i = 0; i < gameRoom.players.length; i++) {
            if (gameRoom.players[i].id === oldSocketId) {
                console.log(`🔄 Updating ${gameRoom.players[i].name} ID from ${oldSocketId} to ${newSocketId}`);
                gameRoom.players[i].id = newSocketId;
                
                if (gameRoom.host === oldSocketId) {
                    gameRoom.host = newSocketId;
                }
                break;
            }
        }
        
        if (gameRoom.draftState && gameRoom.gameState === 'drafting') {
            for (let i = 0; i < gameRoom.draftState.players.length; i++) {
                if (gameRoom.draftState.players[i].id === oldSocketId) {
                    gameRoom.draftState.players[i].id = newSocketId;
                }
            }
            if (gameRoom.draftState.currentPlayer && gameRoom.draftState.currentPlayer.id === oldSocketId) {
                gameRoom.draftState.currentPlayer.id = newSocketId;
            }
        }
    });

    // Start the draft
    socket.on('startDraft', async (roomCode) => {
        console.log(`🎯 START DRAFT requested for room: ${roomCode} by ${socket.id}`);
        
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
        
        const category = gameRoom.config.category;
        
        if (!category) {
            socket.emit('startDraftError', 'No category selected');
            return;
        }
        
        try {
            const items = await loadGameItems(category);
            
            if (!items || items.length === 0) {
                socket.emit('startDraftError', `No items found for category "${category}"`);
                return;
            }
            
            const draftState = initializeDraftState(gameRoom.players, gameRoom.config, items);
            gameRoom.gameState = 'drafting';
            gameRoom.draftState = draftState;
            
            console.log(`📢 Broadcasting draftStarted to room: ${roomCode}`);
            io.to(roomCode).emit('draftStarted', draftState);
            
            const firstPlayer = draftState.currentPlayer;
            console.log(`📢 First player: ${firstPlayer.name}`);
            console.log(`📢 Broadcasting turnChange to room: ${roomCode}`);
            
            io.to(roomCode).emit('turnChange', {
                playerId: firstPlayer.id,
                playerName: firstPlayer.name,
                timeRemaining: draftState.timerSeconds
            });
            
            console.log(`✅ Draft started successfully`);
            
        } catch (error) {
            console.error('Error:', error);
            socket.emit('startDraftError', `Failed to load draft items: ${error.message}`);
        }
    });

    // Re-join room (for draft page)
    socket.on('joinGameRoom', (roomCode) => {
        console.log(`🔄 Player ${socket.id} rejoining room ${roomCode}`);
        const gameRoom = gameRooms.get(roomCode);
        
        if (gameRoom) {
            const hostPlayer = gameRoom.players.find(p => p.name === 'Host');
            
            if (hostPlayer && hostPlayer.id !== socket.id) {
                console.log(`👑 Updating host ID from ${hostPlayer.id} to ${socket.id}`);
                hostPlayer.id = socket.id;
                gameRoom.host = socket.id;
                
                if (gameRoom.draftState) {
                    for (let i = 0; i < gameRoom.draftState.players.length; i++) {
                        if (gameRoom.draftState.players[i].name === 'Host') {
                            gameRoom.draftState.players[i].id = socket.id;
                        }
                    }
                    if (gameRoom.draftState.currentPlayer && gameRoom.draftState.currentPlayer.name === 'Host') {
                        gameRoom.draftState.currentPlayer.id = socket.id;
                    }
                }
            }
            
            socket.join(roomCode);
            console.log(`✅ Player joined room ${roomCode}`);
            
            if (gameRoom.draftState && gameRoom.gameState === 'drafting') {
                console.log(`📢 Sending draft state to rejoining player`);
                socket.emit('draftStarted', gameRoom.draftState);
                
                const currentPlayer = gameRoom.draftState.currentPlayer;
                if (currentPlayer) {
                    console.log(`📢 Sending turn info: ${currentPlayer.name} (${currentPlayer.id})`);
                    socket.emit('turnChange', {
                        playerId: currentPlayer.id,
                        playerName: currentPlayer.name,
                        timeRemaining: gameRoom.draftState.timerSeconds
                    });
                }
            } else {
                console.log(`📢 Sending player list (draft not started yet)`);
                socket.emit('playerJoined', gameRoom.players);
            }
        } else {
            console.log(`❌ Room ${roomCode} not found`);
            socket.emit('error', 'Game room not found');
        }
    });

    // Make a pick during draft with proper numeric score calculation
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
        
        const itemIndex = draft.availableItems.indexOf(itemName);
        if (itemIndex === -1) {
            socket.emit('pickError', 'Item not available');
            return;
        }
        
        // Get base score as number
        const scoreItem = draft.itemsWithScores.find(i => i.item_name === itemName);
        let baseScore = scoreItem ? parseFloat(scoreItem.score) : 0;
        
        // Check chemistry with existing items
        const playerExistingItems = draft.playersItems[currentPick.playerIndex];
        const chemistryResults = await checkChemistry(draft.category, playerExistingItems, itemName);
        
        // Calculate total score with chemistry (numeric addition)
        const chemistryBonus = chemistryResults.totalEffect;
        const totalScore = baseScore + chemistryBonus;
        
        console.log(`Item: ${itemName}, Base Score: ${baseScore}, Chemistry Bonus: ${chemistryBonus}, Total: ${totalScore}`);
        
        // Store chemistry data for results page
        const draftSessionId = roomCode;
        if (!draftChemistryData.has(draftSessionId)) {
            draftChemistryData.set(draftSessionId, new Map());
        }
        const sessionChemistry = draftChemistryData.get(draftSessionId);
        if (!sessionChemistry.has(currentPick.playerIndex)) {
            sessionChemistry.set(currentPick.playerIndex, []);
        }
        const playerChemistry = sessionChemistry.get(currentPick.playerIndex);
        
        for (const synergy of chemistryResults.synergies) {
            playerChemistry.push({
                type: 'synergy',
                text: `${synergy.comboName || 'Bonus'} - ${itemName} & ${synergy.with}`,
                points: synergy.points
            });
        }
        for (const conflict of chemistryResults.conflicts) {
            playerChemistry.push({
                type: 'conflict',
                text: `${conflict.comboName || 'Penalty'} - ${itemName} & ${conflict.with}`,
                points: conflict.points
            });
        }
        sessionChemistry.set(currentPick.playerIndex, playerChemistry);
        
        // Remove item and add to player's picks with numeric scores
        draft.availableItems.splice(itemIndex, 1);
        draft.playersItems[currentPick.playerIndex].push({
            name: itemName,
            score: totalScore,
            baseScore: baseScore,
            chemistryBonus: chemistryBonus,
            chemistryDetails: chemistryResults
        });
        
        // Broadcast pick to all players
        io.to(roomCode).emit('pickMade', {
            playerId: socket.id,
            playerName: currentPlayer.name,
            item: itemName,
            score: totalScore
        });
        
        draft.currentPickIndex++;
        
        if (draft.currentPickIndex >= draft.draftOrder.length) {
            // Calculate final results with proper numeric scores
            const results = calculateFinalResultsWithChemistry(draft, draftSessionId, sessionChemistry);
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

    // Test connection event
    socket.on('testConnection', (data) => {
        console.log('📡 Test connection from client:', data);
        socket.emit('testResponse', { received: true, timestamp: Date.now() });
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
                
                io.to(roomCode).emit('playerLeft', gameRoom.players);
                
                if (gameRoom.players.length === 0) {
                    gameRooms.delete(roomCode);
                    draftChemistryData.delete(roomCode);
                    console.log(`🗑️ Room ${roomCode} deleted`);
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
    if (!category) throw new Error('Category is required');
    
    const safeCategory = category.replace(/[^a-z_]/gi, '');
    const result = await pgPool.query(
        `SELECT item_name, CAST(COALESCE(score, 0) AS FLOAT) as score FROM "${safeCategory}" ORDER BY item_name`
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

function calculateFinalResultsWithChemistry(draft, draftSessionId, chemistryData) {
    console.log('Calculating final results with chemistry data:', chemistryData);
    
    const results = [];
    
    for (let i = 0; i < draft.players.length; i++) {
        let totalScore = 0;
        let bestPick = null;
        let worstPick = null;
        let playerChemistryMoves = [];
        
        // Get chemistry moves for this player
        if (chemistryData && chemistryData.has(i)) {
            playerChemistryMoves = chemistryData.get(i);
            console.log(`Player ${draft.players[i].name} chemistry moves:`, playerChemistryMoves);
        }
        
        // Calculate total score by adding numbers (not concatenating)
        for (const item of draft.playersItems[i]) {
            let itemScore = parseFloat(item.score) || 0;
            totalScore += itemScore;
            
            console.log(`Item: ${item.name}, Score: ${itemScore}, Running Total: ${totalScore}`);
            
            // Find best and worst picks by base score
            const baseScore = parseFloat(item.baseScore) || 0;
            if (!bestPick || baseScore > bestPick.score) {
                bestPick = { name: item.name, score: baseScore };
            }
            if (!worstPick || baseScore < worstPick.score) {
                worstPick = { name: item.name, score: baseScore };
            }
        }
        
        // Add chemistry points to total score
        let chemistryTotal = 0;
        for (const move of playerChemistryMoves) {
            chemistryTotal += move.points || 0;
        }
        totalScore += chemistryTotal;
        
        console.log(`Player ${draft.players[i].name} - Items Total: ${totalScore - chemistryTotal}, Chemistry: ${chemistryTotal}, Final: ${totalScore}`);
        
        results.push({
            playerIndex: i,
            playerName: draft.players[i].name,
            totalScore: totalScore,
            bestPick: bestPick,
            worstPick: worstPick,
            chemistryMoves: playerChemistryMoves,
            items: draft.playersItems[i]
        });
    }
    
    // Sort by total score (highest first)
    results.sort((a, b) => b.totalScore - a.totalScore);
    
    // Add place
    let currentPlace = 1;
    let previousScore = null;
    results.forEach((player, index) => {
        if (previousScore !== null && player.totalScore < previousScore) {
            currentPlace = index + 1;
        }
        player.place = currentPlace;
        previousScore = player.totalScore;
    });
    
    console.log('Final results sorted by score:', results.map(r => ({ name: r.playerName, score: r.totalScore, place: r.place })));
    
    return results;
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