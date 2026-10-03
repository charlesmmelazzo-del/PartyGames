// Trivia board, team edition.
//
// A Jeopardy-style board: one column per category, one row per difficulty (worth 1-5 points).
// Each turn a player is chosen, alternating between teams. They pick a square and answer its
// 4-option question. Everyone else answers too, and the chosen player sees a live, anonymous
// count of what the crowd picked. Is the crowd helping, or is the other team trying to fool
// them? Only the chosen player's answer scores, for their team.

const fs = require('fs');
const path = require('path');

const LEVELS = [1, 2, 3, 4, 5];
const MIN_PLAYERS = 2; // the chooser plus at least one person in the crowd
const REVEAL_MS = 15000; // the answer stays up this long before the next turn
const DEFAULTS = { seconds: 30 };

// ---------- questions ----------

// Parses every .txt file in server/data/trivia/ (format documented at the top of each file).
// Files load in name order, which is the board's column order.
function loadQuestions(dir = path.join(__dirname, '..', 'data', 'trivia')) {
  const questions = [];
  const categories = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
    let category = null;
    fs.readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        const line = raw.trim();
        if (!line) return;
        if (line.startsWith('## ')) {
          category = line.slice(3).trim();
          if (!categories.includes(category)) categories.push(category);
          return;
        }
        if (line.startsWith('#')) return;
        const parts = line.split('|').map((x) => x.trim());
        const where = `${name} line ${i + 1}`;
        if (!category) throw new Error(`${where}: question before any "## Category"`);
        if (parts.length !== 6) throw new Error(`${where}: expected "level | question | 4 answers"`);
        const level = Number(parts[0]);
        if (!LEVELS.includes(level)) throw new Error(`${where}: difficulty must be 1-5`);
        const answers = parts.slice(2);
        const correct = answers.filter((a) => a.startsWith('*'));
        if (correct.length !== 1) throw new Error(`${where}: mark exactly one answer with *`);
        questions.push({
          category,
          level,
          question: parts[1],
          answers: answers.map((a) => a.replace(/^\*/, '').trim()),
          correct: answers.findIndex((a) => a.startsWith('*')),
        });
      });
  }
  return { categories, questions };
}

