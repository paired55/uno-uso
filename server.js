const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ───────────────────────────────────────────────────────────────

const COLORS = ['red', 'yellow', 'green', 'blue'];
const VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];
const WILDS  = ['wild','wild_draw4'];

function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (const val of VALUES) {
      deck.push({ color, value: val });
      if (val !== '0') deck.push({ color, value: val }); // two of each except 0
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild' });
    deck.push({ color: 'wild', value: 'wild_draw4' });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function canPlay(card, topCard, currentColor) {
  if (card.value === 'wild' || card.value === 'wild_draw4') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

// rooms: { [roomId]: Room }
const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],       // { id, name, hand: [] }
    deck: [],
    discard: [],
    currentColor: null,
    currentPlayerIndex: 0,
    direction: 1,      // 1 = clockwise, -1 = counter
    started: false,
    drawStack: 0,      // accumulated draw2 / wild_draw4
    pendingDraw: false,
    winner: null,
    host: null,
    // track who called UNO
    unoCalled: {},     // playerId -> true
  };
}

function getRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
  return rooms[roomId];
}

function nextPlayerIndex(room, skip = 0) {
  const n = room.players.length;
  let idx = room.currentPlayerIndex;
  for (let i = 0; i <= skip; i++) {
    idx = ((idx + room.direction) % n + n) % n;
  }
  return idx;
}

function advanceTurn(room, skip = 0) {
  room.currentPlayerIndex = nextPlayerIndex(room, skip);
}

function broadcastState(room) {
  room.players.forEach(p => {
    const state = buildStateFor(room, p.id);
    io.to(p.id).emit('gameState', state);
  });
  // Also send to spectators / lobby watchers
  io.to(room.id + '_lobby').emit('lobbyUpdate', {
    playerCount: room.players.length,
    started: room.started,
    players: room.players.map(p => ({ name: p.name, cardCount: p.hand.length }))
  });
}

function buildStateFor(room, playerId) {
  const me = room.players.find(p => p.id === playerId);
  return {
    roomId: room.id,
    started: room.started,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      isCurrentPlayer: room.players[room.currentPlayerIndex]?.id === p.id,
    })),
    myHand: me ? me.hand : [],
    topCard: room.discard[room.discard.length - 1] || null,
    currentColor: room.currentColor,
    currentPlayerId: room.players[room.currentPlayerIndex]?.id,
    direction: room.direction,
    drawStack: room.drawStack,
    winner: room.winner,
    host: room.host,
    myId: playerId,
    unoCalled: room.unoCalled,
  };
}

function refillDeck(room) {
  if (room.deck.length < 5) {
    const top = room.discard.pop();
    room.deck = shuffle(room.discard);
    room.discard = [top];
  }
}

function drawCards(room, playerId, count) {
  refillDeck(room);
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) refillDeck(room);
    if (room.deck.length > 0) {
      player.hand.push(room.deck.pop());
    }
  }
  // Reset UNO call if they draw
  delete room.unoCalled[playerId];
}

