const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));

const TURN_SECONDS = 30;

const WORDS = [
  'cat', 'dog', 'elephant', 'penguin', 'dragon', 'jellyfish', 'butterfly', 'shark',
  'bicycle', 'umbrella', 'telescope', 'guitar', 'crown', 'anchor', 'compass',
  'rainbow', 'volcano', 'tornado', 'waterfall', 'cactus', 'mushroom', 'snowflake',
  'pizza', 'sandwich', 'sushi', 'ice cream', 'donut', 'hotdog', 'taco',
  'castle', 'lighthouse', 'spaceship', 'submarine', 'parachute', 'rocket',
  'house', 'tree', 'sun', 'moon', 'star', 'cloud', 'mountain', 'bridge', 'boat',
  'robot', 'alien', 'wizard', 'pirate', 'ninja', 'mermaid', 'ghost', 'unicorn',
  'fire', 'wave', 'snail', 'frog', 'owl', 'fox', 'bear', 'duck', 'snake',
  'clock', 'chair', 'lamp', 'phone', 'key', 'hat', 'shoe', 'cup', 'ball'
];

const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function pickWords(n) {
  return [...WORDS].sort(() => Math.random() - 0.5).slice(0, n);
}

function publicPlayers(room) {
  return room.players.map(p => ({
    name: p.name,
    position: p.position,
    isHost: p.isHost,
    connected: p.connected
  }));
}

function connectedPlayers(room) {
  return room.players.filter(p => p.connected);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }) => {
    const code = generateCode();
    rooms[code] = {
      code,
      players: [{ id: socket.id, name: name.trim().slice(0, 20), position: 0, isHost: true, connected: true }],
      chains: [],
      currentRound: 0,
      totalRounds: 0,
      phase: 'waiting',
      submissions: {},
      timerHandle: null,
      lastActivity: Date.now()
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.position = 0;
    socket.emit('room_created', { code, position: 0 });
    io.to(code).emit('room_update', { players: publicPlayers(rooms[code]) });
  });

  socket.on('join_room', ({ name, code }) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('join_error', 'Room not found'); return; }
    if (room.phase !== 'waiting') { socket.emit('join_error', 'Game already in progress'); return; }
    if (room.players.length >= 8) { socket.emit('join_error', 'Room is full (max 8 players)'); return; }

    const position = room.players.length;
    room.players.push({ id: socket.id, name: name.trim().slice(0, 20), position, isHost: false, connected: true });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.position = position;
    room.lastActivity = Date.now();
    socket.emit('room_joined', { code, position });
    io.to(code).emit('room_update', { players: publicPlayers(room) });
  });

  socket.on('start_game', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;
    if (room.players.length < 2) {
      socket.emit('game_error', 'Need at least 2 players to start');
      return;
    }
    startGame(room.code);
  });

  socket.on('submit', ({ content }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;

    const pos = socket.data.position;
    if (room.submissions[pos] !== undefined) return;

    room.submissions[pos] = content;
    room.lastActivity = Date.now();

    const active = connectedPlayers(room);
    const submittedCount = active.filter(p => room.submissions[p.position] !== undefined).length;
    io.to(code).emit('submission_progress', { submitted: submittedCount, total: active.length });

    if (submittedCount >= active.length) {
      advanceRound(code);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms[code];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.connected = false;

    io.to(code).emit('room_update', { players: publicPlayers(room) });

    if (room.phase === 'playing') {
      const active = connectedPlayers(room);
      if (active.length === 0) {
        clearTimeout(room.timerHandle);
        delete rooms[code];
        return;
      }
      const submittedCount = active.filter(p => room.submissions[p.position] !== undefined).length;
      if (submittedCount >= active.length) {
        advanceRound(code);
      }
    }
  });
});

function startGame(code) {
  const room = rooms[code];
  const N = room.players.length;

  room.phase = 'playing';
  room.currentRound = 0;
  room.totalRounds = N;
  room.submissions = {};

  const words = pickWords(N);
  room.chains = room.players.map((p, i) => [{
    type: 'word',
    content: words[i],
    by: p.name
  }]);

  io.to(code).emit('game_started', { totalRounds: N });
  sendTurns(room);
  startTimer(code);
}

function sendTurns(room) {
  const N = room.players.length;
  const R = room.currentRound;
  const turnType = R % 2 === 0 ? 'draw' : 'guess';

  room.players.forEach(player => {
    if (!player.connected) return;
    const chainIdx = ((player.position - R) % N + N) % N;
    const chain = room.chains[chainIdx];
    const lastItem = chain[chain.length - 1];

    io.to(player.id).emit('your_turn', {
      type: turnType,
      content: lastItem.content,
      round: R,
      totalRounds: N
    });
  });

  io.to(room.code).emit('round_info', { round: R, totalRounds: N, type: turnType });
}

function advanceRound(code) {
  const room = rooms[code];
  if (!room || room.phase !== 'playing') return;

  clearTimeout(room.timerHandle);
  room.timerHandle = null;

  const N = room.players.length;
  const R = room.currentRound;
  const subType = R % 2 === 0 ? 'drawing' : 'word';

  room.players.forEach(player => {
    const chainIdx = ((player.position - R) % N + N) % N;
    const content = room.submissions[player.position] !== undefined ? room.submissions[player.position] : null;
    room.chains[chainIdx].push({ type: subType, content, by: player.name });
  });

  room.currentRound++;
  room.submissions = {};

  if (room.currentRound >= N) {
    room.phase = 'reveal';
    io.to(code).emit('reveal', {
      chains: room.chains,
      players: publicPlayers(room)
    });
    return;
  }

  sendTurns(room);
  startTimer(code);
}

function startTimer(code) {
  const room = rooms[code];
  const roundAtStart = room.currentRound;
  const deadline = Date.now() + (TURN_SECONDS + 2) * 1000;

  io.to(code).emit('timer_start', { seconds: TURN_SECONDS, deadline });

  room.timerHandle = setTimeout(() => {
    if (rooms[code] && rooms[code].currentRound === roundAtStart) {
      advanceRound(code);
    }
  }, (TURN_SECONDS + 2) * 1000);
}

// Clean up stale rooms every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  Object.keys(rooms).forEach(code => {
    if (rooms[code].lastActivity < cutoff) {
      clearTimeout(rooms[code].timerHandle);
      delete rooms[code];
    }
  });
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => console.log(`Write-Draw-Write running at http://localhost:${PORT}`));