const { categories: CATEGORIES, questions: QUESTIONS } = loadQuestions();

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Questions asked tonight are remembered on the room, so a new board (or coming back to
// trivia after another game) brings fresh ones until a category/difficulty runs out.
function pickQuestion(category, level, api) {
  const seen = new Set((api.memory.triviaSeen = api.memory.triviaSeen || []));
  const pool = QUESTIONS.flatMap((q, i) => (q.category === category && q.level === level ? [i] : []));
  const fresh = pool.filter((i) => !seen.has(i));
  const choices = fresh.length ? fresh : pool;
  const q = choices[Math.floor(api.random() * choices.length)];
  api.memory.triviaSeen.push(q);
  return q;
}

function newBoard(state, api) {
  state.boardNo++;
  state.board = CATEGORIES.flatMap((category) =>
    LEVELS.map((level) => ({ category, level, q: pickQuestion(category, level, api), used: false, teamId: null, right: null })),
  );
}

// ---------- turns ----------

const connected = (api) => api.players.filter((p) => p.connected);
const playerById = (api, id) => api.players.find((p) => p.id === id);
const now = () => Date.now();

// Alternate teams; within a team, whoever has gone longest without a turn.
function chooseChooser(state, api) {
  const online = connected(api);
  if (online.length < MIN_PLAYERS) return null;
  const order = api.teams.map((t) => t.id);
  const start = state.lastTeam ? (order.indexOf(state.lastTeam) + 1) % order.length : Math.floor(api.random() * order.length);
  for (let k = 0; k < order.length; k++) {
    const pool = shuffle(online.filter((p) => p.teamId === order[(start + k) % order.length]), api.random);
    if (!pool.length) continue;
    pool.sort((a, b) => (state.turnAt[a.id] || 0) - (state.turnAt[b.id] || 0));
    return pool[0];
  }
  return null;
}

function nextTurn(state, api) {
  if (!state.board || state.board.every((c) => c.used)) newBoard(state, api);
  const chooser = chooseChooser(state, api);
  if (!chooser) {
    state.phase = 'waiting';
    state.turn = null;
    return;
  }
  state.turnNo++;
  state.lastTeam = chooser.teamId;
  state.turnAt[chooser.id] = state.turnNo;
  state.phase = 'pick';
  state.turn = { n: state.turnNo, chooserId: chooser.id, teamId: chooser.teamId, cell: null, order: null, endsAt: null, answer: null, crowd: {} };
}

function pickCell(state, cellIdx, api) {
  const cell = state.board[cellIdx];
  if (!cell || cell.used) throw new Error('Pick an open square');
  const t = state.turn;
  t.cell = cellIdx;
  t.order = shuffle([0, 1, 2, 3], api.random); // display order of the 4 answers
  t.endsAt = now() + state.settings.seconds * 1000;
  state.phase = 'question';
  const n = t.n;
  api.schedule(state.settings.seconds * 1000, () => state.turn && state.turn.n === n && state.phase === 'question' && reveal(state, api));
}

// Answers on the wire are positions in the shuffled order (0-3), never the stored index.
const toStored = (t, pos) => t.order[pos];
const toShown = (t, stored) => t.order.indexOf(stored);

function reveal(state, api) {
  const t = state.turn;
  const cell = state.board[t.cell];
  const q = QUESTIONS[cell.q];
  const right = t.answer !== null && toStored(t, t.answer) === q.correct;
  cell.used = true;
  cell.teamId = t.teamId;
  cell.right = right;
  if (right) {
    const chooser = playerById(api, t.chooserId);
    api.awardPoints(t.teamId, cell.level, `Trivia: ${chooser ? chooser.name : 'answer'} (${cell.category} ${cell.level})`);
  }
  t.right = right;
  t.revealAt = now();
  state.phase = 'reveal';
  const n = t.n;
  api.schedule(REVEAL_MS, () => state.turn && state.turn.n === n && state.phase === 'reveal' && nextTurn(state, api));
}

// Crowd picks per shown answer, overall and split by team (the split is only shown after the reveal).
function tally(state, api) {
  const t = state.turn;
  const all = [0, 0, 0, 0];
  const byTeam = Object.fromEntries(api.teams.map((x) => [x.id, [0, 0, 0, 0]]));
  for (const [pid, pos] of Object.entries(t.crowd)) {
    all[pos]++;
    const p = playerById(api, pid);
    if (p && byTeam[p.teamId]) byTeam[p.teamId][pos]++;
  }
  return { all, byTeam, total: Object.keys(t.crowd).length };
}

module.exports = {
  id: 'trivia',
  name: 'Trivia Board',
  description: 'Pick a category and difficulty off the board. Everyone else answers too, and you can see what the crowd picked. Trust them?',
  questions: QUESTIONS,
  categories: CATEGORIES,
  loadQuestions,

  init(api) {
    const state = { phase: 'waiting', settings: { ...DEFAULTS }, board: null, boardNo: 0, lastTeam: null, turnAt: {}, turnNo: 0, turn: null };
    nextTurn(state, api);
    return state;
  },

  onPlayerJoined(state, player, api) {
    if (state.phase === 'waiting') nextTurn(state, api);
  },

  onPlayerRemoved(state, player, api) {
    const t = state.turn;
    if (!t) return;
    delete t.crowd[player.id];
    if (t.chooserId !== player.id) return;
    if (state.phase === 'pick') nextTurn(state, api);
    else if (state.phase === 'question') reveal(state, api);
  },

  playerAction(state, action, payload, player, api) {
    const t = state.turn;
    const isChooser = !!t && player.id === t.chooserId;
    const pos = payload && Number(payload.answer);
    switch (action) {
      case 'start':
        if (state.phase !== 'waiting') return;
        nextTurn(state, api);
        if (state.phase === 'waiting') throw new Error(`Need at least ${MIN_PLAYERS} players online`);
        return;
      case 'pick':
        if (state.phase !== 'pick') throw new Error('Not time to pick a square');
        if (!isChooser) throw new Error("It's not your turn to pick");
        return pickCell(state, payload && payload.cell, api);
      case 'answer':
        if (state.phase !== 'question') throw new Error('Too late');
        if (!isChooser) throw new Error('Only the player on the board answers. Use your guess instead');
        if (![0, 1, 2, 3].includes(pos)) throw new Error('Pick an answer');
        t.answer = pos;
        return reveal(state, api);
      case 'guess': // the crowd; changeable until the reveal
        if (state.phase !== 'question') throw new Error('Too late');
        if (isChooser) throw new Error('You answer for real. Tap Lock in');
        if (![0, 1, 2, 3].includes(pos)) throw new Error('Pick an answer');
        t.crowd[player.id] = pos;
        return;
      case 'next':
        if (state.phase !== 'reveal') return;
        if (!isChooser) throw new Error('The player on the board moves on');
        return nextTurn(state, api);
      default:
        throw new Error('Unknown action');
    }
  },

  hostAction(state, action, payload, api) {
    const t = state.turn;
    switch (action) {
      case 'start':
      case 'next':
        if (state.phase === 'question') return reveal(state, api); // time's up early
        nextTurn(state, api);
        if (state.phase === 'waiting') throw new Error(`Need at least ${MIN_PLAYERS} players online`);
        return;
      case 'pickFor': // the chooser is off getting a drink
        if (state.phase !== 'pick') throw new Error('Not time to pick a square');
        return pickCell(state, payload && payload.cell, api);
      case 'skip': // someone else picks instead (same team)
        if (state.phase !== 'pick') throw new Error('Only while picking a square');
        state.lastTeam = api.teams.find((x) => x.id !== t.teamId).id;
        return nextTurn(state, api);
      case 'newBoard':
        if (state.phase === 'question') throw new Error('Finish this question first');
        newBoard(state, api);
        return nextTurn(state, api);
      case 'settings': {
        const s = payload || {};
        if (s.seconds !== undefined) {
          if (![20, 30, 45, 60].includes(s.seconds)) throw new Error('Bad timer');
          state.settings.seconds = s.seconds;
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
    const v = {
      phase: state.phase,
      settings: state.settings,
      minPlayers: MIN_PLAYERS,
      categories: CATEGORIES,
      levels: LEVELS,
      boardNo: state.boardNo,
      board: state.board && state.board.map((c) => ({ category: c.category, level: c.level, used: c.used, teamId: c.teamId, right: c.right })),
    };
    if (!t) return v;
    const chooser = playerById(api, t.chooserId);
    let role = 'watch';
    if (me && me.id === t.chooserId) role = 'chooser';
    else if (me) role = 'crowd';
    else if (viewer.role === 'host') role = 'referee';
    Object.assign(v, {
      n: t.n,
      role,
      chooser: chooser && { id: chooser.id, name: chooser.name, teamId: chooser.teamId },
      teamId: t.teamId,
    });
    if (state.phase === 'question' || state.phase === 'reveal') {
      const cell = state.board[t.cell];
      const q = QUESTIONS[cell.q];
      const counts = tally(state, api);
      Object.assign(v, {
        cell: t.cell,
        category: cell.category,
        level: cell.level,
        question: q.question,
        answers: t.order.map((i) => q.answers[i]),
        endsAt: t.endsAt,
        crowdTotal: counts.total,
        myGuess: me && t.crowd[me.id] !== undefined ? t.crowd[me.id] : null,
      });
      // The live crowd split is the chooser's advantage; the crowd itself only sees its own pick.
      if (role === 'chooser' || role === 'referee' || state.phase === 'reveal') v.crowd = counts.all;
      if (state.phase === 'reveal') {
        Object.assign(v, {
          correct: toShown(t, q.correct),
          answer: t.answer,
          right: t.right,
          crowdByTeam: counts.byTeam,
          nextAt: t.revealAt + REVEAL_MS,
        });
      }
    }
    return v;
  },
};
