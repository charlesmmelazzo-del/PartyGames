const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../server/rooms');
const trivia = require('../server/games/trivia');

const Q = trivia.questions;

function setup(n = 4) {
  const room = new Room('TEST');
  const players = Array.from({ length: n }, (_, i) => room.addPlayer(`P${i}`));
  room.setGame('trivia');
  const s = () => room.game.state;
  const view = (p) => room.snapshot({ role: 'player', playerId: p.id }).game.view;
  const act = (p, action, payload) => room.gameAction('player', action, payload, p);
  const chooser = () => players.find((p) => p.id === s().turn.chooserId);
  const crowd = () => players.filter((p) => p !== chooser());
  // Shown position of the right / a wrong answer for the current question.
  const rightPos = () => s().turn.order.indexOf(Q[s().board[s().turn.cell].q].correct);
  const wrongPos = () => (rightPos() + 1) % 4;
  return { room, players, s, view, act, chooser, crowd, rightPos, wrongPos };
}

test('questions: the 5 requested categories, 200+ each, 40+ per difficulty, one right answer each', () => {
  assert.deepStrictEqual(trivia.categories, ['Bible', 'History', 'Pop Music', 'Reality TV', 'Sports']);
  for (const c of trivia.categories) {
    assert.ok(Q.filter((q) => q.category === c).length >= 200, `${c} has fewer than 200 questions`);
    for (const level of [1, 2, 3, 4, 5]) {
      const n = Q.filter((q) => q.category === c && q.level === level).length;
      assert.ok(n >= 40, `${c} level ${level} has ${n}`);
    }
  }
  for (const q of Q) {
    assert.strictEqual(q.answers.length, 4, q.question);
    assert.strictEqual(new Set(q.answers).size, 4, `duplicate answers: ${q.question}`);
    assert.ok(q.correct >= 0 && q.correct < 4);
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  assert.strictEqual(new Set(Q.map((q) => norm(q.question))).size, Q.length, 'duplicate questions');
  assert.deepStrictEqual(Q.filter((q) => new Set(q.answers.map(norm)).size !== 4).map((q) => q.question), [], 'repeated answers');
});

test('board is 5 categories x 5 difficulties; chooser picks a square', () => {
  const t = setup(4);
  assert.strictEqual(t.s().phase, 'pick');
  assert.strictEqual(t.s().board.length, 25);
  assert.throws(() => t.act(t.crowd()[0], 'pick', { cell: 0 }), /not your turn/);
  t.act(t.chooser(), 'pick', { cell: 7 });
  assert.strictEqual(t.s().phase, 'question');
  assert.throws(() => t.act(t.chooser(), 'pick', { cell: 8 }), /Not time/);
  t.room.clearTimers();
});

test('chooser sees live crowd counts; the crowd and TV do not, and nobody sees the answer early', () => {
  const t = setup(5);
  t.act(t.chooser(), 'pick', { cell: 0 });
  const [a, b, c] = t.crowd();
  t.act(a, 'guess', { answer: 2 });
  t.act(b, 'guess', { answer: 2 });
  t.act(c, 'guess', { answer: 0 });
  t.act(c, 'guess', { answer: 2 }); // changed their mind
  const cv = t.view(t.chooser());
  assert.deepStrictEqual(cv.crowd, [0, 0, 3, 0]);
  assert.strictEqual(cv.crowdTotal, 3);
  assert.strictEqual(t.view(a).crowd, undefined, 'crowd must not see the split');
  assert.strictEqual(t.view(a).myGuess, 2);
  assert.strictEqual(t.room.snapshot({ role: 'tv' }).game.view.crowd, undefined);
  for (const v of [cv, t.view(a), t.room.snapshot({ role: 'tv' }).game.view]) assert.strictEqual(v.correct, undefined);
  assert.throws(() => t.act(a, 'answer', { answer: 1 }), /Only the player on the board/);
  assert.throws(() => t.act(t.chooser(), 'guess', { answer: 1 }), /Lock in/);
  t.room.clearTimers();
});

test('right answer scores the square value for the chooser team; wrong scores nothing', () => {
  const t = setup(4);
  const level = (i) => t.s().board[i].level;
  // Square 3 in category order = Bible level 4.
  t.act(t.chooser(), 'pick', { cell: 3 });
  const team1 = t.room.team(t.chooser().teamId);
  t.act(t.chooser(), 'answer', { answer: t.rightPos() });
  assert.strictEqual(t.s().phase, 'reveal');
  assert.strictEqual(team1.score, level(3));
  assert.ok(t.s().board[3].used && t.s().board[3].right);
  const v = t.view(t.players[0]);
  assert.strictEqual(v.correct, t.rightPos());
  assert.ok(v.crowdByTeam);
  t.act(t.chooser(), 'next');
  const team2 = t.room.team(t.chooser().teamId);
  assert.notStrictEqual(team2.id, team1.id, 'teams alternate');
  assert.throws(() => t.act(t.chooser(), 'pick', { cell: 3 }), /open square/);
  t.act(t.chooser(), 'pick', { cell: 4 });
  t.act(t.chooser(), 'answer', { answer: t.wrongPos() });
  assert.strictEqual(team2.score, 0);
  assert.strictEqual(t.s().board[4].right, false);
  t.room.clearTimers();
});

test('time running out counts as a miss; a used-up board deals a fresh one with new questions', () => {
  const t = setup(4);
  t.act(t.chooser(), 'pick', { cell: 0 });
  t.room.gameAction('host', 'next'); // what the timer does
  assert.strictEqual(t.s().phase, 'reveal');
  assert.strictEqual(t.s().turn.answer, null);
  const firstBoard = new Set(t.s().board.map((c) => c.q));
  for (const c of t.s().board) c.used = true;
  t.room.gameAction('host', 'next');
  assert.strictEqual(t.s().boardNo, 2);
  assert.ok(t.s().board.every((c) => !c.used));
  assert.ok(t.s().board.every((c) => !firstBoard.has(c.q)), 'second board repeats a question');
  t.room.clearTimers();
});
