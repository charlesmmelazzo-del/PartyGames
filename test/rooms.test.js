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

// A room with a 12-1 lead for team A and players on both teams.
function cashOutRoom(bPlayers = 3) {
  const room = new Room('TEST');
  const ps = Array.from({ length: bPlayers * 2 }, (_, i) => room.addPlayer(`P${i}`));
  room.addPoints('A', 12);
  room.addPoints('B', 1);
  const a = ps.filter((p) => p.teamId === 'A');
  const b = ps.filter((p) => p.teamId === 'B');
  return { room, a, b };
}

test('cash out: needs the lead and a written dare', () => {
  const room = new Room('TEST');
  room.addPoints('A', 9);
  assert.strictEqual(room.canCashOut('A'), false);
  assert.throws(() => room.requestCashOut('A', 'Do the worm', 'Ana'), /lead of 10/);
  room.addPoints('A', 1);
  assert.strictEqual(room.canCashOut('B'), false);
  assert.throws(() => room.requestCashOut('A', '  ', 'Ana'), /Write a dare/);
  assert.throws(() => room.requestCashOut('A', 'x'.repeat(121), 'Ana'), /under 120/);
  room.requestCashOut('A', '  Whole team   does the worm ', 'Ana');
  assert.strictEqual(room.cashOut.dare, 'Whole team does the worm');
  assert.strictEqual(room.cashOut.status, 'voting');
  assert.throws(() => room.requestCashOut('A', 'Another', 'Ana'), /already/);
  assert.throws(() => room.completeCashOut(), /not been accepted/);
  room.cancelCashOut();
});

test('cash out: dared team accepts by majority, then host confirms and the lead is banked', () => {
  const { room, a, b } = cashOutRoom(3);
  room.requestCashOut('A', 'Sing the national anthem', a[0].name);
  assert.throws(() => room.voteOnDare(a[1], true), /Only the dared team/);
  room.voteOnDare(b[0], true);
  assert.strictEqual(room.cashOut.status, 'voting', '1 of 3 is not a majority');
  room.voteOnDare(b[1], true);
  assert.strictEqual(room.cashOut.status, 'accepted');
  assert.match(room.announcement.text, /accepted the dare/);
  room.addPoints('A', 2); // play continues while they do it: 14-1
  room.completeCashOut();
  assert.deepStrictEqual(room.teams.map((t) => [t.score, t.cashOuts, t.banked]), [[1, 1, 13], [1, 0, 0]]);
  assert.strictEqual(room.cashOut, null);
});

test('cash out: rejection or a tie throws the dare out so the leaders can write another', () => {
  const { room, a, b } = cashOutRoom(2);
  room.requestCashOut('A', 'Lick a shoe', a[0].name);
  room.voteOnDare(b[0], true);
  room.voteOnDare(b[1], false); // 1-1 tie with everyone voted = rejected
  assert.strictEqual(room.cashOut, null);
  assert.match(room.announcement.text, /rejected the dare/);
  assert.deepStrictEqual(room.teams.map((t) => t.score), [12, 1], 'scores untouched');
  room.requestCashOut('A', 'Do 5 push-ups', a[0].name); // can try again straight away
  room.voteOnDare(b[1], true);
  room.voteOnDare(b[0], true);
  assert.strictEqual(room.cashOut.status, 'accepted');
  room.cancelCashOut();
});

test('cash out: you can change your vote until it is decided', () => {
  const { room, a, b } = cashOutRoom(3);
  room.requestCashOut('A', 'Do 5 push-ups', a[0].name);
  room.voteOnDare(b[0], false);
  room.voteOnDare(b[0], true); // changed mind
  assert.strictEqual(room.cashOut.status, 'voting');
  room.voteOnDare(b[1], true);
  assert.strictEqual(room.cashOut.status, 'accepted');
  room.cancelCashOut();
});

test('cash out: when time runs out, votes cast decide; with no votes the host decides', () => {
  const { room, a, b } = cashOutRoom(3);
  room.requestCashOut('A', 'Dance', a[0].name);
  room.voteOnDare(b[0], true);
  room.resolveDareVote(true); // what the 60s timer does
  assert.strictEqual(room.cashOut.status, 'accepted');
  room.cancelCashOut();
  room.requestCashOut('A', 'Dance again', a[0].name);
  room.resolveDareVote(true);
  assert.strictEqual(room.cashOut.status, 'voting', 'nobody voted: waits for the host');
  room.decideDare(false);
  assert.strictEqual(room.cashOut, null);
  // Only online players count toward the majority.
  b[1].connected = false;
  b[2].connected = false;
  room.requestCashOut('A', 'Dance a third time', a[0].name);
  room.voteOnDare(b[0], true);
  assert.strictEqual(room.cashOut.status, 'accepted');
  room.cancelCashOut();
});

test('cash out: snapshot shows the tally and my vote, and threshold/reset still work', () => {
  const { room, a, b } = cashOutRoom(3);
  room.requestCashOut('A', 'Do the worm', a[0].name);
  room.voteOnDare(b[0], false);
  const snap = room.snapshot({ role: 'player', playerId: b[0].id });
  assert.deepStrictEqual(snap.cashOut.tally, { accept: 0, reject: 1, eligible: 3, needed: 2 });
  assert.strictEqual(snap.cashOut.myVote, false);
  assert.ok(!('votes' in snap.cashOut), 'individual votes stay private');
  room.cancelCashOut();
  room.setCashOutLead(3);
  assert.throws(() => room.setCashOutLead(0), /1-1000/);
  room.resetScores();
  assert.ok(room.teams.every((t) => t.score === 0 && t.cashOuts === 0));
});

// A throwaway second game so switching has somewhere to go.
require('../server/games').register({
  id: 'dummy', name: 'Dummy', description: 'test only',
  init: () => ({}), playerAction() {}, hostAction() {}, view: () => ({}),
});

test('switch game: costs points, needs a big enough lead and a minimum run time', () => {
  const room = new Room('TEST', { random: () => 0 });
  room.setGame('buzzer');
  room.addPoints('A', 20);
  room.addPoints('B', 6); // A leads by 14, price is 15
  assert.match(room.switchBlocker('A'), /lead of 15/);
  room.addPoints('A', 1); // lead 15
  assert.match(room.switchBlocker('A'), /Unlocks in 10 min/);
  assert.match(room.switchBlocker('B'), /lead of 15/);
  room.game.startedAt -= 10 * 60000;
  assert.strictEqual(room.switchBlocker('A'), null);
  assert.deepStrictEqual(room.shop('A').map((i) => i.available), [true, true]);
  room.buySwitch('A', 'random', 'Ana');
  assert.notStrictEqual(room.game.id, 'buzzer');
  assert.strictEqual(room.teams[0].score, 6);
  assert.match(room.announcement.text, /spent 15 points to switch to/);
  // Fresh game: locked again even though they could otherwise afford nothing anyway.
  assert.ok(room.switchBlocker('A'));
  assert.throws(() => room.buySwitch('A', 'buzzer', 'Ana'), /lead/);
  room.clearTimers();
});

test('host random game never repeats the current one', () => {
  const room = new Room('TEST', { random: () => 0.99 });
  room.setGame('dummy');
  for (let i = 0; i < 5; i++) {
    const before = room.game.id;
    room.randomGame();
    assert.notStrictEqual(room.game.id, before);
  }
  room.clearTimers();
});
