const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Deck ─────────────────────────────────────────────────────────────────────

const COLORS = ['red', 'yellow', 'green', 'blue'];
const VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];

function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    for (const val of VALUES) {
      deck.push({ color, value: val });
      if (val !== '0') deck.push({ color, value: val });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild' });
    deck.push({ color: 'wild', value: 'wild_draw4' });
  }
  // 2 swap_hands cards
  deck.push({ color: 'wild', value: 'swap_hands' });
  deck.push({ color: 'wild', value: 'swap_hands' });
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
  if (card.value === 'wild' || card.value === 'wild_draw4' || card.value === 'swap_hands') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

// ─── Rooms ────────────────────────────────────────────────────────────────────

const rooms = {};

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],
    deck: [],
    discard: [],
    currentColor: null,
    currentPlayerIndex: 0,
    direction: 1,
    started: false,
    drawStack: 0,
    winner: null,
    host: null,
    unoCalled: {},
    lastEvent: null,
  };
}

function getRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
  return rooms[roomId];
}

function nextPlayerIndex(room, steps = 1) {
  const n = room.players.length;
  let idx = room.currentPlayerIndex;
  for (let i = 0; i < steps; i++) idx = ((idx + room.direction) % n + n) % n;
  return idx;
}

function advanceTurn(room, steps = 1) {
  room.currentPlayerIndex = nextPlayerIndex(room, steps);
}

function refillDeck(room) {
  if (room.deck.length < 4 && room.discard.length > 1) {
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
    if (room.deck.length > 0) player.hand.push(room.deck.pop());
  }
  delete room.unoCalled[playerId];
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
    lastEvent: room.lastEvent,
    deckSize: room.deck.length,
  };
}

function broadcastState(room) {
  room.players.forEach(p => io.to(p.id).emit('gameState', buildStateFor(room, p.id)));
}

// ─── Game init ────────────────────────────────────────────────────────────────