function startGame(room) {
  room.deck = shuffle(buildDeck());
  room.discard = [];
  room.winner = null;
  room.direction = 1;
  room.currentPlayerIndex = 0;
  room.drawStack = 0;
  room.unoCalled = {};

  // Deal 7 cards each
  room.players.forEach(p => { p.hand = []; });
  for (let i = 0; i < 7; i++) {
    room.players.forEach(p => p.hand.push(room.deck.pop()));
  }

  // Flip first card (must be non-wild)
  let firstCard;
  do {
    firstCard = room.deck.pop();
    if (firstCard.color === 'wild') room.deck.unshift(firstCard);
  } while (firstCard.color === 'wild');

  room.discard.push(firstCard);
  room.currentColor = firstCard.color;

  // Apply first card effects
  if (firstCard.value === 'skip') {
    advanceTurn(room);
  } else if (firstCard.value === 'reverse') {
    room.direction = -1;
    if (room.players.length === 2) advanceTurn(room);
  } else if (firstCard.value === 'draw2') {
    room.drawStack = 2;
  }

  room.started = true;
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = getRoom(roomId);
    if (room.started) {
      socket.emit('error', 'Game already in progress.');
      return;
    }
    if (room.players.length >= 10) {
      socket.emit('error', 'Room is full.');
      return;
    }
    // Remove old entry if reconnecting
    room.players = room.players.filter(p => p.id !== socket.id);

    const isHost = room.players.length === 0;
    if (isHost) room.host = socket.id;

    room.players.push({ id: socket.id, name: playerName, hand: [] });
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { roomId, isHost, playerId: socket.id });
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.host !== socket.id) { socket.emit('error', 'Only the host can start.'); return; }
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players.'); return; }
    startGame(room);
    broadcastState(room);
  });

  socket.on('playCard', ({ cardIndex, chosenColor }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started || room.winner) return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error', "It's not your turn.");
      return;
    }

    const player = room.players.find(p => p.id === socket.id);
    const card = player.hand[cardIndex];
    if (!card) return;

    const topCard = room.discard[room.discard.length - 1];

    // If there's a draw stack, player must play matching draw card or draw
    if (room.drawStack > 0) {
      const canStack = (card.value === 'draw2' && topCard.value === 'draw2') ||
                       (card.value === 'wild_draw4' && topCard.value === 'wild_draw4') ||
                       (card.value === 'wild_draw4'); // draw4 can always stack on draw2
      if (!canStack) {
        socket.emit('error', 'You must play a Draw card or draw the stack.');
        return;
      }
    } else {
      if (!canPlay(card, topCard, room.currentColor)) {
        socket.emit('error', "You can't play that card.");
        return;
      }
    }

    // Remove card from hand
    player.hand.splice(cardIndex, 1);
    room.discard.push(card);

    // Set color
    if (card.color !== 'wild') {
      room.currentColor = card.color;
    } else {
      room.currentColor = chosenColor || 'red';
      card.chosenColor = room.currentColor;
    }

    // Check win
    if (player.hand.length === 0) {
      room.winner = player.name;
      broadcastState(room);
      return;
    }

    // Apply card effects
    if (card.value === 'draw2') {
      room.drawStack += 2;
      advanceTurn(room);
      broadcastState(room);
      return;
    }

    if (card.value === 'wild_draw4') {
      room.drawStack += 4;
      advanceTurn(room);
      broadcastState(room);
      return;
    }

    if (card.value === 'skip') {
      advanceTurn(room, 1); // skip next
      broadcastState(room);
      return;
    }

    if (card.value === 'reverse') {
      room.direction *= -1;
      if (room.players.length === 2) {
        // in 2-player, reverse acts like skip
        advanceTurn(room);
      } else {
        advanceTurn(room);
      }
      broadcastState(room);
      return;
    }

    advanceTurn(room);
    broadcastState(room);
  });

  socket.on('drawCard', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started || room.winner) return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) return;

    if (room.drawStack > 0) {
      drawCards(room, socket.id, room.drawStack);
      room.drawStack = 0;
      advanceTurn(room);
    } else {
      drawCards(room, socket.id, 1);
      // Check if drawn card is playable - player may play it
      const player = room.players.find(p => p.id === socket.id);
      const drawnCard = player.hand[player.hand.length - 1];
      const topCard = room.discard[room.discard.length - 1];
      if (!canPlay(drawnCard, topCard, room.currentColor)) {
        advanceTurn(room);
      }
      // else player can optionally play it (client will show option)
    }

    broadcastState(room);
  });

  socket.on('callUno', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    room.unoCalled[socket.id] = true;
    io.to(room.id).emit('unoCalled', { playerName: player.name });
    broadcastState(room);
  });

  socket.on('catchUno', ({ targetId }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started) return;
    const target = room.players.find(p => p.id === targetId);
    if (!target) return;
    if (target.hand.length === 1 && !room.unoCalled[targetId]) {
      drawCards(room, targetId, 2);
      io.to(room.id).emit('unoCaught', { catcher: room.players.find(p=>p.id===socket.id)?.name, target: target.name });
      broadcastState(room);
    }
  });

  socket.on('passTurn', () => {
    // After drawing, player can pass
    const room = rooms[socket.data.roomId];
    if (!room || !room.started || room.winner) return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) return;
    advanceTurn(room);
    broadcastState(room);
  });

  socket.on('resetGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.host !== socket.id) return;
    startGame(room);
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    delete room.unoCalled[socket.id];

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }

    // Reassign host if needed
    if (room.host === socket.id) {
      room.host = room.players[0].id;
    }

    // If game in progress and it was their turn, advance
    if (room.started && !room.winner) {
      if (room.currentPlayerIndex >= room.players.length) {
        room.currentPlayerIndex = 0;
      }
    }

    broadcastState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🃏 UNO Server running at http://localhost:${PORT}\n`);
});
