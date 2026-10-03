const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../server/rooms');
const catchphrase = require('../server/games/catchphrase');

const WORDS = catchphrase.words;

function setup(n = 4, random) {
  const room = new Room('TEST', random ? { random } : {});
  const players = Array.from({ length: n }, (_, i) => room.addPlayer(`P${i}`));
  room.setGame('catchphrase');
  const s = () => room.game.state;
  const view = (p) => room.snapshot({ role: 'player', playerId: p.id }).game.view;
  const act = (p, action, payload) => room.gameAction('player', action, payload, p);
  const holder = () => players.find((p) => p.id === s().round.holderId);
  const word = () => ({ word: s().round.word });
  return { room, players, s, view, act, holder, word };
}

test('word list: 2,000+ clean, unique words', () => {
  assert.ok(WORDS.length >= 2000, `${WORDS.length} words`);
  const keys = WORDS.map((w) => w.word.toLowerCase().replace(/^the /, ''));
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate words');
  assert.deepStrictEqual(WORDS.filter((w) => /\\x|[\x00-\x1f]|^["']|["']$/.test(w.word)), [], 'junk characters');
});

test('needs 2 players online per team; a random player starts', () => {
  const room = new Room('TEST');
  const ps = Array.from({ length: 3 }, (_, i) => room.addPlayer(`P${i}`));
  room.setGame('catchphrase');
  assert.strictEqual(room.game.state.phase, 'waiting');
  room.addPlayer('P3');
  assert.strictEqual(room.game.state.phase, 'ready');
  assert.ok(ps.concat([...room.players.values()]).some((p) => p.id === room.game.state.round.holderId));
  room.clearTimers();
});

test('only the holder sees the word; the end time is never sent to anyone', () => {
  const t = setup(4);
  t.act(t.holder(), 'start');
  assert.ok(t.view(t.holder()).word.text);
  for (const p of t.players.filter((x) => x !== t.holder())) assert.strictEqual(t.view(p).word, undefined);
  for (const snap of [t.room.snapshot({ role: 'tv' }), t.room.snapshot({ role: 'host' }), t.room.snapshot({ role: 'player', playerId: t.holder().id })])
    assert.ok(!JSON.stringify(snap).includes(String(t.s().round.endsAt)), 'end time leaked');
  t.room.clearTimers();
});

test('"we got it" passes to the other team with a new word; skip keeps it on the same holder', () => {
  const t = setup(6);
  t.act(t.holder(), 'start');
  const first = t.holder();
  const w1 = t.s().round.word;
  t.act(first, 'skip', t.word());
  assert.strictEqual(t.holder(), first);
  assert.notStrictEqual(t.s().round.word, w1);
  t.act(first, 'got', t.word());
  const second = t.holder();
  assert.notStrictEqual(second.teamId, first.teamId, 'goes to the other team');
  assert.throws(() => t.act(first, 'got', t.word()), /not in your hands/);
  // A stale double-tap for the old word is ignored.
  t.act(second, 'got', { word: w1 });
  assert.strictEqual(t.holder(), second);
  // Passing rotates through the other team's players.
  const holders = [second];
  for (let i = 0; i < 5; i++) {
    t.act(t.holder(), 'got', t.word());
    holders.push(t.holder());
  }
  const teamA = holders.filter((p) => p.teamId === second.teamId);
  assert.strictEqual(new Set(teamA.map((p) => p.id)).size, teamA.length, 'same player got it twice before teammates');
  t.room.clearTimers();
});

test('buzzer: the team holding it loses, the other team scores 1', () => {
  const t = setup(4);
  t.act(t.holder(), 'start');
  t.act(t.holder(), 'got', t.word());
  const stuck = t.holder();
  t.room.gameAction('host', 'buzz'); // what the hidden timer does
  assert.strictEqual(t.s().phase, 'buzzed');
  const other = t.room.teams.find((x) => x.id !== stuck.teamId);
  assert.strictEqual(other.score, 1);
  assert.strictEqual(t.room.team(stuck.teamId).score, 0);
  const v = t.view(t.players[0]);
  assert.strictEqual(v.result.loser, stuck.teamId);
  assert.deepStrictEqual(v.log.map((l) => l.result), ['got', 'stuck']);
  t.act(t.players[0], 'next');
  assert.strictEqual(t.s().phase, 'ready');
  t.room.clearTimers();
});

test('hidden timer: random length within the setting, with speed-up stages before the buzzer', async () => {
  const t = setup(4, () => 0); // shortest possible round
  t.room.gameAction('host', 'settings', { length: 'short' });
  const before = Date.now();
  t.act(t.holder(), 'start');
  const len = t.s().round.endsAt - before;
  assert.ok(len >= 30000 && len <= 30100, `round length ${len}`);
  assert.strictEqual(t.s().round.stage, 0);
  assert.throws(() => t.room.gameAction('host', 'settings', { length: 'forever' }), /round length/);
  t.room.clearTimers();
});
