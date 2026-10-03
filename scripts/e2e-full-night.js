// Plays a whole night with virtual phones in a real browser: every game, plus joining,
// team locks, the team shop (cash out + dare vote, buying a game switch) and the TV.
//
//   node scripts/e2e-full-night.js                      # starts a local server
//   BASE_URL=https://your-app.up.railway.app node scripts/e2e-full-night.js
//   PHONES=6 HOST_PLAYS=1 LATE_JOIN=1 RELOADS=1 node scripts/e2e-full-night.js
//
// Needs Chromium (set CHROMIUM_PATH if it isn't at /opt/pw-browsers/chromium).
const { chromium } = require('playwright-core');
const path = require('path');

const PHONES = Number(process.env.PHONES || 4);
const HOST_PLAYS = process.env.HOST_PLAYS === '1';
const LATE_JOIN = process.env.LATE_JOIN === '1';
const RELOADS = process.env.RELOADS === '1';
const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo'];

const results = [];
let failures = 0;
function check(ok, label, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
  console.log(results[results.length - 1]);
}

async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function main() {
  let base = process.env.BASE_URL;
  let srv;
  if (!base) {
    const { createServer } = require(path.join(__dirname, '..', 'server'));
    srv = createServer();
    await new Promise((r) => srv.server.listen(0, r));
    base = `http://localhost:${srv.server.address().port}`;
  }
  console.log(`Testing ${base} with ${PHONES} phones${HOST_PLAYS ? ' (host plays too)' : ''}${LATE_JOIN ? ', late joiner' : ''}${RELOADS ? ', reloads' : ''}\n`);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const pageErrors = [];
  async function device(name, viewport = { width: 390, height: 844 }) {
    const ctx = await browser.newContext({ viewport, hasTouch: true });
    const p = await ctx.newPage();
    p.n = name;
    p.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
    p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? name : undefined));
    return p;
  }
  const scores = async (tv) => tv.$$eval('.score .points', (e) => e.map((x) => Number(x.textContent)));
  const total = (s) => s.reduce((a, b) => a + b, 0);

  try {
    // ---------- setup: host, phones, TV ----------
    const host = await device('Host');
    await host.goto(base);
    await host.click('#create');
    const code = (await (await host.waitForSelector('.code')).textContent()).trim();
    check(/^[A-Z0-9]+$/.test(code), 'host gets a code word', code);

    const phones = [];
    async function join(name) {
      const p = await device(name);
      await p.goto(`${base}/?code=${code}`);
      await p.fill('input[name=name]', name);
      await p.click('form button');
      await p.waitForSelector('.team-banner, .mini-head');
      phones.push(p);
      return p;
    }
    for (const name of NAMES.slice(0, PHONES)) await join(name);
    if (HOST_PLAYS) {
      await host.click('#host-join');
      await host.waitForSelector('[data-tab="play"]');
      host.isPlayer = true;
      phones.push(host);
    }
    const tv = await device('TV', { width: 1280, height: 720 });
    await tv.goto(`${base}/?tv=${code}`);
    await tv.waitForSelector('.tv');

    const sizes = await tv.$$eval('.score .muted.small', (e) => e.map((x) => parseInt(x.textContent, 10)));
    check(Math.abs(sizes[0] - sizes[1]) <= 1, 'teams are balanced', sizes.join(' vs '));

    // Team of each phone, read from its own screen.
    const teamOf = async (p) => {
      if (p.isPlayer) await asPlayer(p);
      return (await p.textContent('.team-banner .team-name, .team-pill')).replace(/🔒|·.*$/g, '').trim();
    };
    async function asPlayer(p) {
      if (p.isPlayer && (await p.$('[data-tab="play"]:not(.active)'))) await p.click('[data-tab="play"]');
    }
    async function asHost() {
      if (await host.$('[data-tab="host"]:not(.active)')) await host.click('[data-tab="host"]');
    }
    for (const p of phones) p.team = await teamOf(p);

    // Team lock survives a reload.
    const locked = phones[0];
    await locked.reload();
    await locked.waitForSelector('.team-banner, .mini-head');
    check((await teamOf(locked)) === locked.team, 'phone stays on its team after reload', locked.team);

    async function startGame(name) {
      await asHost();
      await host.locator('.game-pick', { hasText: name }).locator('button').click();
      await until(() => tv.$('.game-header strong, .mini-game'), `${name} on TV`);
    }
    // Every phone, switched to its player screen, that matches a selector.
    async function phonesWith(sel) {
      const out = [];
      for (const p of phones) {
        await asPlayer(p);
        if (await p.$(sel)) out.push(p);
      }
      return out;
    }
    const one = async (sel, label, ms) => (await until(async () => (await phonesWith(sel))[0], label, ms));

    // ---------- Cards Against Humanity ----------
    {
      await startGame('Cards Against Humanity');
      const before = total(await scores(tv));
      const picker = await one('.picker-badge', 'CAH picker');
      for (const p of phones.filter((x) => x !== picker)) {
        await until(() => p.$('.hand'), `${p.n} hand`);
        const pick = (await p.$('.pick-n')) ? Number((await p.textContent('.pick-n')).replace(/\D/g, '')) : 1;
        for (let i = 0; i < pick; i++) await p.click(`.white-card >> nth=${i}`);
        await p.click('.submit-bar button');
      }
      await until(() => picker.$('.reveal-count'), 'CAH reveal');
      check(!!(await tv.$('.reveal-count')), 'CAH: reveal shows on TV');
      while (await picker.$('.reveal-count')) {
        await picker.click('.instruct + button');
        await picker.waitForTimeout(120);
      }
      await until(() => picker.$('button.answer'), 'CAH judging');
      await picker.click('button.answer >> nth=0');
      for (const p of phones.filter((x) => x !== picker)) if (await p.$('button.answer')) await p.click('button.answer >> nth=0');
      await until(() => tv.$('.result-win'), 'CAH result');
      const gained = total(await scores(tv)) - before;
      check(gained >= 1 && gained <= 2, 'CAH: a round is judged and scored', `+${gained}`);
    }

    // ---------- Taboo ----------
    {
      await startGame('Taboo');
      const before = total(await scores(tv));
      const giver = await one('.picker-badge', 'Taboo giver');
      await giver.click('button:text-is("Start the clock")');
      await until(() => giver.$('.taboo-card'), 'Taboo card');
      const word = (await giver.textContent('.taboo-word')).trim();
      const mates = phones.filter((p) => p !== giver && p.team === giver.team);
      const rivals = phones.filter((p) => p.team !== giver.team);
      await until(() => mates[0].$('.guess-box'), 'Taboo guesser screen');
      check(!(await mates[0].$('.taboo-word')) && !(await tv.$('.taboo-word')), 'Taboo: teammates and TV never see the word', word);
      check(!!(await rivals[0].$('.taboo-word')), 'Taboo: the other team sees the word to buzz');
      await giver.click('button:text-is("✓ Got it")');
      await giver.waitForTimeout(150);
      await giver.click('button:text-is("Pass ↷")');
      await giver.waitForTimeout(150);
      await rivals[0].click('.taboo-buzz');
      await until(() => mates[0].$('.buzz-flash'), 'buzz flash');
      await asHost();
      await host.click('button:text-is("End turn now")');
      await until(() => tv.$('.taboo-results'), 'Taboo recap');
      const recap = await tv.$$eval('.taboo-results li', (e) => e.map((x) => x.className));
      check(recap.includes('r-correct') && recap.includes('r-pass') && recap.includes('r-buzz'), 'Taboo: recap shows got / passed / buzzed');
      check(total(await scores(tv)) - before === 1, 'Taboo: one point for the one card they got');
    }

    // ---------- Trivia ----------
    {
      await startGame('Trivia Board');
      const before = total(await scores(tv));
      const chooser = await one('.picker-badge', 'Trivia chooser');
      await chooser.click('.tb-cell.open >> nth=7');
      await until(() => chooser.$('.tq-question'), 'Trivia question');
      const crowd = phones.filter((p) => p !== chooser);
      for (const p of crowd) {
        await until(() => p.$('.tq-opt'), `${p.n} options`);
        await p.click('.tq-opt >> nth=1');
      }
      const counts = await until(async () => {
        const c = await chooser.$$eval('.tq-count', (e) => e.map((x) => Number(x.textContent)));
        return c[1] === crowd.length && c;
      }, 'crowd counts on chooser');
      check(counts[1] === crowd.length, 'Trivia: chooser sees live crowd counts', counts.join('/'));
      check((await crowd[0].$$('.tq-count')).length === 0 && (await tv.$$('.tq-count')).length === 0, 'Trivia: crowd and TV do not see the counts');
      await chooser.click('.tq-opt >> nth=1');
      await chooser.click('.submit-bar button');
      await until(() => tv.$('.crowd-split'), 'Trivia reveal');
      const gained = total(await scores(tv)) - before;
      check(gained >= 0 && gained <= 5, 'Trivia: answer revealed with per-team crowd split', `+${gained}`);
    }

    // ---------- Catchphrase ----------
    {
      await startGame('Catchphrase');
      const before = await scores(tv);
      const starter = await one('.picker-badge', 'Catchphrase starter');
      await starter.click('button:text-is("Start the round")');
      await until(() => starter.$('.cp-card'), 'Catchphrase word');
      check((await phonesWith('.cp-word')).length === 1 && !(await tv.$('.cp-word')), 'Catchphrase: only the holder sees the word');
      const handoffs = [starter.team];
      for (let i = 0; i < 2; i++) {
        const holder = await one('.cp-card', 'holder');
        await holder.click('button:text-is("✓ We got it!")');
        const next = await until(async () => {
          const h = (await phonesWith('.cp-card'))[0];
          return h && h !== holder && h;
        }, 'next holder');
        handoffs.push(next.team);
      }
      check(handoffs[0] !== handoffs[1] && handoffs[1] !== handoffs[2], 'Catchphrase: "We got it" passes to the other team', handoffs.join(' -> '));
      check(!!(await tv.$('.cp-pulse')), 'Catchphrase: screens pulse');
      const stuckTeam = handoffs[2];
      await asHost();
      await host.click('button:text-is("Buzz now")');
      await until(() => tv.$('.cp-buzz'), 'buzzer');
      const after = await scores(tv);
      const teams = await tv.$$eval('.score .team-name', (e) => e.map((x) => x.textContent.trim()));
      const winnerIdx = teams.findIndex((t) => t !== stuckTeam);
      check(after[winnerIdx] - before[winnerIdx] === 1 && total(after) - total(before) === 1, 'Catchphrase: team left holding it loses, other team +1');
    }

    // ---------- Pictionary ----------
    {
      await startGame('Pictionary');
      const before = total(await scores(tv));
      const drawer = await one('.pic-word.big', 'Pictionary drawer');
      const word = (await drawer.textContent('.pic-word.big b')).trim();
      await drawer.click('button:text-is("Start drawing")');
      await until(() => drawer.$('.pic-canvas.drawable'), 'canvas');
      const box = await drawer.locator('.pic-canvas').boundingBox();
      await drawer.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await drawer.mouse.down();
      await drawer.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 20 });
      await drawer.mouse.up();
      const mate = phones.find((p) => p !== drawer && p.team === drawer.team);
      const ink = (p) =>
        p.evaluate(() => {
          const c = document.querySelector('.pic-canvas');
          const d = c.getContext('2d').getImageData(0, 0, 1000, 1000).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 16) if (d[i] < 100) n++;
          return n;
        });
      await until(async () => (await ink(mate)) > 100 && (await ink(tv)) > 100, 'strokes on other screens');
      check(true, 'Pictionary: drawing shows up live on teammates and TV');
      if (RELOADS) {
        await tv.reload();
        await until(async () => (await tv.$('.pic-canvas')) && (await ink(tv)) > 100, 'TV resync');
        check(true, 'Pictionary: TV reloaded mid-drawing and caught up');
      }
      await mate.fill('#pic-guess', word.toUpperCase());
      await mate.press('#pic-guess', 'Enter');
      await until(() => tv.$('.result-win'), 'Pictionary result');
      check(total(await scores(tv)) - before === 5, 'Pictionary: fast correct guess scores 5');
    }

    // ---------- Buzzer Round ----------
    {
      await startGame('Buzzer Round');
      const before = total(await scores(tv));
      await asHost();
      await host.click('button:text-is("Open buzzers")');
      const first = phones.find((p) => p !== host);
      await until(() => first.$('.buzzer:not(.off)'), 'buzzers open');
      await first.click('.buzzer');
      await until(() => tv.$('.buzz-result'), 'buzz on TV');
      await asHost();
      await host.click('button:has-text("Correct")');
      await until(async () => total(await scores(tv)) === before + 1, 'buzzer point');
      check(true, 'Buzzer: first phone to buzz answers, host awards the point');
    }

    // ---------- late joiner ----------
    if (LATE_JOIN) {
      const late = await join('Late');
      late.team = await teamOf(late);
      const sizes2 = await tv.$$eval('.score .muted.small', (e) => e.map((x) => parseInt(x.textContent, 10)));
      check(Math.abs(sizes2[0] - sizes2[1]) <= 1, 'late joiner lands on the smaller team', sizes2.join(' vs '));
    }

    // ---------- team shop: cash out with a written dare, then buy a game switch ----------
    {
      await asHost();
      const s = await scores(tv);
      const teams = await tv.$$eval('.score .team-name', (e) => e.map((x) => x.textContent.trim()));
      const lead = teams[s[0] >= s[1] ? 0 : 1];
      const plus5 = host.locator('.row').filter({ hasText: lead }).locator('button:text-is("+5")').first();
      for (let i = 0; i < 4; i++) {
        await plus5.click();
        await host.waitForTimeout(100);
      }
      const leader = phones.find((p) => p.team === lead && p !== host);
      await asPlayer(leader);
      await until(() => leader.$('.shop[open]'), 'shop opens for the leading team');
      await leader.locator('.shop-item', { hasText: 'Cash out' }).locator('button').click();
      await leader.fill('#dare-input', 'Whole team does ten jumping jacks');
      await leader.click('[data-act="send-dare"]');
      const dared = phones.filter((p) => p.team !== lead);
      // Vote yes until a majority decides it (later voters then have nothing to vote on).
      const decided = async () => (await tv.textContent('.cash-banner').catch(() => '')).includes('accepted');
      for (const p of dared) {
        await asPlayer(p);
        await until(async () => (await p.$('.vote-row')) || (await decided()), `${p.n} dare vote`);
        if (await decided()) break;
        await p.click('.vote-row button.good');
        await p.waitForTimeout(150);
      }
      await asHost();
      await until(() => host.$('button:text-is("Dare done ✓")'), 'dare accepted');
      await host.click('button:text-is("Dare done ✓")');
      const tied = await until(async () => {
        const x = await scores(tv);
        return x[0] === x[1] && x;
      }, 'tie after cash out');
      check(tied[0] === tied[1] && !!(await tv.$('.banked')), 'Cash out: dare voted in, lead banked, scores tied', tied.join('-'));

      // Buy a game switch: unlock it immediately and give the leaders a 20-point lead.
      await host.click('button.pill:text-is("0m")');
      for (let i = 0; i < 4; i++) {
        await plus5.click();
        await host.waitForTimeout(100);
      }
      await asPlayer(leader);
      await until(() => leader.$('.shop[open]'), 'shop for switch');
      await leader.locator('.shop-item', { hasText: 'Switch game' }).locator('button').click();
      await leader.click('button:text-is("🎲 Random game")');
      await until(async () => (await tv.textContent('.announce')).includes('to switch to'), 'switch announced');
      check(true, 'Team shop: leading team bought a game switch');
    }

    check(pageErrors.length === 0, 'no JavaScript errors on any screen', pageErrors.slice(0, 3).join(' | '));
  } catch (err) {
    check(false, 'run finished', err.message);
  } finally {
    await browser.close();
    if (srv) await srv.close();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main();
