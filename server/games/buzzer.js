// Buzzer round: the host asks a question out loud (or plays anything off-app), opens the
// buzzers, and the first phone to buzz gets to answer for their team. The host then marks
// the answer right (team scores) or wrong (that team is locked out and buzzers reopen).

module.exports = {
  id: 'buzzer',
  name: 'Buzzer Round',
  description: 'Host asks, first phone to buzz answers for their team. Works with any question or challenge.',

  init() {
    return { status: 'closed', points: 1, buzz: null, lockedOut: [] };
  },

  playerAction(state, action, payload, player) {
    if (action !== 'buzz') throw new Error('Unknown action');
    if (state.status !== 'open') return;
    if (state.lockedOut.includes(player.teamId)) return;
    state.status = 'buzzed';
    state.buzz = { playerId: player.id, name: player.name, teamId: player.teamId };
  },

  hostAction(state, action, payload, api) {
    switch (action) {
      case 'open':
        state.status = 'open';
        state.buzz = null;
        break;
      case 'setPoints': {
        const n = Number(payload && payload.points);
        if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('Points must be 1-100');
        state.points = n;
        break;
      }
      case 'correct':
        if (!state.buzz) throw new Error('Nobody has buzzed');
        api.awardPoints(state.buzz.teamId, state.points, `${state.buzz.name} buzzed in`);
        Object.assign(state, { status: 'closed', buzz: null, lockedOut: [] });
        break;
      case 'wrong':
        if (!state.buzz) throw new Error('Nobody has buzzed');
        state.lockedOut.push(state.buzz.teamId);
        state.buzz = null;
        // If every team is locked out the question is dead; otherwise let the rest try.
        state.status = state.lockedOut.length >= api.teams.length ? 'closed' : 'open';
        if (state.status === 'closed') state.lockedOut = [];
        break;
      case 'close':
        Object.assign(state, { status: 'closed', buzz: null, lockedOut: [] });
        break;
      default:
        throw new Error('Unknown action');
    }
  },

  view(state, viewer) {
    const v = { ...state, lockedOut: [...state.lockedOut] };
    if (viewer.player) {
      v.canBuzz = state.status === 'open' && !state.lockedOut.includes(viewer.player.teamId);
      v.iBuzzed = !!state.buzz && state.buzz.playerId === viewer.player.id;
    }
    return v;
  },

  onPlayerRemoved(state, player) {
    if (state.buzz && state.buzz.playerId === player.id) {
      state.buzz = null;
      state.status = 'open';
    }
  },
};
