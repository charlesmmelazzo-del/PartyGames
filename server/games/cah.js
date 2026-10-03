// Cards Against Humanity, team edition.
//
// Each round a picker is chosen, alternating between teams. Everyone sees the prompt; the
// picker reads it out loud. Every other player plays response card(s) from their hand (or a
// random card is played for them when the timer runs out). The picker then steps through the
// answers one at a time, in sync on every screen, reading each out loud. Finally the picker
// chooses a winner while everyone else votes for their favourite. The winning card's team
// scores, plus a bonus if the picker's choice was also the crowd's favourite.

const CARDS = require('../data/cah-cards.json');

const HAND_SIZE = 10;
const MIN_PLAYERS = 3; // picker + two answers
const RESULT_MS = 25000; // result screen stays up this long before the next round deals
// rating: 'adult' (21+ decks) or 'family' (family-friendly decks); decks: 'all' published or 'official' CAH only.
const DEFAULTS = { timer: 60, rating: 'adult', decks: 'all', winPoints: 1, bonusPoints: 1 };

const now = () => Date.now();

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Whether a deck is in play under the current rating + deck settings.
function deckInPlay(settings, packIdx) {
  const pack = CARDS.packs[packIdx];
  return pack.rating === settings.rating && (settings.decks === 'all' || pack.official);
}

function buildPiles(state, random) {
  const ok = (packIdx) => deckInPlay(state.settings, packIdx);
  const inHands = new Set(Object.values(state.hands).flat());
  state.blackPile = shuffle(CARDS.black.flatMap((c, i) => (ok(c[2]) ? [i] : [])), random);
  state.whitePile = shuffle(CARDS.white.flatMap((c, i) => (ok(c[1]) && !inHands.has(i) ? [i] : [])), random);
  state.pool = {
    decks: CARDS.packs.filter((p, i) => ok(i)).length,
    black: state.blackPile.length,
    white: state.whitePile.length + inHands.size,
  };
}

function drawWhite(state, api) {
  if (!state.whitePile.length) buildPiles(state, api.random);
  return state.whitePile.pop();
}

function drawBlack(state, api) {
  if (!state.blackPile.length) buildPiles(state, api.random);
  return state.blackPile.pop();
}

function fillHand(state, playerId, api) {
  const hand = (state.hands[playerId] = state.hands[playerId] || []);
  while (hand.length < HAND_SIZE) hand.push(drawWhite(state, api));
  return hand;
}

const connected = (api) => api.players.filter((p) => p.connected);
const playerById = (api, id) => api.players.find((p) => p.id === id);

// Alternate teams; within a team, whoever has gone longest without picking.
function choosePicker(state, api) {
  const online = connected(api);
  const teamOrder = api.teams.map((t) => t.id);
  const start = state.lastPickerTeam ? (teamOrder.indexOf(state.lastPickerTeam) + 1) % teamOrder.length : Math.floor(api.random() * teamOrder.length);
  for (let k = 0; k < teamOrder.length; k++) {
    const teamId = teamOrder[(start + k) % teamOrder.length];
    const pool = shuffle(online.filter((p) => p.teamId === teamId), api.random);
    if (!pool.length) continue;
    pool.sort((a, b) => (state.pickedAt[a.id] || 0) - (state.pickedAt[b.id] || 0));
    return pool[0];
  }
  return null;
}

function startRound(state, api) {
  if (connected(api).length < MIN_PLAYERS) {
    state.phase = 'waiting';
    state.round = null;
    return;
  }
  const picker = choosePicker(state, api);
  state.roundNo++;
  state.lastPickerTeam = picker.teamId;
  state.pickedAt[picker.id] = state.roundNo;
  const black = drawBlack(state, api);
  const timer = state.settings.timer;
  state.phase = 'submit';
  state.round = {
    n: state.roundNo,
    pickerId: picker.id,
    black,
    pick: CARDS.black[black][1],
    deadline: timer ? now() + timer * 1000 : null,
    submissions: {}, // playerId -> [whiteIdx]
    autoPlayed: [], // playerIds whose cards were played for them
    order: [], // shuffled playerIds, fixed once revealing starts
    revealIndex: 0,
    pickerChoice: null, // playerId whose submission the picker chose
    votes: {}, // voterId -> playerId of submission
    voteDeadline: null,
    result: null,
  };
  for (const p of connected(api)) if (p.id !== picker.id) fillHand(state, p.id, api);
  const n = state.roundNo;
  if (timer) api.schedule(timer * 1000, () => state.round && state.round.n === n && state.phase === 'submit' && finishSubmitting(state, api));
}

