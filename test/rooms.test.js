const test = require('node:test');
const assert = require('node:assert');
const { Room, RoomManager } = require('../server/rooms');

const counts = (room) => room.teams.map((t) => [...room.players.values()].filter((p) => p.teamId === t.id).length);

test('players are spread evenly across teams as they trickle in', () => {
  const room = new Room('TEST');
  for (let i = 0; i < 11; i++) {
    room.addPlayer(`P${i}`);
    const [a, b] = counts(room);
    assert.ok(Math.abs(a - b) <= 1, `teams uneven after ${i + 1} joins: ${a} vs ${b}`);
  }
});

test('late joiner fills the smaller team after someone is removed', () => {
  const room = new Room('TEST');
  const ps = Array.from({ length: 4 }, (_, i) => room.addPlayer(`P${i}`));
  const leaver = ps.find((p) => p.teamId === 'A');
  room.removePlayer(leaver.id);
  assert.strictEqual(room.addPlayer('Late').teamId, 'A');
});

test('team assignment is random when teams are tied', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(new Room('T').addPlayer('X').teamId);
  assert.deepStrictEqual([...seen].sort(), ['A', 'B']);
});

test('resuming with the saved token returns the same player and team', () => {
  const room = new Room('TEST');
  const p = room.addPlayer('Sam');
  assert.strictEqual(room.resumePlayer(p.id, p.token).teamId, p.teamId);
  assert.strictEqual(room.resumePlayer(p.id, 'wrong'), null);
});

test('duplicate names get a number', () => {
  const room = new Room('TEST');
  room.addPlayer('Sam');
  assert.strictEqual(room.addPlayer('sam').name, 'sam 2');
  assert.throws(() => room.addPlayer('   '), /name/);
});

test('scores accumulate across games', () => {
  const room = new Room('TEST');
  room.setGame('buzzer');
  room.addPoints('A', 3);
  room.setGame('buzzer');
  room.addPoints('A', 2);
  room.addPoints('B', 1);
  assert.deepStrictEqual(room.teams.map((t) => t.score), [5, 1]);
  assert.strictEqual(room.game.round, 2);
});

test('buzzer: first buzz wins, wrong answer locks out that team', () => {
  const room = new Room('TEST');
  const a = room.addPlayer('A1');
  const b = room.addPlayer('B1');
  const [pa, pb] = a.teamId === 'A' ? [a, b] : [b, a];
  room.setGame('buzzer');
  assert.strictEqual(room.snapshot({ role: 'player', playerId: pa.id }).game.view.canBuzz, false);
  room.gameAction('host', 'open');
  room.gameAction('player', 'buzz', null, pa);
  room.gameAction('player', 'buzz', null, pb); // too late, ignored
  assert.strictEqual(room.game.state.buzz.playerId, pa.id);
  room.gameAction('host', 'wrong');
  assert.strictEqual(room.snapshot({ role: 'player', playerId: pa.id }).game.view.canBuzz, false);
  assert.strictEqual(room.snapshot({ role: 'player', playerId: pb.id }).game.view.canBuzz, true);
  room.gameAction('player', 'buzz', null, pb);
  room.gameAction('host', 'correct');
  assert.deepStrictEqual(room.teams.map((t) => t.score), [0, 1]);
  assert.strictEqual(room.game.state.status, 'closed');
});

test('room codes are unique and lookup is case-insensitive', () => {
  const mgr = new RoomManager();
  const codes = new Set(Array.from({ length: 50 }, () => mgr.create().code));
  assert.strictEqual(codes.size, 50);
  const [first] = codes;
  assert.ok(mgr.get(` ${first.toLowerCase()} `));
});

test('cash out: needs the lead, waits for the dare, then ties and banks the lead', () => {
  const room = new Room('TEST', { random: () => 0 });
  room.addPoints('A', 9);
  assert.strictEqual(room.canCashOut('A'), false);
  assert.throws(() => room.requestCashOut('A', 0, 'Ana'), /lead of 10/);
  room.addPoints('A', 3);
  room.addPoints('B', 1); // A leads 12-1
  assert.strictEqual(room.canCashOut('B'), false);
  room.requestCashOut('A', 'random', 'Ana');
  assert.strictEqual(room.cashOut.dare, room.dares[0]);
  assert.strictEqual(room.cashOut.owedBy, 'B');
  assert.throws(() => room.requestCashOut('A', 1, 'Ana'), /already/);
  room.addPoints('A', 2); // play continues while the dare is pending: 14-1
  room.completeCashOut();
  assert.deepStrictEqual(
    room.teams.map((t) => [t.score, t.cashOuts, t.banked]),
    [[1, 1, 13], [1, 0, 0]],
  );
  assert.strictEqual(room.cashOut, null);
});

test('cash out: cancel, custom threshold and dares', () => {
  const room = new Room('TEST');
  room.setCashOutLead(3);
  room.addDare('  Do the  worm ');
  assert.strictEqual(room.dares.at(-1), 'Do the worm');
  room.addPoints('B', 3);
  room.requestCashOut('B', room.dares.length - 1, 'Host');
  room.cancelCashOut();
  assert.deepStrictEqual(room.teams.map((t) => t.score), [0, 3]);
  room.removeDare(0);
  assert.throws(() => room.setCashOutLead(0), /1-1000/);
  room.resetScores();
  assert.ok(room.teams.every((t) => t.score === 0 && t.cashOuts === 0));
});
