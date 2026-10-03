// Taboo, team edition.
//
// Each turn a clue-giver is chosen, alternating between teams. They see a word and five
// forbidden words, and try to get their teammates to say the word before the timer runs out.
//   Got it  -> +1 point, unless the team owes a pass (then it pays one off instead)
//   Pass    -> next card, no points lost, but the team now owes one
//   Buzz    -> the other team caught a forbidden word: next card, no points
// The giver's teammates never see the word; the other team sees it so they can buzz.

const fs = require('fs');
const path = require('path');

const MIN_GIVER_TEAM = 2; // the giver plus at least one teammate to guess
const SUMMARY_MS = 20000; // turn recap stays up this long before the next giver is lined up
const BUZZ_FLASH_MS = 3000;
const DEFAULTS = { seconds: 60, rating: 'adult' };

// ---------- cards ----------

// Parses server/data/taboo-cards.txt (format documented at the top of that file).
function loadCards(file = path.join(__dirname, '..', 'data', 'taboo-cards.txt')) {
  const cards = [];
  let category = 'Misc';
  let categoryAdult = false;
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith('## ')) {
        categoryAdult = /\[21\+\]\s*$/.test(line);
        category = line.slice(3).replace(/\[21\+\]\s*$/, '').trim();
        return;
      }
      if (line.startsWith('#')) return;
      const parts = line.split('|').map((x) => x.trim());
      if (parts.length < 2) throw new Error(`taboo-cards.txt line ${i + 1}: expected "Word | forbidden, ..."`);
      cards.push({
        word: parts[0],
        taboo: parts[1].split(',').map((x) => x.trim()).filter(Boolean),
        category,
        adult: categoryAdult || parts[2] === '21+',
      });
    });
  return cards;
}

const CARDS = loadCards();

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const allowed = (state, i) => state.settings.rating === 'adult' || !CARDS[i].adult;

// Cards seen tonight are remembered on the room, so switching games and coming back
// doesn't repeat them. When everything has been seen, start over.
function drawCard(state, api) {
  const seen = (api.memory.tabooSeen = api.memory.tabooSeen || []);
  if (!state.deck.length) {
    const seenSet = new Set(seen);
    state.deck = shuffle(CARDS.map((c, i) => i).filter((i) => allowed(state, i) && !seenSet.has(i)), api.random);
    if (!state.deck.length) {
      api.memory.tabooSeen = [];
      state.deck = shuffle(CARDS.map((c, i) => i).filter((i) => allowed(state, i)), api.random);
    }
  }
  const idx = state.deck.pop();
  api.memory.tabooSeen.push(idx);
  return idx;
}

// ---------- turns ----------

const connected = (api) => api.players.filter((p) => p.connected);
const playerById = (api, id) => api.players.find((p) => p.id === id);
const now = () => Date.now();

// Alternate teams; within a team, whoever has gone longest without giving clues.
function chooseGiver(state, api) {
  const online = connected(api);
  const order = api.teams.map((t) => t.id);
  const start = state.lastGiverTeam ? (order.indexOf(state.lastGiverTeam) + 1) % order.length : Math.floor(api.random() * order.length);
  for (let k = 0; k < order.length; k++) {
    const teamId = order[(start + k) % order.length];
    const pool = shuffle(online.filter((p) => p.teamId === teamId), api.random);
    if (pool.length < MIN_GIVER_TEAM) continue;
    pool.sort((a, b) => (state.gaveAt[a.id] || 0) - (state.gaveAt[b.id] || 0));
    return pool[0];
  }
  return null;
}

// Line up the next clue-giver; they tap Start when their team is ready.
function lineUp(state, api) {
  const giver = chooseGiver(state, api);
  if (!giver) {
    state.phase = 'waiting';
    state.turn = null;
    return;
  }
  state.turnNo++;
  state.lastGiverTeam = giver.teamId;
  state.gaveAt[giver.id] = state.turnNo;
  state.phase = 'ready';
  state.turn = { n: state.turnNo, giverId: giver.id, teamId: giver.teamId, card: null, endsAt: null, owed: 0, points: 0, results: [], buzz: null };
}

function startTurn(state, api) {
  const t = state.turn;
  state.phase = 'turn';
  t.endsAt = now() + state.settings.seconds * 1000;
  t.card = drawCard(state, api);
  const n = t.n;
  api.schedule(state.settings.seconds * 1000, () => state.turn && state.turn.n === n && state.phase === 'turn' && endTurn(state, api));
}

function nextCard(state, api, result, extra = {}) {
  const t = state.turn;
  t.results.push({ card: t.card, result, ...extra });
  t.card = drawCard(state, api);
}

function endTurn(state, api) {
  const t = state.turn;
  if (t.card !== null) t.results.push({ card: t.card, result: 'timeout' });
  t.card = null;
  state.phase = 'summary';
  t.summaryAt = now();
  const n = t.n;
  api.schedule(SUMMARY_MS, () => state.turn && state.turn.n === n && state.phase === 'summary' && lineUp(state, api));
}

// Actions carry the card they were tapped on, so a late tap can't hit the next card.
function checkCard(state, payload) {
  if (state.phase !== 'turn') throw new Error('No turn in progress');
  if (!payload || payload.card !== state.turn.card) return false;
  return true;
}

function gotIt(state, api) {
  const t = state.turn;
  if (t.owed > 0) {
    t.owed--;
    nextCard(state, api, 'correct', { points: 0, paidOff: true });
  } else {
    t.points++;
    api.awardPoints(t.teamId, 1, `Taboo: ${CARDS[t.card].word}`);
    nextCard(state, api, 'correct', { points: 1 });
  }
}

