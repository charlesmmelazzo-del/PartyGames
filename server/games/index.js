// Mini-game registry. Each mini-game is a module exporting:
//
//   id, name, description         - shown to the host in the game picker
//   init(api)                     - returns the game's initial state object
//   playerAction(state, action, payload, player, api)
//   hostAction(state, action, payload, api)
//   view(state, viewer, api)      - what a given screen sees; viewer = { role, player }
//   onPlayerRemoved(state, player, api)  (optional)
//
// `api` gives the game access to the room: teams, players, awardPoints(teamId, n, reason),
// schedule(ms, fn) for timers, and random(). Mutate `state` in place; the room re-broadcasts
// after every action. Throw an Error with a friendly message to reject an action.
//
// To add a game: create a file here, add it to the list below, and add a matching
// renderer in public/games/<id>.js.

const GAMES = [require('./buzzer')];

const byId = new Map(GAMES.map((g) => [g.id, g]));

module.exports = {
  get: (id) => byId.get(id),
  list: () => GAMES.map(({ id, name, description }) => ({ id, name, description })),
  // Used by tests to plug in throwaway games.
  register(def) {
    GAMES.push(def);
    byId.set(def.id, def);
  },
};
