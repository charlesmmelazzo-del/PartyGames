const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const IDLE_ROOM_MS = 6 * 60 * 60 * 1000; // empty rooms with no activity for 6h are deleted
const SWEEP_MS = 10 * 60 * 1000;

function createServer({ random } = {}) {
  const app = express();
  app.set('trust proxy', true); // Railway terminates HTTPS in front of us
  const server = http.createServer(app);
  const io = new Server(server);
  const rooms = new RoomManager({ random, onChange: (room) => broadcast(room) });

  app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));

  // QR code that opens the join screen with the code pre-filled.
  app.get('/qr/:code.svg', async (req, res) => {
    const room = rooms.get(req.params.code);
    if (!room) return res.status(404).end();
    const url = `${req.protocol}://${req.get('host')}/?code=${room.code}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
    res.type('image/svg+xml').send(svg);
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  function socketsIn(room) {
    const ids = io.sockets.adapter.rooms.get(room.code);
    return ids ? [...ids].map((id) => io.sockets.sockets.get(id)).filter(Boolean) : [];
  }

  function broadcast(room) {
    for (const s of socketsIn(room)) s.emit('state', room.snapshot(s.data));
  }

  function closeRoom(room) {
    for (const s of socketsIn(room)) {
      s.emit('room:closed');
      s.leave(room.code);
      s.data = {};
    }
    rooms.delete(room.code);
  }

  function updateConnected(room) {
    const online = new Set(socketsIn(room).map((s) => s.data.playerId).filter(Boolean));
    for (const p of room.players.values()) p.connected = online.has(p.id);
  }

  function attach(socket, room, data) {
    if (socket.data.code && socket.data.code !== room.code) socket.leave(socket.data.code);
    socket.data = { ...data, code: room.code };
    socket.join(room.code);
    room.touch();
    updateConnected(room);
    broadcast(room);
  }

  io.on('connection', (socket) => {
    socket.data = {};

    // Wraps a handler so thrown errors come back to the caller as { error }.
    const on = (event, fn) =>
      socket.on(event, (msg, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          reply(fn(msg || {}) || { ok: true });
        } catch (err) {
          reply({ error: err.message || 'Something went wrong' });
        }
      });

    const currentRoom = () => {
      const room = rooms.get(socket.data.code);
      if (!room) throw new Error('Game not found');
      return room;
    };

    on('host:create', ({ teamNames }) => {
      const room = rooms.create({ teamNames });
      attach(socket, room, { role: 'host' });
      return { code: room.code, hostToken: room.hostToken };
    });

    // Rejoin from a saved session. Works for host, player, or both on one phone.
    on('session:resume', ({ code, hostToken, playerId, playerToken }) => {
      const room = rooms.get(code);
      if (!room) return { error: 'gone' };
      const isHost = !!hostToken && hostToken === room.hostToken;
      const player = playerId ? room.resumePlayer(playerId, playerToken) : null;
      if (!isHost && !player) return { error: 'gone' };
      attach(socket, room, { role: isHost ? 'host' : 'player', playerId: player ? player.id : undefined });
      return { ok: true, code: room.code, isPlayer: !!player, isHost };
    });

    on('player:join', ({ code, name }) => {
      const room = rooms.get(code);
      if (!room) throw new Error(`No game called "${String(code || '').toUpperCase()}"`);
      // A host joining their own game keeps their host role.
      const isHost = socket.data.code === room.code && socket.data.role === 'host';
      if (socket.data.code === room.code && socket.data.playerId) throw new Error('Already on a team');
      const player = room.addPlayer(name);
      attach(socket, room, { role: isHost ? 'host' : 'player', playerId: player.id });
      return { code: room.code, playerId: player.id, playerToken: player.token, teamId: player.teamId };
    });

    on('tv:watch', ({ code }) => {
      const room = rooms.get(code);
      if (!room) throw new Error(`No game called "${String(code || '').toUpperCase()}"`);
      attach(socket, room, { role: 'tv' });
      return { code: room.code };
    });

    on('host:action', ({ type, ...msg }) => {
      const room = currentRoom();
      if (socket.data.role !== 'host') throw new Error('Only the host can do that');
      switch (type) {
        case 'addPoints':
          room.addPoints(msg.teamId, msg.points, 'Host');
          break;
        case 'renameTeam':
          room.renameTeam(msg.teamId, msg.name);
          break;
        case 'setGame':
          room.setGame(msg.gameId);
          if (room.game) room.announce(`New game: ${room.game.name}!`);
          break;
        case 'game':
          room.gameAction('host', msg.action, msg.payload);
          break;
        case 'removePlayer':
          room.removePlayer(msg.playerId);
          for (const s of socketsIn(room)) {
            if (s.data.playerId !== msg.playerId) continue;
            s.emit('player:removed');
            if (s.data.role === 'host') s.data = { ...s.data, playerId: undefined };
            else {
              s.leave(room.code);
              s.data = {};
            }
          }
          break;
        case 'cashOut':
          room.requestCashOut(msg.teamId, msg.dareIndex, 'Host');
          break;
        case 'randomGame':
          room.randomGame();
          break;
        case 'setSwitchPrice':
          room.setSwitchPrice(msg.price);
          break;
        case 'setSwitchMinMinutes':
          room.setSwitchMinMinutes(msg.minutes);
          break;
        case 'cashOutDone':
          room.completeCashOut();
          break;
        case 'cashOutCancel':
          room.cancelCashOut();
          break;
        case 'setCashOutLead':
          room.setCashOutLead(msg.lead);
          break;
        case 'addDare':
          room.addDare(msg.text);
          break;
        case 'removeDare':
          room.removeDare(msg.index);
          break;
        case 'resetScores':
          room.resetScores();
          break;
        case 'endGame':
          closeRoom(room);
          return { ok: true };
        default:
          throw new Error('Unknown action');
      }
      room.touch();
      broadcast(room);
    });

    on('player:action', ({ action, payload }) => {
      const room = currentRoom();
      const player = socket.data.playerId && room.players.get(socket.data.playerId);
      if (!player) throw new Error('Join a team first');
      if (action === 'cashOut') room.requestCashOut(player.teamId, payload && payload.dareIndex, player.name);
      else if (action === 'switchGame') room.buySwitch(player.teamId, payload && payload.gameId, player.name);
      else room.gameAction('player', action, payload, player);
      room.touch();
      broadcast(room);
    });

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.code);
      if (!room) return;
      updateConnected(room);
      broadcast(room);
    });
  });

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.rooms.values()]) {
      if (socketsIn(room).length === 0 && now - room.lastActivity > IDLE_ROOM_MS) rooms.delete(room.code);
    }
  }, SWEEP_MS);
  sweeper.unref();

  return { app, server, io, rooms, close: () => new Promise((r) => { clearInterval(sweeper); io.close(); server.close(() => r()); }) };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createServer().server.listen(port, () => console.log(`PartyGames listening on :${port}`));
}

module.exports = { createServer };
