const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../server/rooms');
const taboo = require('../server/games/taboo');

const CARDS = taboo.cards;

function setup(n = 4) {
  const room = new Room('TEST');
  const players = Array.from({ length: n }, (_, i) => room.addPlayer(`P${i}`));
  room.setGame('taboo');
  const s = () => room.game.state;
  const view = (p) => room.snapshot({ role: 'player', playerId: p.id }).game.view;
  const act = (p, action, payload) => room.gameAction('player', action, payload, p);
  const giver = () => players.find((p) => p.id === s().turn.giverId);
  const mates = () => players.filter((p) => p.teamId === giver().teamId && p !== giver());
  const others = () => players.filter((p) => p.teamId !== giver().teamId);
  const card = () => ({ card: s().turn.card });
  return { room, players, s, view, act, giver, mates, others, card };
}

test('deck: every card has a word and 4-5 forbidden words, no duplicates', () => {
  assert.ok(CARDS.length >= 550, `${CARDS.length} cards`);
  const bad = CARDS.filter((c) => c.taboo.length < 4 || c.taboo.length > 5 || !c.word);
  assert.deepStrictEqual(bad, []);
  const words = CARDS.map((c) => c.word.toLowerCase());
  assert.strictEqual(new Set(words).size, words.length, 'duplicate words');
  // A forbidden word must not be the word itself.
  assert.deepStrictEqual(CARDS.filter((c) => c.taboo.some((t) => t.toLowerCase() === c.word.toLowerCase())), []);
  assert.ok(CARDS.some((c) => c.adult) && CARDS.some((c) => !c.adult));
});

test('a giver is lined up when a team has 2 online, and starts the clock', () => {
  const t = setup(4);
  assert.strictEqual(t.s().phase, 'ready');
  assert.throws(() => t.act(t.others()[0], 'start'), /not your turn/);
  t.act(t.giver(), 'start');
  assert.strictEqual(t.s().phase, 'turn');
  t.room.clearTimers();
});

test('who sees the card: giver and other team yes, teammates and TV no', () => {
  const t = setup(4);
  t.act(t.giver(), 'start');
  assert.ok(t.view(t.giver()).card.word);
  assert.strictEqual(t.view(t.giver()).card.taboo.length, 5);
  assert.ok(t.view(t.others()[0]).card.word);
  assert.strictEqual(t.view(t.mates()[0]).card, undefined, 'guessers must not see the word');
  assert.strictEqual(t.room.snapshot({ role: 'tv' }).game.view.card, undefined, 'TV must not show the word');
  assert.ok(t.room.snapshot({ role: 'host' }).game.view.card, 'non-playing host referees');
  t.room.clearTimers();
});

test('got it scores, pass costs the next correct card, buzz skips with no points', () => {
  const t = setup(4);
  t.act(t.giver(), 'start');
  const team = t.room.team(t.giver().teamId);
  t.act(t.giver(), 'correct', t.card());
  assert.strictEqual(team.score, 1);
  t.act(t.giver(), 'pass', t.card());
  t.act(t.giver(), 'pass', t.card());
  assert.strictEqual(t.s().turn.owed, 2);
  t.act(t.giver(), 'correct', t.card()); // pays off a pass
  t.act(t.giver(), 'correct', t.card()); // pays off the other
  assert.strictEqual(team.score, 1, 'passes never cost points, but must be made up');
  t.act(t.giver(), 'correct', t.card());
  assert.strictEqual(team.score, 2);
  const before = t.s().turn.card;
  assert.throws(() => t.act(t.mates()[0], 'buzz', t.card()), /other team/);
  t.act(t.others()[0], 'buzz', t.card());
  assert.notStrictEqual(t.s().turn.card, before, 'buzz moves to the next card');
  assert.strictEqual(team.score, 2);
  assert.strictEqual(t.view(t.mates()[0]).buzz.name, t.others()[0].name);
  assert.deepStrictEqual(t.s().turn.results.map((r) => r.result), ['correct', 'pass', 'pass', 'correct', 'correct', 'correct', 'buzz']);
  t.room.clearTimers();
});

test('a late tap for a card that already changed is ignored', () => {
  const t = setup(4);
  t.act(t.giver(), 'start');
  const stale = t.card();
  t.act(t.others()[0], 'buzz', stale);
  t.act(t.others()[1], 'buzz', stale); // second buzz on the same card
  t.act(t.giver(), 'correct', stale); // giver tapped just after the buzz
  assert.strictEqual(t.s().turn.results.length, 1);
  assert.strictEqual(t.room.team(t.giver().teamId).score, 0);
  t.room.clearTimers();
});

test('turn ends: recap, then the other team gives clues; teams alternate', () => {
  const t = setup(6);
  const teams = [];
  for (let i = 0; i < 4; i++) {
    teams.push(t.giver().teamId);
    t.act(t.giver(), 'start');
    t.act(t.giver(), 'correct', t.card());
    t.room.gameAction('host', 'endTurn');
    assert.strictEqual(t.s().phase, 'summary');
    assert.strictEqual(t.view(t.players[0]).results.at(-1).result, 'timeout');
    t.act(t.players[0], 'next');
  }
  for (let i = 1; i < teams.length; i++) assert.notStrictEqual(teams[i], teams[i - 1]);
  t.room.clearTimers();
});

test('family rating keeps grown-up cards out; seen cards are not repeated after a game switch', () => {
  const t = setup(4);
  t.room.gameAction('host', 'settings', { rating: 'family' });
  t.act(t.giver(), 'start');
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    assert.strictEqual(CARDS[t.s().turn.card].adult, false);
    seen.add(t.s().turn.card);
    t.act(t.giver(), 'pass', t.card());
  }
  t.room.setGame('buzzer');
  t.room.setGame('taboo');
  t.room.gameAction('host', 'settings', { rating: 'family' });
  t.act(t.giver(), 'start');
  assert.ok(!seen.has(t.s().turn.card), 'card from earlier tonight came back');
  t.room.clearTimers();
});

test('your CSV deck is loaded in full and wins over built-in cards with the same word', () => {
  const yours = CARDS.filter((c) => c.source === 'yours');
  assert.strictEqual(yours.length, 300);
  const dog = CARDS.find((c) => c.word === 'Dog');
  assert.deepStrictEqual(dog, { word: 'Dog', taboo: ['Bark', 'Puppy', 'Leash', 'Fetch'], category: 'Animals', adult: false, source: 'yours' });
  // Pizza is in both decks: only your version is kept.
  const pizzas = CARDS.filter((c) => c.word.toLowerCase() === 'pizza');
  assert.strictEqual(pizzas.length, 1);
  assert.strictEqual(pizzas[0].source, 'yours');
  // Quoted CSV fields with commas work.
  assert.ok(CARDS.some((c) => c.category === 'Sports, Games & Hobbies'));
});

test('"your deck only" deals only your cards', () => {
  const t = setup(4);
  t.room.gameAction('host', 'settings', { source: 'yours' });
  assert.strictEqual(t.view(t.players[0]).deckSize, 300);
  t.act(t.giver(), 'start');
  for (let i = 0; i < 30; i++) {
    assert.strictEqual(CARDS[t.s().turn.card].source, 'yours');
    t.act(t.giver(), 'pass', t.card());
  }
  assert.throws(() => t.room.gameAction('host', 'settings', { source: 'nope' }), /card choice/);
  t.room.clearTimers();
});
