const crypto = require('crypto');
const { pickCodeWord } = require('./words');
const games = require('./games');

const DEFAULT_TEAMS = [
  { id: 'A', name: 'Red Team', color: '#e63946' },
  { id: 'B', name: 'Blue Team', color: '#1d7bf2' },
];
const MAX_NAME = 20;
const LOG_SIZE = 15;

const secret = () => crypto.randomBytes(16).toString('hex');
const shortId = () => crypto.randomBytes(6).toString('hex');

function cleanName(name, max = MAX_NAME) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (!n) throw new Error('Please enter a name');
  return n;
}

class Room {
  constructor(code, { teamNames = [], random = Math.random, onChange = () => {} } = {}) {
    this.code = code;
    this.hostToken = secret();
    this.random = random;
    this.onChange = onChange;
    this.lastActivity = Date.now();
    this.teams = DEFAULT_TEAMS.map((t, i) => ({
      ...t,
      name: teamNames[i] ? cleanName(teamNames[i], 24) : t.name,
      score: 0,
    }));
    this.players = new Map();
    this.round = 0;
    this.game = null;
    this.timers = new Set();
    this.log = [];
  }

  touch() {
    this.lastActivity = Date.now();
  }

  team(teamId) {
    const t = this.teams.find((x) => x.id === teamId);
    if (!t) throw new Error('No such team');
    return t;
  }

  // Put a new player on whichever team is smallest; break ties at random.
  pickTeam() {
    const counts = this.teams.map((t) => ({ t, n: 0 }));
    for (const p of this.players.values()) counts.find((c) => c.t.id === p.teamId).n++;
    const min = Math.min(...counts.map((c) => c.n));
    const smallest = counts.filter((c) => c.n === min);
    return smallest[Math.floor(this.random() * smallest.length)].t.id;
  }

  addPlayer(rawName) {
    let name = cleanName(rawName);
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let i = 2;
      while (taken.has(`${name} ${i}`.toLowerCase())) i++;
      name = `${name} ${i}`;
    }
    const player = { id: shortId(), token: secret(), name, teamId: this.pickTeam(), connected: true };
    this.players.set(player.id, player);
    this.touch();
    return player;
  }

  // Returns the player if the token matches; a returning phone always gets its original team.
  resumePlayer(playerId, token) {
    const p = this.players.get(playerId);
    if (!p || p.token !== token) return null;
    return p;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.players.delete(playerId);
    const def = this.game && games.get(this.game.id);
    if (def && def.onPlayerRemoved) def.onPlayerRemoved(this.game.state, p, this.api());
  }

  addPoints(teamId, points, reason = '') {
    const n = Number(points);
    if (!Number.isFinite(n) || n === 0) throw new Error('Invalid points');
    const t = this.team(teamId);
    t.score += n;
    this.log.unshift({ at: Date.now(), teamId, points: n, reason: String(reason).slice(0, 60) });
    this.log.length = Math.min(this.log.length, LOG_SIZE);
  }

  renameTeam(teamId, name) {
    this.team(teamId).name = cleanName(name, 24);
  }

  resetScores() {
    for (const t of this.teams) t.score = 0;
    this.log = [];
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // The interface mini-games use to touch the room.
  api() {
    return {
      teams: this.teams,
      players: [...this.players.values()],
      random: this.random,
      awardPoints: (teamId, n, reason) => this.addPoints(teamId, n, reason),
      schedule: (ms, fn) => {
        const gameAtSchedule = this.game;
        const handle = setTimeout(() => {
          this.timers.delete(handle);
          if (this.game !== gameAtSchedule) return;
          try {
            fn();
          } catch (err) {
            console.error(`[${this.code}] game timer error:`, err);
          }
          this.onChange(this);
        }, ms);
        this.timers.add(handle);
        return handle;
      },
    };
  }

  setGame(gameId) {
    this.clearTimers();
    if (!gameId) {
      this.game = null;
      return;
    }
    const def = games.get(gameId);
    if (!def) throw new Error('Unknown game');
    this.round++;
    this.game = { id: def.id, name: def.name, round: this.round, startedAt: Date.now(), state: null };
    this.game.state = def.init(this.api());
  }

  gameAction(from, action, payload, player) {
    if (!this.game) throw new Error('No game is running');
    const def = games.get(this.game.id);
    const api = this.api();
    if (from === 'host') def.hostAction(this.game.state, action, payload, api);
    else def.playerAction(this.game.state, action, payload, player, api);
    this.touch();
  }

  // What one connected screen gets to see. viewer = { role: 'host'|'player'|'tv', playerId }
  snapshot(viewer = {}) {
    const player = viewer.playerId ? this.players.get(viewer.playerId) : null;
    const isHost = viewer.role === 'host';
    const def = this.game && games.get(this.game.id);
    return {
      code: this.code,
      role: viewer.role,
      isHost,
      me: player ? { id: player.id, name: player.name, teamId: player.teamId } : null,
      teams: this.teams.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        score: t.score,
        players: [...this.players.values()]
          .filter((p) => p.teamId === t.id)
          .map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
      })),
      game: this.game && {
        id: this.game.id,
        name: this.game.name,
        round: this.game.round,
        startedAt: this.game.startedAt,
        view: def.view(this.game.state, { role: viewer.role, player }, this.api()),
      },
      games: isHost ? games.list() : undefined,
      log: this.log,
      serverTime: Date.now(),
    };
  }
}

class RoomManager {
  constructor({ random = Math.random, onChange = () => {} } = {}) {
    this.rooms = new Map();
    this.random = random;
    this.onChange = onChange;
  }

  create(opts = {}) {
    const code = pickCodeWord(new Set(this.rooms.keys()), this.random);
    const room = new Room(code, { ...opts, random: this.random, onChange: this.onChange });
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').trim().toUpperCase()) || null;
  }

  delete(code) {
    const room = this.get(code);
    if (!room) return;
    room.clearTimers();
    this.rooms.delete(room.code);
  }
}

module.exports = { Room, RoomManager, cleanName };
