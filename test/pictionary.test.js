const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../server/rooms');
const pictionary = require('../server/games/pictionary');

function setup(n = 4) {
  const room = new Room('TEST');
  const players = Array.from({ length: n }, (_, i) => room.addPlayer(`P${i}`));
  room.setGame('pictionary');
  const s = () => room.game.state;
  const view = (p) => room.snapshot({ role: 'player', playerId: p.id }).game.view;
  const act = (p, action, payload) => room.gameAction('player', action, payload, p);
  const drawer = () => players.find((p) => p.id === s().turn.drawerId);
  const mates = () => players.filter((p) => p.teamId === drawer().teamId && p !== drawer());
  const others = () => players.filter((p) => p.teamId !== drawer().teamId);
  const answer = () => pictionary.words[s().turn.word].word;
  return { room, players, s, view, act, drawer, mates, others, answer };
}

test('word list: about 1,000 drawable words, no duplicates', () => {
  const w = pictionary.words.map((x) => x.word.toLowerCase());
  assert.ok(w.length >= 900, `${w.length}`);
  assert.strictEqual(new Set(w).size, w.length);
});

test('guess matching forgives case, "the", plurals, punctuation and small typos', () => {
  const ok = pictionary.isRight;
  assert.ok(ok('the lion king!', 'The Lion King'));
  assert.ok(ok('BUTTERFLY', 'butterfly'));
  assert.ok(ok('snowflakes', 'snowflake'));
  assert.ok(ok('elephnt', 'elephant'), 'one typo on a long word');
  assert.ok(!ok('elefant', 'elephant'), 'two typos on an 8-letter word is too many');
  assert.ok(ok('swiming pool', 'swimming pool'));
  assert.ok(!ok('cat', 'car'), 'no typo allowance on short words');
  assert.ok(!ok('dog', 'snowflake'));
  assert.ok(!ok('', 'snowflake'));
});

test('only the drawer sees the word; only teammates guess while drawing', () => {
  const t = setup(4);
  assert.strictEqual(t.s().phase, 'ready');
  assert.ok(t.view(t.drawer()).word.text);
  for (const p of t.players.filter((x) => x !== t.drawer())) assert.strictEqual(t.view(p).word, undefined);
  t.act(t.drawer(), 'start');
  assert.throws(() => t.act(t.drawer(), 'guess', { text: 'x' }), /drawing/);
  assert.throws(() => t.act(t.others()[0], 'guess', { text: 'x' }), /steal/);
  t.act(t.mates()[0], 'guess', { text: 'definitely wrong guess' });
  assert.strictEqual(t.view(t.others()[0]).feed[0].text, 'definitely wrong guess', 'everyone sees wrong guesses');
  t.room.clearTimers();
});

test('a fast right guess scores 5; the next turn goes to the other team', () => {
  const t = setup(4);
  const team1 = t.drawer().teamId;
  t.act(t.drawer(), 'start');
  t.act(t.mates()[0], 'guess', { text: t.answer() });
  assert.strictEqual(t.s().phase, 'result');
  assert.strictEqual(t.room.team(team1).score, 5);
  assert.strictEqual(t.view(t.players[0]).result.points, 5);
  t.act(t.players[0], 'next');
  assert.notStrictEqual(t.drawer().teamId, team1);
  t.room.clearTimers();
});

test('slower guesses score less (down to 1)', () => {
  const t = setup(4);
  t.act(t.drawer(), 'start');
  const team = t.room.team(t.drawer().teamId);
  t.s().turn.endsAt = Date.now() + 2000; // pretend most of the time is gone
  t.act(t.mates()[0], 'guess', { text: t.answer() });
  assert.strictEqual(team.score, 1);
  t.room.clearTimers();
});

test('time up: the other team can steal for 2; the drawing team can no longer guess', () => {
  const t = setup(4);
  t.act(t.drawer(), 'start');
  const thief = t.others()[0];
  t.room.gameAction('host', 'timeUp'); // what the timer does
  assert.strictEqual(t.s().phase, 'steal');
  assert.throws(() => t.act(t.mates()[0], 'guess', { text: t.answer() }), /Not your turn/);
  t.act(thief, 'guess', { text: t.answer().toUpperCase() });
  assert.strictEqual(t.room.team(thief.teamId).score, 2);
  assert.ok(t.view(thief).result.steal);
  t.room.clearTimers();
});

test('nobody gets it: no points, turn still moves on', () => {
  const t = setup(4);
  t.act(t.drawer(), 'start');
  t.room.gameAction('host', 'timeUp');
  t.room.gameAction('host', 'timeUp');
  assert.strictEqual(t.s().phase, 'result');
  assert.ok(t.room.teams.every((x) => x.score === 0));
  t.room.clearTimers();
});

test('strokes: only the drawer can draw, bad data is dropped, late joiners can sync', () => {
  const t = setup(4);
  t.act(t.drawer(), 'start');
  const n = t.s().turn.n;
  const seg = { type: 'seg', n, s: 1, m: 'pen', p: [[10, 10], [200, 220]] };
  const out = t.room.gameStream(seg, { role: 'player', playerId: t.drawer().id });
  assert.deepStrictEqual(out.broadcast.p, [[10, 10], [200, 220]]);
  assert.strictEqual(t.room.gameStream(seg, { role: 'player', playerId: t.mates()[0].id }), null, 'guessers cannot draw');
  assert.strictEqual(t.room.gameStream({ ...seg, p: [['x', 1]] }, { role: 'player', playerId: t.drawer().id }), null);
  assert.strictEqual(t.room.gameStream({ ...seg, n: n + 1 }, { role: 'player', playerId: t.drawer().id }), null, 'stale turn');
  const sync = t.room.gameStream({ type: 'sync' }, { role: 'tv' });
  assert.strictEqual(sync.reply.segments.length, 1);
  t.room.clearTimers();
});
