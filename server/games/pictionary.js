// Pictionary, team edition.
//
// A drawer is chosen, alternating between teams. They draw their word on their phone with a
// marker and an eraser; everyone sees the drawing live. The drawer's teammates type guesses:
// the faster they get it, the more points (5 down to 1). If the timer runs out, the other team
// gets a short chance to steal. Either way, the next turn goes to the other team.
//
// Strokes travel over the fast game stream (onStream), not the state broadcast.

const fs = require('fs');
const path = require('path');

const MIN_DRAW_TEAM = 2; // the drawer plus a guesser
const STEAL_SECONDS = 20;
const STEAL_POINTS = 2;
const MAX_POINTS = 5;
const RESULT_MS = 12000;
const MAX_SEGMENTS = 6000; // per drawing, to keep memory bounded
const MAX_FEED = 12;
const DEFAULTS = { seconds: 75 };

// Parses server/data/pictionary-words.txt ("## Category" headings, one word per line).
function loadWords(file = path.join(__dirname, '..', 'data', 'pictionary-words.txt')) {
  const words = [];
  let category = 'Misc';
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('## ')) category = line.slice(3).trim();
    else if (!line.startsWith('#')) words.push({ word: line, category });
  }
  return words;
}

const WORDS = loadWords();

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawWord(state, api) {
  const seen = (api.memory.pictionarySeen = api.memory.pictionarySeen || []);
  if (!state.deck.length) {
    const seenSet = new Set(seen);
    state.deck = shuffle(WORDS.map((w, i) => i).filter((i) => !seenSet.has(i)), api.random);
    if (!state.deck.length) {
      api.memory.pictionarySeen = [];
      state.deck = shuffle(WORDS.map((w, i) => i), api.random);
    }
  }
  const i = state.deck.pop();
  api.memory.pictionarySeen.push(i);
  return i;
}

// ---------- guess checking ----------

// "The Lion King!" -> "lionking"; accents and punctuation don't matter.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Right if it matches after normalizing, ignoring a plural "s", or with a small typo.
function isRight(guess, answer) {
  const g = normalize(guess);
  const a = normalize(answer);
  if (!g) return false;
  const strip = (x) => x.replace(/(es|s)$/, '');
  if (g === a || strip(g) === strip(a)) return true;
  const allowed = a.length >= 9 ? 2 : a.length >= 5 ? 1 : 0;
  return editDistance(g, a) <= allowed;
}

// ---------- turns ----------

const connected = (api) => api.players.filter((p) => p.connected);
const playerById = (api, id) => api.players.find((p) => p.id === id);
const now = () => Date.now();
const otherTeam = (api, teamId) => api.teams.find((t) => t.id !== teamId);

// Alternate teams; within a team, whoever has drawn least recently.
function chooseDrawer(state, api) {
  const online = connected(api);
  const order = api.teams.map((t) => t.id);
  const start = state.lastTeam ? (order.indexOf(state.lastTeam) + 1) % order.length : Math.floor(api.random() * order.length);
  for (let k = 0; k < order.length; k++) {
    const pool = shuffle(online.filter((p) => p.teamId === order[(start + k) % order.length]), api.random);
    if (pool.length < MIN_DRAW_TEAM) continue;
    pool.sort((a, b) => (state.drewAt[a.id] || 0) - (state.drewAt[b.id] || 0));
    return pool[0];
  }
  return null;
}

function lineUp(state, api) {
  const drawer = chooseDrawer(state, api);
  if (!drawer) {
    state.phase = 'waiting';
    state.turn = null;
    return;
  }
  state.turnNo++;
  state.lastTeam = drawer.teamId;
  state.drewAt[drawer.id] = state.turnNo;
  state.phase = 'ready';
  state.turn = { n: state.turnNo, drawerId: drawer.id, teamId: drawer.teamId, word: drawWord(state, api), segments: [], feed: [], endsAt: null, result: null };
}

