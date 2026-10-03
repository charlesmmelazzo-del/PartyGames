const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../server/rooms');
const cah = require('../server/games/cah');

const CARDS = cah.cards;

function setup(n = 5) {
  const room = new Room('TEST');
  const players = Array.from({ length: n }, (_, i) => room.addPlayer(`P${i}`));
  room.setGame('cah');
  const s = () => room.game.state;
  const view = (p) => room.snapshot({ role: 'player', playerId: p.id }).game.view;
  const act = (p, action, payload) => room.gameAction('player', action, payload, p);
  const host = (action, payload) => room.gameAction('host', action, payload);
  return { room, players, s, view, act, host };
}

// Plays a valid hand for everyone except the picker.
function playAll(t) {
  const r = t.s().round;
  for (const p of t.players) {
    if (p.id === r.pickerId) continue;
    const v = t.view(p);
    t.act(p, 'play', { cards: v.hand.slice(0, v.pick).map((c) => c.id) });
  }
}

test('card data imported from every deck', () => {
  assert.ok(CARDS.packs.length >= 200, `${CARDS.packs.length} packs`);
  assert.ok(CARDS.black.length > 6000 && CARDS.white.length > 20000);
  assert.ok(CARDS.black.every(([text, pick]) => text && pick >= 1 && pick <= 3));
});

test('waits for 3 players, then deals a round with a picker', () => {
  const room = new Room('TEST');
  const a = room.addPlayer('A');
  room.addPlayer('B');
  room.setGame('cah');
  assert.strictEqual(room.game.state.phase, 'waiting');
  room.addPlayer('C');
  assert.strictEqual(room.game.state.phase, 'submit');
  const v = room.snapshot({ role: 'player', playerId: a.id }).game.view;
  assert.ok(v.prompt);
  if (!v.amPicker) assert.strictEqual(v.hand.length, 10);
  room.clearTimers();
});

test('full round: submit, reveal one by one, picker + crowd agree = bonus', () => {
  const t = setup(5);
  const r = t.s().round;
  const picker = t.players.find((p) => p.id === r.pickerId);
  assert.throws(() => t.act(picker, 'play', { cards: [] }), /picker/);
  playAll(t);
  assert.strictEqual(t.s().phase, 'reveal');
  // Everyone sees the same answer at the same time, anonymously.
  const others = t.players.filter((p) => p !== picker);
  assert.strictEqual(t.view(others[0]).answers.length, 1);
  assert.ok(!('name' in t.view(others[0]).answers[0]));
  assert.throws(() => t.act(others[0], 'next'), /Only the picker/);
  for (let i = 0; i < 4; i++) t.act(picker, 'next');
  assert.strictEqual(t.s().phase, 'judge');
  const winnerId = others[2].id;
  t.act(picker, 'pick', { playerId: winnerId });
  // Picker's choice is hidden from voters until the end.
  assert.strictEqual(t.view(others[0]).pickerChoice, undefined);
  for (const p of others) t.act(p, 'vote', { playerId: winnerId === p.id ? winnerId : winnerId });
  assert.strictEqual(t.s().phase, 'result');
  const team = t.room.team(others[2].teamId);
  assert.strictEqual(team.score, 2); // 1 win + 1 crowd bonus
  assert.ok(t.view(others[0]).result.crowdAgrees);
  t.room.clearTimers();
});

test('no bonus when the crowd prefers a different card; voting for your own card is allowed', () => {
  const t = setup(5);
  const picker = t.players.find((p) => p.id === t.s().round.pickerId);
  const others = t.players.filter((p) => p !== picker);
  playAll(t);
  for (let i = 0; i < 4; i++) t.act(picker, 'next');
  t.act(picker, 'pick', { playerId: others[0].id });
  t.act(others[0], 'vote', { playerId: others[0].id }); // own card
  for (const p of others.slice(1)) t.act(p, 'vote', { playerId: others[1].id });
  assert.strictEqual(t.s().phase, 'result');
  assert.strictEqual(t.room.team(others[0].teamId).score, 1);
  assert.strictEqual(t.view(others[0]).result.crowdAgrees, false);
  t.room.clearTimers();
});

test('picker alternates between teams and rotates within a team', () => {
  const t = setup(6);
  const pickers = [];
  for (let i = 0; i < 6; i++) {
    pickers.push(t.players.find((p) => p.id === t.s().round.pickerId));
    t.host('skip');
  }
  for (let i = 1; i < pickers.length; i++) assert.notStrictEqual(pickers[i].teamId, pickers[i - 1].teamId);
  assert.strictEqual(new Set(pickers.map((p) => p.id)).size, 6, 'everyone gets a turn before anyone repeats');
  t.room.clearTimers();
});