function submit(state, playerId, cardIdxs) {
  const r = state.round;
  const hand = state.hands[playerId];
  r.submissions[playerId] = cardIdxs;
  state.hands[playerId] = hand.filter((c) => !cardIdxs.includes(c));
}

// Everyone online who isn't the picker and hasn't played yet.
function waitingOn(state, api) {
  const r = state.round;
  return connected(api).filter((p) => p.id !== r.pickerId && !r.submissions[p.id]);
}

function maybeFinishSubmitting(state, api) {
  if (state.phase === 'submit' && waitingOn(state, api).length === 0 && Object.keys(state.round.submissions).length) finishSubmitting(state, api);
}

// Time's up (or everyone's in): auto-play for stragglers, then start the reveal.
function finishSubmitting(state, api) {
  const r = state.round;
  for (const p of waitingOn(state, api)) {
    const hand = fillHand(state, p.id, api);
    const picks = shuffle([...hand], api.random).slice(0, r.pick);
    submit(state, p.id, picks);
    r.autoPlayed.push(p.id);
  }
  r.order = shuffle(Object.keys(r.submissions), api.random);
  if (!r.order.length) return startRound(state, api); // nobody played: new prompt, new picker
  state.phase = 'reveal';
  r.revealIndex = 0;
}

function startJudging(state, api) {
  const r = state.round;
  state.phase = 'judge';
  const timer = state.settings.timer;
  r.voteDeadline = timer ? now() + timer * 1000 : null;
  if (timer) {
    const n = r.n;
    api.schedule(timer * 1000, () => state.round && state.round.n === n && state.phase === 'judge' && maybeFinishJudging(state, api, true));
  }
}

const voters = (state) => state.round.order; // everyone who played a card can vote

function maybeFinishJudging(state, api, timeUp = false) {
  const r = state.round;
  if (state.phase !== 'judge' || !r.pickerChoice) return;
  const allVoted = voters(state).every((id) => r.votes[id] || !(playerById(api, id) || {}).connected);
  const deadlinePassed = timeUp || (r.voteDeadline && now() >= r.voteDeadline);
  if (allVoted || deadlinePassed) finishRound(state, api);
}

function finishRound(state, api) {
  const r = state.round;
  const tally = {};
  for (const target of Object.values(r.votes)) tally[target] = (tally[target] || 0) + 1;
  const top = Math.max(0, ...Object.values(tally));
  const crowdAgrees = top > 0 && tally[r.pickerChoice] === top;
  const winner = playerById(api, r.pickerChoice);
  // The winner may have been removed by the host mid-round; then nobody scores.
  const teamId = winner ? winner.teamId : null;
  const points = teamId ? state.settings.winPoints + (crowdAgrees ? state.settings.bonusPoints : 0) : 0;
  if (teamId) {
    api.awardPoints(teamId, state.settings.winPoints, `${winner.name} won the round`);
    if (crowdAgrees && state.settings.bonusPoints) api.awardPoints(teamId, state.settings.bonusPoints, 'Crowd agreed with the picker');
  }
  r.result = { tally, crowdAgrees, teamId, points };
  r.resultAt = now();
  state.phase = 'result';
  const n = r.n;
  api.schedule(RESULT_MS, () => state.round && state.round.n === n && state.phase === 'result' && startRound(state, api));
}

