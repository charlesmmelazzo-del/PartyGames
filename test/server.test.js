// End-to-end over real sockets: a host, several phones, and a TV.
const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

let srv;
let url;
const clients = [];

test.before(async () => {
  srv = createServer();
  await new Promise((r) => srv.server.listen(0, r));
  url = `http://localhost:${srv.server.address().port}`;
});

test.after(async () => {
  clients.forEach((c) => c.close());
  await srv.close();
});

function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  c.last = null;
  c.on('state', (s) => (c.last = s));
  clients.push(c);
  return c;
}
const call = (c, ev, msg) => c.timeout(2000).emitWithAck(ev, msg);
const settle = () => new Promise((r) => setTimeout(r, 50));

test('full night: host, balanced join, lock on reconnect, buzzer, TV, end', async () => {
  const host = client();
  const { code, hostToken } = await call(host, 'host:create', {});
  assert.match(code, /^[A-Z0-9]+$/);

  const phones = [];
  for (const name of ['Ana', 'Ben', 'Cy', 'Dee', 'Eli']) {
    const c = client();
    const res = await call(c, 'player:join', { code: code.toLowerCase(), name });
    assert.ok(res.playerId, JSON.stringify(res));
    phones.push({ c, ...res });
  }
  await settle();
  const sizes = host.last.teams.map((t) => t.players.length).sort();
  assert.deepStrictEqual(sizes, [2, 3]);

  // Phone drops and reconnects with its saved session: same team, no new player.
  const ana = phones[0];
  ana.c.close();
  await settle();
  assert.strictEqual(host.last.teams.flatMap((t) => t.players).find((p) => p.id === ana.playerId).connected, false);
  const ana2 = client();
  const resumed = await call(ana2, 'session:resume', { code, playerId: ana.playerId, playerToken: ana.playerToken });
  assert.ok(resumed.ok);
  await settle();
  assert.strictEqual(ana2.last.me.teamId, ana.teamId);
  assert.strictEqual(host.last.teams.flatMap((t) => t.players).length, 5);
  phones[0] = { ...ana, c: ana2 };

  // Players can't use host powers; bad codes are rejected.
  assert.match((await call(ana2, 'host:action', { type: 'resetScores' })).error, /host/);
  assert.match((await call(client(), 'player:join', { code: 'NOPE', name: 'x' })).error, /No game/);

  const tv = client();
  await call(tv, 'tv:watch', { code });

  // Buzzer round.
  await call(host, 'host:action', { type: 'setGame', gameId: 'buzzer' });
  await call(host, 'host:action', { type: 'game', action: 'open' });
  const ben = phones[1];
  await call(ben.c, 'player:action', { action: 'buzz' });
  await settle();
  assert.strictEqual(tv.last.game.view.buzz.name, 'Ben');
  await call(host, 'host:action', { type: 'game', action: 'correct' });
  await call(host, 'host:action', { type: 'addPoints', teamId: 'A', points: 5 });
  await settle();
  const score = (t) => tv.last.teams.find((x) => x.id === t).score;
  assert.strictEqual(score(ben.teamId), ben.teamId === 'A' ? 6 : 1);

  // Cash out: a player on the leading team triggers it, the host confirms the dare.
  const leadTeam = tv.last.teams.find((t) => t.score > 0).id;
  const trailTeam = leadTeam === 'A' ? 'B' : 'A';
  const leader = phones.find((p) => p.teamId === leadTeam);
  const trailer = phones.find((p) => p.teamId === trailTeam);
  await call(host, 'host:action', { type: 'addPoints', teamId: leadTeam, points: 5 });
  await call(host, 'host:action', { type: 'addPoints', teamId: leadTeam, points: 5 });
  assert.match((await call(trailer.c, 'player:action', { action: 'cashOut', payload: { dareIndex: 0 } })).error, /lead/);
  assert.ok((await call(leader.c, 'player:action', { action: 'cashOut', payload: { dareIndex: 'random' } })).ok);
  await settle();
  assert.strictEqual(tv.last.cashOut.owedBy, trailTeam);
  await call(host, 'host:action', { type: 'cashOutDone' });
  await settle();
  const [s1, s2] = tv.last.teams.map((t) => t.score);
  assert.strictEqual(s1, s2);
  assert.strictEqual(tv.last.teams.find((t) => t.id === leadTeam).cashOuts, 1);

  // Host reconnects and is still host; host can also join a team.
  const host2 = client();
  assert.ok((await call(host2, 'session:resume', { code, hostToken })).isHost);
  const hostPlayer = await call(host2, 'player:join', { code, name: 'Host' });
  assert.ok(hostPlayer.playerId);
  await settle();
  assert.strictEqual(host2.last.isHost, true);
  assert.strictEqual(host2.last.me.name, 'Host');

  // Ending the game unlocks everyone; old sessions no longer resume.
  const closed = new Promise((r) => ana2.once('room:closed', r));
  await call(host2, 'host:action', { type: 'endGame' });
  await closed;
  const again = await call(client(), 'session:resume', { code, playerId: ana.playerId, playerToken: ana.playerToken });
  assert.strictEqual(again.error, 'gone');
});

test('static site, health and QR endpoints respond', async () => {
  const host = client();
  const { code } = await call(host, 'host:create', {});
  const page = await fetch(url + '/');
  assert.match(await page.text(), /Party Games/);
  assert.strictEqual((await fetch(`${url}/health`)).status, 200);
  const qr = await fetch(`${url}/qr/${code}.svg`);
  assert.match(await qr.text(), /<svg/);
  assert.strictEqual((await fetch(`${url}/qr/NOPE.svg`)).status, 404);
});