module.exports = {
  id: 'taboo',
  name: 'Taboo',
  description: "Get your team to say the word without saying any of the forbidden ones. The other team is watching, with a buzzer.",
  cards: CARDS,
  loadCards,

  init(api) {
    const state = { phase: 'waiting', settings: { ...DEFAULTS }, deck: [], gaveAt: {}, lastGiverTeam: null, turnNo: 0, turn: null };
    lineUp(state, api);
    return state;
  },

  onPlayerJoined(state, player, api) {
    if (state.phase === 'waiting') lineUp(state, api);
  },

  onPlayerRemoved(state, player, api) {
    const t = state.turn;
    if (!t || t.giverId !== player.id) return;
    if (state.phase === 'turn') endTurn(state, api);
    else if (state.phase === 'ready') lineUp(state, api);
  },

  playerAction(state, action, payload, player, api) {
    const t = state.turn;
    const isGiver = !!t && player.id === t.giverId;
    switch (action) {
      case 'start':
        if (state.phase === 'waiting') {
          lineUp(state, api);
          if (state.phase === 'waiting') throw new Error(`A team needs at least ${MIN_GIVER_TEAM} players online`);
          return;
        }
        if (state.phase !== 'ready' || !isGiver) throw new Error("It's not your turn to start");
        return startTurn(state, api);
      case 'correct':
        if (!isGiver) throw new Error('Only the clue-giver can do that');
        if (checkCard(state, payload)) gotIt(state, api);
        return;
      case 'pass':
        if (!isGiver) throw new Error('Only the clue-giver can do that');
        if (checkCard(state, payload)) {
          t.owed++;
          nextCard(state, api, 'pass');
        }
        return;
      case 'buzz':
        if (!t || player.teamId === t.teamId) throw new Error('Only the other team can buzz');
        if (checkCard(state, payload)) {
          t.buzz = { name: player.name, word: CARDS[t.card].word, at: now() };
          nextCard(state, api, 'buzz', { by: player.name });
        }
        return;
      case 'next': // giver (or anyone on deck) moves on from the recap
        if (state.phase !== 'summary') return;
        return lineUp(state, api);
      default:
        throw new Error('Unknown action');
    }
  },

  hostAction(state, action, payload, api) {
    const t = state.turn;
    switch (action) {
      case 'start':
        if (state.phase === 'ready') return startTurn(state, api);
        if (state.phase === 'waiting' || state.phase === 'summary') {
          lineUp(state, api);
          if (state.phase === 'waiting') throw new Error(`A team needs at least ${MIN_GIVER_TEAM} players online`);
        }
        return;
      case 'endTurn':
        if (state.phase !== 'turn') throw new Error('No turn in progress');
        return endTurn(state, api);
      case 'skipGiver': // someone else from the next team instead
        if (state.phase !== 'ready' && state.phase !== 'summary') throw new Error('Wait for the turn to finish');
        if (t && state.phase === 'ready') state.lastGiverTeam = api.teams.find((x) => x.id !== t.teamId).id; // same team again
        return lineUp(state, api);
      case 'settings': {
        const s = payload || {};
        if (s.seconds !== undefined) {
          if (![45, 60, 90, 120].includes(s.seconds)) throw new Error('Bad turn length');
          state.settings.seconds = s.seconds;
        }
        if (s.rating !== undefined) {
          if (!['adult', 'family'].includes(s.rating)) throw new Error('Bad rating');
          state.settings.rating = s.rating;
          state.deck = []; // rebuilt from the right cards on the next draw
          if (state.phase === 'turn' && !allowed(state, t.card)) t.card = drawCard(state, api);
        }
        return;
      }
      default:
        throw new Error('Unknown action');
    }
  },

  view(state, viewer, api) {
    const t = state.turn;
    const me = viewer.player;
    const v = { phase: state.phase, settings: state.settings, minTeam: MIN_GIVER_TEAM, deckSize: CARDS.filter((c, i) => allowed(state, i)).length };
    if (!t) return v;
    const giver = playerById(api, t.giverId);
    // Who may see the card: the giver, the other team (to buzz), and a host who isn't guessing.
    let role = 'watch';
    if (me && me.id === t.giverId) role = 'giver';
    else if (me && me.teamId === t.teamId) role = 'guesser';
    else if (me) role = 'buzzer';
    else if (viewer.role === 'host') role = 'referee';
    const seesCard = role === 'giver' || role === 'buzzer' || role === 'referee';
    const last = t.results[t.results.length - 1];
    Object.assign(v, {
      n: t.n,
      role,
      giver: giver && { id: giver.id, name: giver.name, teamId: giver.teamId },
      teamId: t.teamId,
      endsAt: t.endsAt,
      owed: t.owed,
      points: t.points,
      done: t.results.length,
      buzz: t.buzz && now() - t.buzz.at < BUZZ_FLASH_MS ? t.buzz : null,
      // Finished cards are fine for everyone to see.
      last: last && { word: CARDS[last.card].word, result: last.result, by: last.by, paidOff: !!last.paidOff },
    });
    if (state.phase === 'turn' && seesCard) v.card = { id: t.card, word: CARDS[t.card].word, taboo: CARDS[t.card].taboo, category: CARDS[t.card].category };
    if (state.phase === 'summary') {
      v.results = t.results.map((r) => ({ word: CARDS[r.card].word, result: r.result, by: r.by, paidOff: !!r.paidOff }));
      v.nextAt = t.summaryAt + SUMMARY_MS;
    }
    return v;
  },
};