function startDrawing(state, api) {
  const t = state.turn;
  const ms = state.settings.seconds * 1000;
  t.startedAt = now();
  t.endsAt = t.startedAt + ms;
  state.phase = 'drawing';
  const n = t.n;
  api.schedule(ms, () => state.turn && state.turn.n === n && state.phase === 'drawing' && startSteal(state, api));
}

function startSteal(state, api) {
  const t = state.turn;
  state.phase = 'steal';
  t.endsAt = now() + STEAL_SECONDS * 1000;
  const n = t.n;
  api.schedule(STEAL_SECONDS * 1000, () => state.turn && state.turn.n === n && state.phase === 'steal' && finish(state, api, null));
}

// Points for the drawing team: 5 for a lightning-fast guess, down to 1 near the buzzer.
function speedPoints(t, settings) {
  const left = Math.max(0, t.endsAt - now()) / (settings.seconds * 1000);
  return Math.max(1, Math.min(MAX_POINTS, 1 + Math.floor(left * MAX_POINTS)));
}

function finish(state, api, winner) {
  const t = state.turn;
  t.result = { word: WORDS[t.word].word, at: now(), ...(winner || { teamId: null, points: 0 }) };
  if (winner) api.awardPoints(winner.teamId, winner.points, `Pictionary: ${winner.name} guessed ${WORDS[t.word].word}${winner.steal ? ' (steal)' : ''}`);
  state.phase = 'result';
  const n = t.n;
  api.schedule(RESULT_MS, () => state.turn && state.turn.n === n && state.phase === 'result' && lineUp(state, api));
}

