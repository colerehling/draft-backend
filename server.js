const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow all origins for now
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

const pgPool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: {
        require: true,
        rejectUnauthorized: false
    }
});

app.use(cors());
app.use(express.json());

// Store active game rooms
const gameRooms = new Map();

// Socket.IO connection handling
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
                isReady: false
            }],
            config: gameConfig,
            gameState: 'waiting',
            draftState: null,
            createdAt: Date.now()
        };
        
        gameRooms.set(roomCode, gameRoom);
        socket.join(roomCode);
        
        callback({ success: true, roomCode: roomCode });
        io.to(roomCode).emit('playerJoined', gameRoom.players);
    });

    // Join an existing game
    socket.on('joinGame', (data, callback) => {
        const { roomCode, playerName } = data;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) {
            callback({ success: false, error: 'Room not found' });
            return;
        }
        
        if (gameRoom.players.length >= gameRoom.config.numPlayers) {
            callback({ success: false, error: 'Room is full' });
            return;
        }
        
        const newPlayer = {
            id: socket.id,
            name: playerName || `Player ${gameRoom.players.length + 1}`,
            isReady: false
        };
        
        gameRoom.players.push(newPlayer);
        socket.join(roomCode);
        
        callback({ success: true, roomCode: roomCode });
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
                
                // Check if all players are ready
                const allReady = gameRoom.players.every(p => p.isReady);
                if (allReady && gameRoom.players.length === gameRoom.config.numPlayers) {
                    io.to(roomCode).emit('allPlayersReady');
                }
            }
        }
    });

    // Start draft
    socket.on('startDraft', async (roomCode) => {
        const gameRoom = gameRooms.get(roomCode);
        if (gameRoom && gameRoom.host === socket.id) {
            // Load items from database
            const items = await loadGameItems(gameRoom.config.category);
            
            gameRoom.gameState = 'drafting';
            gameRoom.draftState = initializeDraftState(gameRoom.players, gameRoom.config, items);
            
            io.to(roomCode).emit('draftStarted', gameRoom.draftState);
            
            // Notify current player it's their turn
            const currentPlayer = gameRoom.draftState.currentPlayer;
            io.to(roomCode).emit('turnChange', {
                playerId: currentPlayer.id,
                playerName: currentPlayer.name,
                timeRemaining: gameRoom.config.timerMinutes * 60
            });
        }
    });

    // Make a pick
    socket.on('makePick', (data) => {
        const { roomCode, itemName } = data;
        const gameRoom = gameRooms.get(roomCode);
        
        if (gameRoom && gameRoom.gameState === 'drafting') {
            const result = processPick(gameRoom.draftState, socket.id, itemName);
            
            if (result.success) {
                io.to(roomCode).emit('pickMade', {
                    playerId: socket.id,
                    item: itemName,
                    remainingItems: gameRoom.draftState.availableItems
                });
                
                if (result.isComplete) {
                    io.to(roomCode).emit('draftComplete', gameRoom.draftState.results);
                } else {
                    // Next player's turn
                    io.to(roomCode).emit('turnChange', {
                        playerId: gameRoom.draftState.currentPlayer.id,
                        playerName: gameRoom.draftState.currentPlayer.name,
                        timeRemaining: gameRoom.config.timerMinutes * 60
                    });
                }
            } else {
                socket.emit('pickError', result.error);
            }
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        // Remove player from any game rooms
        for (const [roomCode, gameRoom] of gameRooms.entries()) {
            const playerIndex = gameRoom.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                gameRoom.players.splice(playerIndex, 1);
                io.to(roomCode).emit('playerLeft', gameRoom.players);
                
                // If room is empty, delete it
                if (gameRoom.players.length === 0) {
                    gameRooms.delete(roomCode);
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
        players: players,
        availableItems: items.map(i => i.item_name),
        itemsWithScores: items,
        playersItems: players.map(() => []),
        draftOrder: draftOrder,
        currentPickIndex: 0,
        currentPlayer: players[draftOrder[0].playerIndex],
        numRounds: config.numRounds,
        timerSeconds: config.timerMinutes * 60
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

function processPick(draftState, playerId, itemName) {
    const currentPlayer = draftState.currentPlayer;
    
    if (currentPlayer.id !== playerId) {
        return { success: false, error: "Not your turn!" };
    }
    
    const itemIndex = draftState.availableItems.indexOf(itemName);
    if (itemIndex === -1) {
        return { success: false, error: "Item not available!" };
    }
    
    const playerIndex = draftState.players.findIndex(p => p.id === playerId);
    const score = draftState.itemsWithScores.find(i => i.item_name === itemName)?.score || 0;
    
    draftState.availableItems.splice(itemIndex, 1);
    draftState.playersItems[playerIndex].push({
        name: itemName,
        score: score
    });
    
    draftState.currentPickIndex++;
    
    if (draftState.currentPickIndex >= draftState.draftOrder.length) {
        // Draft complete
        draftState.results = calculateResults(draftState.players, draftState.playersItems);
        return { success: true, isComplete: true };
    }
    
    // Move to next player
    const nextPick = draftState.draftOrder[draftState.currentPickIndex];
    draftState.currentPlayer = draftState.players[nextPick.playerIndex];
    
    return { success: true, isComplete: false };
}

function calculateResults(players, playersItems) {
    return players.map((player, index) => {
        const totalScore = playersItems[index].reduce((sum, item) => sum + item.score, 0);
        return {
            playerId: player.id,
            playerName: player.name,
            totalScore: totalScore,
            items: playersItems[index]
        };
    }).sort((a, b) => b.totalScore - a.totalScore);
}

// Keep your existing API routes here
// ... (all your existing app.get routes)

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