// Catchphrase, team edition.
//
// A random player starts with a word only they can see and gets their own team to say it
// (no saying the word, no rhymes, no first letters, no acting it out). When their team gets
// it they tap "We got it!" and the word jumps to a player on the other team. A hidden,
// random timer runs the whole time: screens pulse faster as it runs down, and whichever team
// is holding the word when the buzzer goes off loses the round. The other team scores.
//
// The end time never leaves the server; clients only get a "stage" (0-3) to pulse and tick by.

const fs = require('fs');
const path = require('path');

const MIN_PER_TEAM = 2; // a holder plus a teammate to guess, on both teams
const RESULT_MS = 12000; // the buzzer screen stays up this long before the next round lines up
const STAGES = [0, 0.5, 0.75, 0.9]; // fraction of the round at which each pulse stage starts
const LENGTHS = { short: [30, 50], normal: [45, 75], long: [60, 100] }; // hidden timer, seconds
const DEFAULTS = { length: 'normal' };

// Parses server/data/catchphrase-words.txt ("## Category" headings, one word per line).
function loadWords(file = path.join(__dirname, '..', 'data', 'catchphrase-words.txt')) {
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

// Words seen tonight are remembered on the room so they don't come back after a game switch.
function drawWord(state, api) {
  const seen = (api.memory.catchphraseSeen = api.memory.catchphraseSeen || []);
  if (!state.deck.length) {
    const seenSet = new Set(seen);
    state.deck = shuffle(WORDS.map((w, i) => i).filter((i) => !seenSet.has(i)), api.random);
    if (!state.deck.length) {
      api.memory.catchphraseSeen = [];
      state.deck = shuffle(WORDS.map((w, i) => i), api.random);
    }
  }
  const i = state.deck.pop();
  api.memory.catchphraseSeen.push(i);
  return i;
}

const connected = (api) => api.players.filter((p) => p.connected);
const playerById = (api, id) => api.players.find((p) => p.id === id);
const now = () => Date.now();

function teamsReady(api) {
  const online = connected(api);
  return api.teams.every((t) => online.filter((p) => p.teamId === t.id).length >= MIN_PER_TEAM);
}

// Next holder on a team: whoever has held it least recently (ties broken at random).
function nextOnTeam(state, teamId, api) {
  const pool = shuffle(connected(api).filter((p) => p.teamId === teamId), api.random);
  pool.sort((a, b) => (state.heldAt[a.id] || 0) - (state.heldAt[b.id] || 0));
  return pool[0] || null;
}

function giveTo(state, player, api) {
  const r = state.round;
  state.handoffs++;
  state.heldAt[player.id] = state.handoffs;
  r.holderId = player.id;
  r.teamId = player.teamId;
  r.word = drawWord(state, api);
}

// A random player starts each round.
function lineUp(state, api) {
  if (!teamsReady(api)) {
    state.phase = 'waiting';
    state.round = null;
    return;
  }
  const online = connected(api);
  const starter = online[Math.floor(api.random() * online.length)];
  state.roundNo++;
  state.phase = 'ready';
  state.round = { n: state.roundNo, holderId: null, teamId: null, word: null, stage: 0, endsAt: null, log: [], result: null };
  giveTo(state, starter, api);
}

function startRound(state, api) {
  const r = state.round;
  const [lo, hi] = LENGTHS[state.settings.length];
  const ms = Math.round((lo + api.random() * (hi - lo)) * 1000);
  r.endsAt = now() + ms;
  r.stage = 0;
  state.phase = 'playing';
  const n = r.n;
  const live = () => state.round && state.round.n === n && state.phase === 'playing';
  STAGES.forEach((frac, stage) => {
    if (stage) api.schedule(Math.round(ms * frac), () => live() && (state.round.stage = stage));
  });
  api.schedule(ms, () => live() && buzz(state, api));
}

function buzz(state, api) {
  const r = state.round;
  const loser = r.teamId;
  const winner = api.teams.find((t) => t.id !== loser);
  const holder = playerById(api, r.holderId);
  r.log.push({ word: WORDS[r.word].word, name: holder ? holder.name : '?', teamId: loser, result: 'stuck' });
  api.awardPoints(winner.id, 1, `Catchphrase: ${holder ? holder.name : 'the other team'} got stuck`);
  r.result = { loser, winner: winner.id, holder: holder ? holder.name : '?', word: WORDS[r.word].word, at: now() };
  state.phase = 'buzzed';
  const n = r.n;
  api.schedule(RESULT_MS, () => state.round && state.round.n === n && state.phase === 'buzzed' && lineUp(state, api));
}

// Actions carry the word they were tapped on, so a late double-tap can't skip the next word.
function sameWord(state, payload) {
  return !!payload && payload.word === state.round.word;
}

function gotIt(state, api) {
  const r = state.round;
  const holder = playerById(api, r.holderId);
  r.log.push({ word: WORDS[r.word].word, name: holder ? holder.name : '?', teamId: r.teamId, result: 'got' });
  const other = api.teams.find((t) => t.id !== r.teamId);
  const next = nextOnTeam(state, other.id, api);
  if (next) giveTo(state, next, api);
  else r.word = drawWord(state, api); // nobody online on the other team: keep going with a new word
}

module.exports = {
  id: 'catchphrase',
  name: 'Catchphrase',
  description: 'Get your team to say the word, then pass it to the other team. Hidden timer. Whoever is holding it at the buzzer loses.',
  words: WORDS,
  loadWords,

  init(api) {
    const state = { phase: 'waiting', settings: { ...DEFAULTS }, deck: [], heldAt: {}, handoffs: 0, roundNo: 0, round: null };
    lineUp(state, api);
    return state;
  },

  onPlayerJoined(state, player, api) {
    if (state.phase === 'waiting') lineUp(state, api);
  },

  onPlayerRemoved(state, player, api) {
    const r = state.round;
    if (!r || r.holderId !== player.id) return;
    if (state.phase === 'ready') return lineUp(state, api);
    if (state.phase === 'playing') {
      const next = nextOnTeam(state, r.teamId, api); // stays with their team: no free escape
      if (next) giveTo(state, next, api);
    }
  },

  playerAction(state, action, payload, player, api) {
    const r = state.round;
    const isHolder = !!r && player.id === r.holderId;
    switch (action) {
      case 'start':
        if (state.phase === 'waiting') {
          lineUp(state, api);
          if (state.phase === 'waiting') throw new Error(`Each team needs ${MIN_PER_TEAM} players online`);
          return;
        }
        if (state.phase !== 'ready') return;
        if (!isHolder) throw new Error('The starting player begins the round');
        return startRound(state, api);
      case 'got':
        if (state.phase !== 'playing') return;
        if (!isHolder) throw new Error("It's not in your hands");
        if (sameWord(state, payload)) gotIt(state, api);
        return;
      case 'skip': // new word, same holder, the clock keeps running
        if (state.phase !== 'playing') return;
        if (!isHolder) throw new Error("It's not in your hands");
        if (sameWord(state, payload)) {
          r.log.push({ word: WORDS[r.word].word, name: player.name, teamId: r.teamId, result: 'skipped' });
          r.word = drawWord(state, api);
        }
        return;
      case 'next':
        if (state.phase === 'buzzed') lineUp(state, api);
        return;
      default:
        throw new Error('Unknown action');
    }
  },

  hostAction(state, action, payload, api) {
    switch (action) {
      case 'start':
        if (state.phase === 'ready') return startRound(state, api);
        lineUp(state, api);
        if (state.phase === 'waiting') throw new Error(`Each team needs ${MIN_PER_TEAM} players online`);
        return;
      case 'pass': // the holder wandered off: hand it to a teammate
        if (state.phase !== 'playing' && state.phase !== 'ready') throw new Error('No round in progress');
        {
          const next = nextOnTeam(state, state.round.teamId, api);
          if (next) giveTo(state, next, api);
        }
        return;
      case 'buzz': // end the round right now
        if (state.phase !== 'playing') throw new Error('No round in progress');
        return buzz(state, api);
      case 'settings': {
        const s = payload || {};
        if (s.length !== undefined) {
          if (!LENGTHS[s.length]) throw new Error('Bad round length');
          state.settings.length = s.length;
        }
        return;
      }
      default:
        throw new Error('Unknown action');
    }
  },

  view(state, viewer, api) {
    const r = state.round;
    const me = viewer.player;
    const v = { phase: state.phase, settings: state.settings, minPerTeam: MIN_PER_TEAM, wordCount: WORDS.length };
    if (!r) return v;
    const holder = playerById(api, r.holderId);
    let role = 'watch';
    if (me && me.id === r.holderId) role = 'holder';
    else if (me && me.teamId === r.teamId) role = 'guesser';
    else if (me) role = 'waiting';
    Object.assign(v, {
      n: r.n,
      role,
      holder: holder && { id: holder.id, name: holder.name, teamId: holder.teamId },
      teamId: r.teamId,
      stage: r.stage,
      passes: r.log.filter((l) => l.result === 'got').length,
    });
    // Only the holder ever sees the live word.
    if (role === 'holder' && state.phase === 'playing') v.word = { id: r.word, text: WORDS[r.word].word, category: WORDS[r.word].category };
    if (state.phase === 'buzzed') {
      v.result = r.result;
      v.log = r.log;
      v.nextAt = r.result.at + RESULT_MS;
    }
    return v;
  },
};