test('time up: a random card is auto-played for anyone who did not submit', () => {
  const t = setup(4);
  const r = t.s().round;
  const others = t.players.filter((p) => p.id !== r.pickerId);
  const v = t.view(others[0]);
  t.act(others[0], 'play', { cards: v.hand.slice(0, v.pick).map((c) => c.id) });
  t.host('next'); // what the timer does when it fires
  assert.strictEqual(t.s().phase, 'reveal');
  assert.strictEqual(Object.keys(r.submissions).length, 3);
  assert.deepStrictEqual(r.autoPlayed.sort(), [others[1].id, others[2].id].sort());
  assert.ok(r.submissions[others[1].id].every((c) => !t.s().hands[others[1].id].includes(c)), 'auto-played cards leave the hand');
  t.room.clearTimers();
});

test('pick-2 prompts need exactly two distinct cards from your hand', () => {
  const t = setup(3);
  const r = t.s().round;
  r.black = CARDS.black.findIndex((c) => c[1] === 2);
  r.pick = 2;
  const p = t.players.find((x) => x.id !== r.pickerId);
  const hand = t.view(p).hand.map((c) => c.id);
  assert.throws(() => t.act(p, 'play', { cards: [hand[0]] }), /Pick 2/);
  assert.throws(() => t.act(p, 'play', { cards: [hand[0], hand[0]] }), /Pick 2/);
  assert.throws(() => t.act(p, 'play', { cards: [hand[0], 999999] }), /Pick 2/);
  t.act(p, 'play', { cards: [hand[0], hand[1]] });
  assert.deepStrictEqual(r.submissions[p.id], [hand[0], hand[1]]);
  t.room.clearTimers();
});

test('hands refill to 10 and official-only decks filter cards', () => {
  const t = setup(3);
  t.host('settings', { decks: 'official' });
  const p = t.players.find((x) => x.id !== t.s().round.pickerId);
  const hand = t.view(p).hand;
  assert.strictEqual(hand.length, 10);
  assert.ok(hand.every((c) => CARDS.packs[CARDS.white[c.id][1]].official));
  t.room.clearTimers();
});

test('card data has no spreadsheet leftovers or unplayable cards', () => {
  const texts = [...CARDS.black.map((c) => c[0]), ...CARDS.white.map((c) => c[0])];
  const junk = texts.filter((t) => /#REF|#N\/A|#VALUE|^(set|special|sheet|version|comments?)$|\b(added to v|removed from v)\b/i.test(t));
  assert.deepStrictEqual(junk, []);
  assert.deepStrictEqual(CARDS.white.filter(([t]) => /^\[[^\]]*\]$/.test(t)), [], 'picture-only cards');
  // Every prompt's blanks match how many cards it asks for (or it's a question with no blank).
  const bad = CARDS.black.filter(([t, pick]) => {
    const blanks = (t.match(/_/g) || []).length;
    return blanks ? blanks !== pick : false;
  });
  assert.deepStrictEqual(bad, []);
  assert.ok(CARDS.black.every(([t]) => t.replace(/[_\s.]/g, '').length > 0), 'no empty prompts');
});

test('rating: family mode deals only family decks, 21+ only adult decks', () => {
  const t = setup(3);
  const p = t.players.find((x) => x.id !== t.s().round.pickerId);
  const rating = (c) => CARDS.packs[CARDS.white[c.id][1]].rating;
  assert.strictEqual(t.s().settings.rating, 'adult');
  assert.ok(t.view(p).hand.every((c) => rating(c) === 'adult'));
  t.host('settings', { rating: 'family' });
  const v = t.view(p);
  assert.strictEqual(v.hand.length, 10);
  assert.ok(v.hand.every((c) => rating(c) === 'family'), 'hand swapped to family cards');
  assert.strictEqual(CARDS.packs[CARDS.black[t.s().round.black][2]].rating, 'family', 'prompt re-dealt');
  assert.ok(t.s().blackPile.every((i) => CARDS.packs[CARDS.black[i][2]].rating === 'family'));
  assert.ok(v.deckSize.packs >= 10 && v.deckSize.black > 500);
  // Family + official = just CAH's own Family Edition.
  t.host('settings', { decks: 'official' });
  assert.strictEqual(t.view(p).deckSize.packs, 1);
  assert.throws(() => t.host('settings', { rating: 'xxx' }), /rating/);
  t.room.clearTimers();
});

test('family decks contain no adult content', () => {
  const famPacks = new Set(CARDS.packs.flatMap((p, i) => (p.rating === 'family' ? [i] : [])));
  const words = /\b(sex|sexy|fuck\w*|shit|boob\w*|naked|(?<!root )beer|wine|drunk|porn\w*|penis|vagina|nipples?)\b/i;
  const bad = [...CARDS.black.filter((c) => famPacks.has(c[2])), ...CARDS.white.filter((c) => famPacks.has(c[1]))].filter((c) => words.test(c[0]));
  assert.deepStrictEqual(bad, []);
  assert.ok(CARDS.white.every(([t]) => !/^\*RANDOM\*/i.test(t)), 'no action cards');
});
