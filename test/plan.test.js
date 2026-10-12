// Tonight's game plan: one game all night, or a rotation that switches games on a clock.
const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../server/rooms');

const MIN = 60000;

test('rotation: starts the first game, warns a minute ahead, then moves through the list and wraps', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const room = new Room('TEST');
  room.setPlan({ type: 'rotation', games: ['taboo', 'trivia', 'buzzer'], minutes: 30 });
  assert.strictEqual(room.game.id, 'taboo');
  let plan = room.snapshot().plan;
  assert.deepStrictEqual([plan.type, plan.games, plan.minutes, plan.next.id], ['rotation', ['taboo', 'trivia', 'buzzer'], 30, 'trivia']);
  assert.strictEqual(plan.nextAt, room.game.startedAt + 30 * MIN);

  t.mock.timers.tick(29 * MIN);
  assert.strictEqual(room.game.id, 'taboo');
  assert.match(room.announcement.text, /Next up in 1 min: Trivia/);
  t.mock.timers.tick(MIN);
  assert.strictEqual(room.game.id, 'trivia');
  assert.match(room.announcement.text, /New game: Trivia/);
  t.mock.timers.tick(30 * MIN);
  assert.strictEqual(room.game.id, 'buzzer');
  t.mock.timers.tick(30 * MIN);
  assert.strictEqual(room.game.id, 'taboo', 'wraps back to the top');
  room.clearTimers();
});

test('rotation: the clock restarts whenever the game changes, by host, team or rotation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const room = new Room('TEST');
  room.setPlan({ type: 'rotation', games: ['taboo', 'trivia', 'buzzer'], minutes: 30 });
  t.mock.timers.tick(20 * MIN);
  room.hostPick('buzzer'); // host switches by hand 20 min in
  assert.strictEqual(room.snapshot().plan.next.id, 'taboo');
  t.mock.timers.tick(25 * MIN);
  assert.strictEqual(room.game.id, 'buzzer', 'a fresh 30 minutes for the new game');
  t.mock.timers.tick(5 * MIN);
  assert.strictEqual(room.game.id, 'taboo');
  room.clearTimers();
});

test('rotation: pause stops the clock; resuming gives a full interval; skip moves on now', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const room = new Room('TEST');
  room.setPlan({ type: 'rotation', games: ['taboo', 'trivia'], minutes: 30 });
  t.mock.timers.tick(10 * MIN);
  room.pauseRotation(true);
  assert.strictEqual(room.snapshot().plan.nextAt, null);
  t.mock.timers.tick(3 * 60 * MIN);
  assert.strictEqual(room.game.id, 'taboo');
  room.pauseRotation(false);
  assert.strictEqual(room.snapshot().plan.nextAt, Date.now() + 30 * MIN);
  room.rotateNow();
  assert.strictEqual(room.game.id, 'trivia');
  room.clearTimers();
});

test('rotation: shortening the interval mid-game still gives the 1-minute heads-up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const room = new Room('TEST');
  room.setPlan({ type: 'rotation', games: ['taboo', 'trivia'], minutes: 60 });
  t.mock.timers.tick(40 * MIN);
  room.setPlan({ type: 'rotation', games: ['taboo', 'trivia'], minutes: 30 }); // already 40 min in
  assert.strictEqual(room.game.id, 'taboo', 'no instant switch');
  assert.ok(room.snapshot().plan.nextAt >= Date.now() + MIN);
  t.mock.timers.tick(2000);
  assert.match(room.announcement.text, /Next up in 1 min/);
  t.mock.timers.tick(MIN);
  assert.strictEqual(room.game.id, 'trivia');
  room.clearTimers();
});

test('rotation: teams can only buy a switch to games in the rotation', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const room = new Room('TEST', { random: () => 0 });
  room.setPlan({ type: 'rotation', games: ['taboo', 'trivia'], minutes: 60 });
  room.addPoints('A', 20);
  t.mock.timers.tick(10 * MIN);
  assert.throws(() => room.buySwitch('A', 'buzzer', 'Ana'), /rotation/);
  room.buySwitch('A', 'random', 'Ana');
  assert.strictEqual(room.game.id, 'trivia');
  room.clearTimers();
});

test('one game: stays on it all night, no team switches, and a host pick becomes the game', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1e12 });
  const room = new Room('TEST');
  room.setPlan({ type: 'single', game: 'trivia' });
  assert.strictEqual(room.game.id, 'trivia');
  const plan = room.snapshot().plan;
  assert.deepStrictEqual([plan.type, plan.games, plan.nextAt, plan.next], ['single', ['trivia'], null, null]);
  t.mock.timers.tick(5 * 60 * MIN);
  assert.strictEqual(room.game.id, 'trivia');
  room.addPoints('A', 50);
  assert.match(room.switchBlocker('A'), /one game/);
  room.hostPick('taboo');
  assert.deepStrictEqual(room.snapshot().plan.games, ['taboo']);
  assert.throws(() => room.rotateNow(), /Not rotating/);
  // Switching to a rotation later picks up from there.
  room.setPlan({ type: 'rotation', games: ['taboo', 'buzzer'], minutes: 45 });
  assert.strictEqual(room.game.id, 'taboo', 'current game is in the rotation, so it keeps going');
  assert.strictEqual(room.snapshot().plan.next.id, 'buzzer');
  room.clearTimers();
});

test('plan validation', () => {
  const room = new Room('TEST');
  assert.throws(() => room.setPlan({ type: 'rotation', games: ['taboo'] }), /at least two/);
  assert.throws(() => room.setPlan({ type: 'rotation', games: ['taboo', 'nope'] }), /at least two/);
  assert.throws(() => room.setPlan({ type: 'rotation', minutes: 2 }), /5-240/);
  assert.throws(() => room.setPlan({ type: 'single', game: 'nope' }), /Pick a game/);
  assert.throws(() => room.setPlan({ type: 'party' }), /one game or a rotation/);
  assert.strictEqual(room.game, null, 'a bad plan starts nothing');
  room.setPlan({ type: 'rotation' }); // every game, default interval
  assert.strictEqual(room.snapshot().plan.minutes, 60);
  assert.ok(room.snapshot().plan.games.length >= 6);
  room.clearTimers();
});