module.exports = {
  id: 'cah',
  name: 'Cards Against Humanity',
  description: 'Fill in the blank with the most terrible card in your hand. Picker alternates between teams; the crowd votes too.',
  cards: CARDS,

  init(api) {
    const state = {
      phase: 'waiting',
      settings: { ...DEFAULTS },
      hands: {},
      pickedAt: {},
      lastPickerTeam: null,
      roundNo: 0,
      round: null,
    };
    buildPiles(state, api.random);
    startRound(state, api);
    return state;
  },

  onPlayerJoined(state, player, api) {
    if (state.phase === 'waiting') startRound(state, api);
    else if (state.phase === 'submit') fillHand(state, player.id, api);
  },

  onPlayerRemoved(state, player, api) {
    delete state.hands[player.id];
    const r = state.round;
    if (!r) return;
    if (r.pickerId === player.id && (state.phase === 'submit' || state.phase === 'reveal' || state.phase === 'judge')) {
      // Picker left: return cards to hands and deal a fresh round.
      for (const [pid, cards] of Object.entries(r.submissions)) if (state.hands[pid]) state.hands[pid].push(...cards);
      return startRound(state, api);
    }
    if (state.phase === 'submit') {
      delete r.submissions[player.id];
      maybeFinishSubmitting(state, api);
    }
  },

  playerAction(state, action, payload, player, api) {
    const r = state.round;
    switch (action) {
      case 'start':
        if (state.phase !== 'waiting') return;
        startRound(state, api);
        if (state.phase === 'waiting') throw new Error(`Need at least ${MIN_PLAYERS} players`);
        return;
      case 'play': {
        if (state.phase !== 'submit') throw new Error('Too late for this round');
        if (player.id === r.pickerId) throw new Error("You're the picker this round");
        if (r.submissions[player.id]) throw new Error('You already played');
        const hand = fillHand(state, player.id, api);
        const cards = (payload && payload.cards) || [];
        if (cards.length !== r.pick || new Set(cards).size !== cards.length || !cards.every((c) => hand.includes(c)))
          throw new Error(`Pick ${r.pick} card${r.pick > 1 ? 's' : ''} from your hand`);
        submit(state, player.id, cards);
        maybeFinishSubmitting(state, api);
        return;
      }
      case 'next': // picker steps through the reveal, and can deal the next round early
        if (player.id !== (r && r.pickerId)) throw new Error('Only the picker can do that');
        if (state.phase !== 'reveal' && state.phase !== 'result') return;
        return module.exports.hostAction(state, 'next', payload, api);
      case 'pick': {
        if (state.phase !== 'judge') throw new Error('Not time to pick yet');
        if (player.id !== r.pickerId) throw new Error('Only the picker chooses the winner');
        const target = payload && payload.playerId;
        if (!r.submissions[target]) throw new Error('Pick one of the answers');
        r.pickerChoice = target;
        maybeFinishJudging(state, api);
        return;
      }
      case 'vote': {
        if (state.phase !== 'judge') throw new Error('Voting is closed');
        if (player.id === r.pickerId) throw new Error('The picker picks, not votes');
        if (!r.submissions[player.id]) throw new Error('Only players who played a card this round can vote');
        const target = payload && payload.playerId;
        if (!r.submissions[target]) throw new Error('Vote for one of the answers');
        r.votes[player.id] = target;
        maybeFinishJudging(state, api);
        return;
      }
      default:
        throw new Error('Unknown action');
    }
  },

  hostAction(state, action, payload, api) {
    const r = state.round;
    switch (action) {
      case 'start':
      case 'skip': // new prompt and picker; played cards go back to their owners
        if (r) for (const [pid, cards] of Object.entries(r.submissions)) if (state.hands[pid] && state.phase === 'submit') state.hands[pid].push(...cards);
        startRound(state, api);
        if (state.phase === 'waiting') throw new Error(`Need at least ${MIN_PLAYERS} players online`);
        return;
      case 'next':
        if (state.phase === 'submit') return finishSubmitting(state, api);
        if (state.phase === 'reveal') {
          if (r.revealIndex < r.order.length - 1) r.revealIndex++;
          else startJudging(state, api);
          return;
        }
        if (state.phase === 'judge') {
          if (!r.pickerChoice) throw new Error('Waiting for the picker to choose');
          return finishRound(state, api);
        }
        if (state.phase === 'result') return startRound(state, api);
        return;
      case 'pickFor': // host stands in for a picker who wandered off
        if (state.phase !== 'judge' || !r.submissions[payload && payload.playerId]) throw new Error('Pick one of the answers');
        r.pickerChoice = payload.playerId;
        return maybeFinishJudging(state, api);
      case 'settings': {
        const s = payload || {};
        if (s.timer !== undefined) {
          if (![0, 30, 45, 60, 90, 120].includes(s.timer)) throw new Error('Bad timer');
          state.settings.timer = s.timer;
        }
        if (s.decks !== undefined && !['all', 'official'].includes(s.decks)) throw new Error('Bad deck choice');
        if (s.rating !== undefined && !['adult', 'family'].includes(s.rating)) throw new Error('Bad rating');
        if (s.decks !== undefined || s.rating !== undefined) {
          if (s.decks !== undefined) state.settings.decks = s.decks;
          if (s.rating !== undefined) state.settings.rating = s.rating;
          // Swap out cards in hands that aren't in the chosen decks any more (refilled on next view).
          for (const [pid, hand] of Object.entries(state.hands)) state.hands[pid] = hand.filter((c) => deckInPlay(state.settings, CARDS.white[c][1]));
          buildPiles(state, api.random);
          // A prompt from the old decks shouldn't linger: deal a fresh one if nobody has played yet.
          const r = state.round;
          if (r && state.phase === 'submit' && !Object.keys(r.submissions).length && !deckInPlay(state.settings, CARDS.black[r.black][2])) {
            r.black = drawBlack(state, api);
            r.pick = CARDS.black[r.black][1];
          }
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
    const card = (i) => CARDS.white[i][0];
    const v = {
      phase: state.phase,
      settings: state.settings,
      minPlayers: MIN_PLAYERS,
      online: connected(api).length,
      deckSize: { black: state.pool.black, white: state.pool.white, packs: state.pool.decks },
    };
    if (!r) return v;
    const picker = playerById(api, r.pickerId);
    Object.assign(v, {
      n: r.n,
      prompt: CARDS.black[r.black][0],
      pick: r.pick,
      picker: picker && { id: picker.id, name: picker.name, teamId: picker.teamId },
      deadline: state.phase === 'submit' ? r.deadline : state.phase === 'judge' ? r.voteDeadline : null,
      amPicker: !!me && me.id === r.pickerId,
    });

    if (state.phase === 'submit') {
      v.submittedCount = Object.keys(r.submissions).length;
      v.waitingOn = waitingOn(state, api).map((p) => p.name);
      if (me && me.id !== r.pickerId) {
        const hand = fillHand(state, me.id, api);
        v.hand = hand.map((i) => ({ id: i, text: card(i) }));
        v.played = r.submissions[me.id] ? r.submissions[me.id].map(card) : null;
      }
    }

    if (state.phase === 'reveal' || state.phase === 'judge' || state.phase === 'result') {
      // Answers are anonymous until the result; identified by position in the shuffled order.
      const shown = state.phase === 'reveal' ? r.order.slice(0, r.revealIndex + 1) : r.order;
      v.revealIndex = r.revealIndex;
      v.total = r.order.length;
      v.answers = shown.map((pid) => ({ key: pid, cards: r.submissions[pid].map(card), mine: !!me && me.id === pid }));
      if (me) v.myVote = r.votes[me.id] || null;
      v.canVote = !!me && state.phase === 'judge' && me.id !== r.pickerId && !!r.submissions[me.id];
      v.pickerChose = state.phase === 'judge' ? !!r.pickerChoice : undefined;
      if (v.amPicker || viewer.role === 'host') v.pickerChoice = r.pickerChoice;
      v.votesIn = Object.keys(r.votes).length;
      v.voterCount = voters(state).length;
    }

    if (state.phase === 'result') {
      v.result = {
        ...r.result,
        winnerKey: r.pickerChoice,
        answers: r.order.map((pid) => {
          const p = playerById(api, pid);
          return { key: pid, name: p ? p.name : '(left)', teamId: p ? p.teamId : null, votes: r.result.tally[pid] || 0, auto: r.autoPlayed.includes(pid) };
        }),
      };
      v.nextRoundAt = r.resultAt + RESULT_MS;
    }
    return v;
  },
};
