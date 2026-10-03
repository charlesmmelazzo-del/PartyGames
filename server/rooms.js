const crypto = require('crypto');
const { pickCodeWord } = require('./words');
const games = require('./games');

const DEFAULT_TEAMS = [
  { id: 'A', name: 'Red Team', color: '#e63946' },
  { id: 'B', name: 'Blue Team', color: '#1d7bf2' },
];
const MAX_NAME = 20;
const LOG_SIZE = 15;
const DEFAULT_CASH_OUT_LEAD = 10;
const DEFAULT_SWITCH_PRICE = 15;
const DEFAULT_SWITCH_MIN_MINUTES = 10;
const ANNOUNCE_MS = 8000;
const MAX_DARE = 80;
const DEFAULT_DARES = [
  'Whole team takes a shot',
  'Whole team dances for 30 seconds',
  'Whole team sings the chorus of a song the winners pick',
  'Whole team does 10 jumping jacks',
  'Whole team serenades the winning team',
  'Each loser says something nice about a winner',
  'Whole team does their best runway walk',
  'Whole team finishes their drink',
];

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
      cashOuts: 0,
      banked: 0,
    }));
    this.players = new Map();
    this.round = 0;
    this.game = null;
    this.timers = new Set();
    this.log = [];
    this.cashOutLead = DEFAULT_CASH_OUT_LEAD;
    this.dares = [...DEFAULT_DARES];
    this.cashOut = null; // pending: { teamId, owedBy, dare, by, at }
    this.switchPrice = DEFAULT_SWITCH_PRICE;
    this.switchMinMinutes = DEFAULT_SWITCH_MIN_MINUTES;
    this.announcement = null; // { id, text, teamId, at } flashed on every screen
  }

  announce(text, teamId) {
    this.announcement = { id: shortId(), text, teamId, at: Date.now() };
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
    for (const t of this.teams) Object.assign(t, { score: 0, cashOuts: 0, banked: 0 });
    this.log = [];
    this.cashOut = null;
  }

  // ---------- cash out: a team with a big lead trades it for a dare by the other team ----------

  standings() {
    const [leader, trailer] = [...this.teams].sort((a, b) => b.score - a.score);
    return { leader, trailer, lead: leader.score - trailer.score };
  }

  canCashOut(teamId) {
    return !this.cashOutBlocker(teamId);
  }

  // dareIndex: a number into this.dares, or 'random'.
  requestCashOut(teamId, dareIndex, byName) {
    if (this.cashOut) throw new Error('A cash out is already waiting on a dare');
    if (!this.canCashOut(teamId)) throw new Error(`You need a lead of ${this.cashOutLead} to cash out`);
    if (!this.dares.length) throw new Error('There are no dares to pick from');
    const i = dareIndex === 'random' ? Math.floor(this.random() * this.dares.length) : Number(dareIndex);
    const dare = this.dares[i];
    if (dare === undefined) throw new Error('Pick a dare');
    const { trailer } = this.standings();
    this.announce(`${this.team(teamId).name} cashed out! ${trailer.name} owes a dare.`, teamId);
    this.cashOut = { teamId, owedBy: trailer.id, dare, by: byName, random: dareIndex === 'random', at: Date.now() };
  }

  // Host confirms the dare was done: the leader's lead is banked and the score is tied up.
  completeCashOut() {
    if (!this.cashOut) throw new Error('No cash out pending');
    const t = this.team(this.cashOut.teamId);
    const other = this.team(this.cashOut.owedBy);
    const lead = Math.max(0, t.score - other.score);
    t.score -= lead;
    t.cashOuts++;
    t.banked += lead;
    this.log.unshift({ at: Date.now(), teamId: t.id, points: -lead, reason: `Cashed out: ${this.cashOut.dare}`.slice(0, 60) });
    this.log.length = Math.min(this.log.length, LOG_SIZE);
    this.cashOut = null;
  }

  cancelCashOut() {
    this.cashOut = null;
  }

  // ---------- team shop: things the winning team can spend its lead on ----------

  // Why `teamId` can't buy a game switch right now, or null if it can.
  switchBlocker(teamId) {
    const { leader, lead } = this.standings();
    if (games.list().length < 2) return 'Only one game available so far';
    if (!this.game) return 'No game is running';
    if (leader.id !== teamId || lead < this.switchPrice) return `Your team needs a lead of ${this.switchPrice}`;
    const left = this.game.startedAt + this.switchMinMinutes * 60000 - Date.now();
    if (left > 0) return `Unlocks in ${Math.ceil(left / 60000)} min (this game just started)`;
    return null;
  }

  cashOutBlocker(teamId) {
    const { leader, lead } = this.standings();
    if (this.cashOut) return 'Waiting on a dare';
    if (leader.id !== teamId || lead < this.cashOutLead) return `Your team needs a lead of ${this.cashOutLead}`;
    return null;
  }

  shop(teamId) {
    const cashOut = this.cashOutBlocker(teamId);
    const sw = this.switchBlocker(teamId);
    return [
      { id: 'cashOut', name: 'Cash out', cost: 'Your whole lead', what: 'The other team does a dare; your lead is banked and the score is tied.', available: !cashOut, reason: cashOut },
      { id: 'switchGame', name: 'Switch game', cost: `${this.switchPrice} points`, what: 'Your team picks the next game.', available: !sw, reason: sw },
    ];
  }

  // gameId: a game id or 'random' (any game other than the current one).
  buySwitch(teamId, gameId, byName) {
    const blocker = this.switchBlocker(teamId);
    if (blocker) throw new Error(blocker);
    const choices = games.list().filter((g) => g.id !== this.game.id);
    const pick = gameId === 'random' ? choices[Math.floor(this.random() * choices.length)] : choices.find((g) => g.id === gameId);
    if (!pick) throw new Error('Pick a different game');
    const t = this.team(teamId);
    this.addPoints(teamId, -this.switchPrice, `Bought a switch to ${pick.name}`);
    this.setGame(pick.id);
    this.announce(`${t.name} spent ${this.switchPrice} points to switch to ${pick.name}!`, teamId);
  }

  // Host's "crowd is bored" button: free, any game other than the current one.
  randomGame() {
    const choices = games.list().filter((g) => !this.game || g.id !== this.game.id);
    if (!choices.length) throw new Error('No other games yet');
    const pick = choices[Math.floor(this.random() * choices.length)];
    this.setGame(pick.id);
    this.announce(`New game: ${pick.name}!`);
  }

  setSwitchPrice(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 1000) throw new Error('Price must be 1-1000');
    this.switchPrice = v;
  }

  setSwitchMinMinutes(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 0 || v > 240) throw new Error('Minutes must be 0-240');
    this.switchMinMinutes = v;
    this.scheduleSwitchUnlock();
  }

  setCashOutLead(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 1000) throw new Error('Lead must be 1-1000');
    this.cashOutLead = v;
  }

  addDare(text) {
    const d = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DARE);
    if (!d) throw new Error('Type a dare');
    if (this.dares.length >= 50) throw new Error('That is a lot of dares already');
    this.dares.push(d);
  }

  removeDare(index) {
    if (this.dares[index] === undefined) throw new Error('No such dare');
    this.dares.splice(index, 1);
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
        if (handle.unref) handle.unref(); // never keep the process alive just for a game timer
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
    this.scheduleSwitchUnlock();
  }

  // Re-broadcast when buying a switch unlocks, so phones' shops update on their own.
  scheduleSwitchUnlock() {
    if (!this.game) return;
    const left = this.game.startedAt + this.switchMinMinutes * 60000 - Date.now();
    if (left > 0) this.api().schedule(left + 250, () => {});
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
        cashOuts: t.cashOuts,
        banked: t.banked,
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
      cashOut: this.cashOut,
      cashOutLead: this.cashOutLead,
      dares: this.dares,
      canCashOut: {
        host: isHost ? this.teams.filter((t) => this.canCashOut(t.id)).map((t) => t.id) : [],
        me: !!player && this.canCashOut(player.teamId),
      },
      shop: player ? this.shop(player.teamId) : null,
      allGames: games.list().map(({ id, name }) => ({ id, name })),
      switchPrice: this.switchPrice,
      switchMinMinutes: this.switchMinMinutes,
      announcement: this.announcement && Date.now() - this.announcement.at < ANNOUNCE_MS ? this.announcement : null,
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