module.exports = {
  id: 'pictionary',
  name: 'Pictionary',
  description: 'Draw your word on your phone while your team types guesses. Faster guesses score more. Run out of time and the other team can steal.',
  words: WORDS,
  isRight,

  init(api) {
    const state = { phase: 'waiting', settings: { ...DEFAULTS }, deck: [], drewAt: {}, lastTeam: null, turnNo: 0, turn: null };
    lineUp(state, api);
    return state;
  },

  onPlayerJoined(state, player, api) {
    if (state.phase === 'waiting') lineUp(state, api);
  },

  onPlayerRemoved(state, player, api) {
    const t = state.turn;
    if (!t || t.drawerId !== player.id) return;
    if (state.phase === 'ready') lineUp(state, api);
    else if (state.phase === 'drawing') startSteal(state, api);
  },

  playerAction(state, action, payload, player, api) {
    const t = state.turn;
    const isDrawer = !!t && player.id === t.drawerId;
    switch (action) {
      case 'start':
        if (state.phase === 'waiting') {
          lineUp(state, api);
          if (state.phase === 'waiting') throw new Error(`A team needs ${MIN_DRAW_TEAM} players online`);
          return;
        }
        if (state.phase !== 'ready') return;
        if (!isDrawer) throw new Error('The drawer starts the turn');
        return startDrawing(state, api);
      case 'newWord': // drawer doesn't like their word, before they start
        if (state.phase !== 'ready' || !isDrawer) throw new Error('You can only change your word before you start');
        t.word = drawWord(state, api);
        return;
      case 'guess': {
        const text = String((payload && payload.text) || '').trim().slice(0, 60);
        if (!text) return;
        const canGuess =
          (state.phase === 'drawing' && player.teamId === t.teamId && !isDrawer) ||
          (state.phase === 'steal' && player.teamId !== t.teamId);
        if (!canGuess) {
          if (isDrawer) throw new Error("You're drawing!");
          throw new Error(state.phase === 'drawing' ? "It's their team's turn to guess. Get ready to steal!" : 'Not your turn to guess');
        }
        const right = isRight(text, WORDS[t.word].word);
        t.feed.push({ name: player.name, teamId: player.teamId, text: right ? '✓ Got it!' : text, right });
        if (t.feed.length > MAX_FEED) t.feed.shift();
        if (!right) return;
        const steal = state.phase === 'steal';
        return finish(state, api, { teamId: player.teamId, name: player.name, points: steal ? STEAL_POINTS : speedPoints(t, state.settings), steal });
      }
      case 'next':
        if (state.phase === 'result') lineUp(state, api);
        return;
      default:
        throw new Error('Unknown action');
    }
  },

  hostAction(state, action, payload, api) {
    switch (action) {
      case 'start':
        if (state.phase === 'ready') return startDrawing(state, api);
        lineUp(state, api);
        if (state.phase === 'waiting') throw new Error(`A team needs ${MIN_DRAW_TEAM} players online`);
        return;
      case 'timeUp': // end drawing early and go to the steal
        if (state.phase === 'drawing') return startSteal(state, api);
        if (state.phase === 'steal') return finish(state, api, null);
        throw new Error('Nothing to end');
      case 'skip':
        if (state.phase === 'drawing' || state.phase === 'steal') throw new Error('Wait for the turn to finish');
        return lineUp(state, api);
      case 'settings': {
        const s = payload || {};
        if (s.seconds !== undefined) {
          if (![45, 60, 75, 90, 120].includes(s.seconds)) throw new Error('Bad timer');
          state.settings.seconds = s.seconds;
        }
        return;
      }
      default:
        throw new Error('Unknown action');
    }
  },

  // Strokes: { type: 'seg', n, s: strokeId, m: 'pen'|'erase', p: [[x,y], ...] } in 0-1000 coords.
  // Anyone can ask for { type: 'sync' } to get the drawing so far (after a reload or join).
  onStream(state, msg, viewer) {
    const t = state.turn;
    if (!t) return null;
    if (msg.type === 'sync') return { reply: { type: 'sync', n: t.n, segments: t.segments } };
    if (msg.type !== 'seg' || state.phase !== 'drawing' || !viewer.player || viewer.player.id !== t.drawerId || msg.n !== t.n) return null;
    const pts = Array.isArray(msg.p) ? msg.p.slice(0, 200) : [];
    if (!pts.length || pts.some((pt) => !Array.isArray(pt) || pt.length !== 2 || !pt.every((c) => Number.isFinite(c) && c >= -50 && c <= 1050))) return null;
    if (t.segments.length >= MAX_SEGMENTS) return null;
    const seg = { s: Number(msg.s) || 0, m: msg.m === 'erase' ? 'erase' : 'pen', p: pts.map(([x, y]) => [Math.round(x), Math.round(y)]) };
    t.segments.push(seg);
    return { broadcast: { type: 'seg', n: t.n, ...seg } };
  },

  view(state, viewer, api) {
    const t = state.turn;
    const me = viewer.player;
    const v = { phase: state.phase, settings: state.settings, minTeam: MIN_DRAW_TEAM, stealSeconds: STEAL_SECONDS, stealPoints: STEAL_POINTS, wordCount: WORDS.length };
    if (!t) return v;
    const drawer = playerById(api, t.drawerId);
    let role = 'watch';
    if (me && me.id === t.drawerId) role = 'drawer';
    else if (me && me.teamId === t.teamId) role = 'guesser';
    else if (me) role = 'stealer';
    Object.assign(v, {
      n: t.n,
      role,
      drawer: drawer && { id: drawer.id, name: drawer.name, teamId: drawer.teamId },
      teamId: t.teamId,
      stealTeamId: otherTeam(api, t.teamId).id,
      endsAt: t.endsAt,
      feed: t.feed,
      strokes: t.segments.length,
    });
    if (role === 'drawer' && (state.phase === 'ready' || state.phase === 'drawing')) v.word = { text: WORDS[t.word].word, category: WORDS[t.word].category };
    if (state.phase === 'result') Object.assign(v, { result: t.result, nextAt: t.result.at + RESULT_MS });
    return v;
  },
};
