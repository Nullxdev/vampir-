// server.js - Node.js Backend for Vampire Village Game
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS ayarları: Frontend eklentisinin localhost'tan ve canlı URL'den erişimine izin ver
const io = new Server(server, {
    cors: {
        origin: ["https://cheatglobal.com", "chrome-extension://*", "http://localhost:3000", "https://vampir.onrender.com"],
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

const rooms = {};

const generateRoomId = () => {
    return 'VG' + Math.random().toString(36).substr(2, 6).toUpperCase();
};

const assignRoles = (players) => {
    const totalPlayers = players.length;
    let roles = [];
    if (totalPlayers >= 5 && totalPlayers <= 7) {
        roles = ['Vampir', 'Vampir', 'Doktor', ...Array(totalPlayers - 3).fill('Köylü')];
    } else if (totalPlayers > 7) {
        roles = ['Vampir', 'Vampir', 'Vampir', 'Doktor', ...Array(totalPlayers - 4).fill('Köylü')];
    } else {
        roles = ['Vampir', 'Doktor', ...Array(totalPlayers - 2).fill('Köylü')];
    }
    
    roles.sort(() => Math.random() - 0.5);

    players.forEach((player, index) => {
        player.role = roles[index];
        player.isAlive = true;
    });
};

io.on('connection', (socket) => {
    console.log(`Yeni oyuncu bağlandı: ${socket.id}`);

    socket.on('createRoom', (data) => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            name: data.roomName,
            host: data.playerName,
            players: [{ id: socket.id, name: data.playerName }],
            gameStatus: 'Bekleniyor',
            dayCount: 0,
            killedPlayer: null,
            savedPlayer: null,
            votes: {},
            lastMessage: `Oda ${data.roomName} kuruldu. Oyuncular bekleniyor.`
        };
        socket.join(roomId);
        socket.emit('roomCreated', rooms[roomId]);
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length < 15) {
            const isPlayerInRoom = room.players.some(p => p.id === socket.id);
            if (!isPlayerInRoom) {
                room.players.push({ id: socket.id, name: data.playerName });
                socket.join(data.roomId);
                socket.emit('roomJoined', room);
                io.to(data.roomId).emit('playerJoined', { room, message: `${data.playerName} odaya katıldı.` });
            } else {
                socket.emit('joinError', 'Zaten bu odadasınız.');
            }
        } else {
            socket.emit('joinError', 'Oda bulunamadı veya dolu.');
        }
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        if (room && room.players.length >= 2) {
            assignRoles(room.players);
            room.gameStatus = 'Gece';
            room.dayCount = 1;
            room.lastMessage = `Oyun başladı! Şu an gece.`;
            io.to(roomId).emit('gameStarted', room);
            io.to(roomId).emit('updateGame', room);
        } else {
            socket.emit('gameError', 'Oyunu başlatmak için en az 2 oyuncu gerekli.');
        }
    });

    socket.on('nightAction', (data) => {
        const { roomId, playerId, targetPlayerId, actionType } = data;
        const room = rooms[roomId];
        if (room && room.gameStatus === 'Gece') {
            const player = room.players.find(p => p.id === playerId);
            if (!player) return;

            if (player.role === 'Vampir' && actionType === 'kill') {
                room.killedPlayer = targetPlayerId;
                io.to(roomId).emit('actionReceived', { action: 'kill', player: player.name });
            } else if (player.role === 'Doktor' && actionType === 'save') {
                room.savedPlayer = targetPlayerId;
                io.to(roomId).emit('actionReceived', { action: 'save', player: player.name });
            }

            if (room.killedPlayer && room.savedPlayer) {
                setTimeout(() => {
                    const victim = room.players.find(p => p.id === room.killedPlayer);
                    if (victim && victim.id !== room.savedPlayer) {
                        victim.isAlive = false;
                        room.lastMessage = `Gece yarısı, ${victim.name} öldürüldü!`;
                    } else if (victim && victim.id === room.savedPlayer) {
                        room.lastMessage = `Doktor, ${victim.name}'i kurtardı!`;
                    } else {
                        room.lastMessage = `Bu gece kimse ölmedi.`;
                    }
                    
                    room.gameStatus = 'Gündüz';
                    room.killedPlayer = null;
                    room.savedPlayer = null;
                    io.to(roomId).emit('updateGame', room);
                    checkWin(room, roomId);
                }, 2000);
            }
        }
    });

    socket.on('vote', (data) => {
        const { roomId, voterId, targetId } = data;
        const room = rooms[roomId];
        if (room && room.gameStatus === 'Gündüz') {
            room.votes[voterId] = targetId;

            const alivePlayers = room.players.filter(p => p.isAlive);
            if (Object.keys(room.votes).length === alivePlayers.length) {
                const voteCounts = {};
                alivePlayers.forEach(p => voteCounts[p.id] = 0);
                Object.values(room.votes).forEach(vote => {
                    if (voteCounts[vote] !== undefined) {
                        voteCounts[vote]++;
                    }
                });

                let maxVotes = 0;
                let lynchedPlayerId = null;
                for (const [playerId, count] of Object.entries(voteCounts)) {
                    if (count > maxVotes) {
                        maxVotes = count;
                        lynchedPlayerId = playerId;
                    }
                }
                
                const lynchedPlayer = room.players.find(p => p.id === lynchedPlayerId);
                if (lynchedPlayer) {
                    lynchedPlayer.isAlive = false;
                    room.lastMessage = `Oylama sonucunda ${lynchedPlayer.name} infaz edildi. Rolü: ${lynchedPlayer.role}.`;
                } else {
                    room.lastMessage = 'Oylama berabere bitti, kimse infaz edilmedi.';
                }

                room.votes = {};
                room.gameStatus = 'Gece';
                room.dayCount++;
                io.to(roomId).emit('updateGame', room);
                checkWin(room, roomId);
            }
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                const playerName = room.players[playerIndex].name;
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('playerLeft', { room, message: `${playerName} odadan ayrıldı.` });
                if (room.players.length === 0) {
                    delete rooms[roomId];
                }
                break;
            }
        }
        console.log(`Oyuncu ayrıldı: ${socket.id}`);
    });
});

function checkWin(room, roomId) {
    const alivePlayers = room.players.filter(p => p.isAlive);
    const aliveVampires = alivePlayers.filter(p => p.role === 'Vampir');
    const aliveVillagers = alivePlayers.filter(p => p.role !== 'Vampir');

    if (aliveVampires.length === 0) {
        room.gameStatus = 'Bitti';
        room.lastMessage = 'Vampirler yok edildi. Köylüler kazandı!';
        io.to(roomId).emit('gameOver', room);
        delete rooms[roomId];
    } else if (aliveVampires.length >= aliveVillagers.length) {
        room.gameStatus = 'Bitti';
        room.lastMessage = 'Vampirler şehri ele geçirdi. Vampirler kazandı!';
        io.to(roomId).emit('gameOver', room);
        delete rooms[roomId];
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