function startGame(room) {
  room.deck = shuffle(buildDeck());
  room.discard = [];
  room.winner = null;
  room.direction = 1;
  room.currentPlayerIndex = 0;
  room.drawStack = 0;
  room.unoCalled = {};
  room.lastEvent = null;

  room.players.forEach(p => { p.hand = []; });
  for (let i = 0; i < 7; i++) room.players.forEach(p => p.hand.push(room.deck.pop()));

  let firstCard;
  do {
    firstCard = room.deck.pop();
    if (firstCard.color === 'wild') room.deck.unshift(firstCard);
  } while (firstCard.color === 'wild');

  room.discard.push(firstCard);
  room.currentColor = firstCard.color;

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

// ─── Sockets ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = getRoom(roomId);
    if (room.started)              { socket.emit('error', 'Game already in progress.'); return; }
    if (room.players.length >= 10) { socket.emit('error', 'Room is full (max 10).'); return; }
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
    if (room.host !== socket.id)  { socket.emit('error', 'Only the host can start.'); return; }
    if (room.players.length < 2)  { socket.emit('error', 'Need at least 2 players.'); return; }
    startGame(room);
    broadcastState(room);
  });

  socket.on('playCard', ({ cardIndex, chosenColor, swapTargetId }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started || room.winner) return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socket.id) { socket.emit('error', "It's not your turn."); return; }

    const player = room.players.find(p => p.id === socket.id);
    const card = player.hand[cardIndex];
    if (!card) return;

    const topCard = room.discard[room.discard.length - 1];

    // Draw-stack enforcement
    if (room.drawStack > 0) {
      const canStack = card.value === 'wild_draw4' ||
                       (card.value === 'draw2' && (topCard.value === 'draw2' || topCard.value === 'wild_draw4'));
      if (!canStack) { socket.emit('error', 'You must stack a draw card or take the penalty.'); return; }
    } else {
      if (!canPlay(card, topCard, room.currentColor)) { socket.emit('error', "You can't play that card."); return; }
    }

    // Remove card from hand
    player.hand.splice(cardIndex, 1);
    room.discard.push(card);
    room.lastEvent = { type: 'play', playerId: socket.id, playerName: player.name, card };

    if (card.color !== 'wild') {
      room.currentColor = card.color;
    } else {
      room.currentColor = chosenColor || 'red';
    }

    // When player is down to 1 card, reset their UNO-called status so they must re-call
    if (player.hand.length === 1) {
      delete room.unoCalled[socket.id];
    }

    // Win check
    if (player.hand.length === 0) {
      room.winner = player.name;
      room.lastEvent = { type: 'win', playerName: player.name };
      broadcastState(room);
      return;
    }

    // Card effects
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
      // skip = advance TWO steps (past next player, land on the one after)
      advanceTurn(room, 2);
      broadcastState(room);
      return;
    }
    if (card.value === 'reverse') {
      room.direction *= -1;
      if (room.players.length === 2) {
        advanceTurn(room, 2); // acts like skip in 2-player
      } else {
        advanceTurn(room);
      }
      broadcastState(room);
      return;
    }
    if (card.value === 'swap_hands') {
      const target = room.players.find(p => p.id === swapTargetId);
      if (target && target.id !== socket.id) {
        [player.hand, target.hand] = [target.hand, player.hand];
        delete room.unoCalled[socket.id];
        delete room.unoCalled[target.id];
        room.lastEvent = { type: 'swap', playerName: player.name, targetName: target.name };
        io.to(room.id).emit('swapEvent', { swapper: player.name, target: target.name });
      }
      advanceTurn(room);
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
      const count = room.drawStack;
      drawCards(room, socket.id, count);
      room.drawStack = 0;
      room.lastEvent = { type: 'drawStack', playerId: socket.id, count };
      advanceTurn(room);
      broadcastState(room);
      return;
    }

    drawCards(room, socket.id, 1);
    room.lastEvent = { type: 'draw', playerId: socket.id };

    // Tell this player whether their drawn card is playable
    const pl = room.players.find(p => p.id === socket.id);
    const drawn = pl.hand[pl.hand.length - 1];
    const topCard = room.discard[room.discard.length - 1];
    const drawnPlayable = canPlay(drawn, topCard, room.currentColor);

    room.players.forEach(p => {
      const state = buildStateFor(room, p.id);
      if (p.id === socket.id) state.drawnCardPlayable = drawnPlayable;
      io.to(p.id).emit('gameState', state);
    });
  });

  socket.on('passTurn', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started || room.winner) return;
    if (room.players[room.currentPlayerIndex].id !== socket.id) return;
    room.lastEvent = { type: 'pass', playerId: socket.id };
    advanceTurn(room);
    broadcastState(room);
  });

  socket.on('callUno', () => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    room.unoCalled[socket.id] = true;
    io.to(room.id).emit('unoCalled', { playerName: player.name, playerId: socket.id });
    broadcastState(room);
  });

  socket.on('catchUno', ({ targetId }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started) return;
    const target = room.players.find(p => p.id === targetId);
    if (!target) return;
    if (target.hand.length === 1 && !room.unoCalled[targetId]) {
      drawCards(room, targetId, 2);
      const catcher = room.players.find(p => p.id === socket.id);
      io.to(room.id).emit('unoCaught', { catcher: catcher?.name, target: target.name });
      broadcastState(room);
    }
  });

  socket.on('setColor', ({ color }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.started || room.winner) return;
    const VALID = ['red','yellow','green','blue'];
    if (!VALID.includes(color)) return;
    room.currentColor = color;
    broadcastState(room);
  });

  socket.on('resetGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.host !== socket.id) return;
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
    if (room.players.length === 0) { delete rooms[roomId]; return; }
    if (room.host === socket.id) room.host = room.players[0].id;
    if (room.started && !room.winner && room.currentPlayerIndex >= room.players.length) {
      room.currentPlayerIndex = 0;
    }
    broadcastState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🃏  UNO ready → http://localhost:${PORT}\n`));
