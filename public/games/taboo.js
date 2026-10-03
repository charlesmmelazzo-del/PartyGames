// Screens for Taboo. See server/games/taboo.js for the rules.
window.GameViews = window.GameViews || {};

(() => {
  const send = (who, action, payload, extra = '') =>
    who === 'host'
      ? `data-send="host" data-type="game" data-payload='${JSON.stringify({ action, payload })}' ${extra}`
      : `data-send="player" data-payload='${JSON.stringify({ action, payload })}' ${extra}`;

  const timer = (v) => (v.endsAt ? `<div class="taboo-timer"><span class="timer big-timer" data-until="${v.endsAt}"></span></div>` : '');

  function card(v, esc) {
    return `<div class="taboo-card">
      <div class="taboo-cat">${esc(v.card.category)}</div>
      <div class="taboo-word">${esc(v.card.word)}</div>
      <ul class="taboo-list">${v.card.taboo.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    </div>`;
  }

  function giverLine(v, { esc, team }) {
    if (!v.giver) return '';
    const t = team(v.giver.teamId);
    return `<div class="picker-line" style="--c:${t.color}">Clue-giver: <strong>${esc(v.giver.name)}</strong> <span class="muted">(${esc(t.name)})</span></div>`;
  }

  function turnStats(v) {
    return `<div class="taboo-stats">
      <span><b>+${v.points}</b> this turn</span>
      ${v.owed ? `<span class="owed">Owes ${v.owed} pass${v.owed > 1 ? 'es' : ''}</span>` : ''}
    </div>`;
  }

  function lastLine(v, esc) {
    if (!v.last) return '';
    const what = {
      correct: v.last.paidOff ? '✓ got it (paid off a pass)' : '✓ got it',
      pass: '↷ passed',
      buzz: `🚨 buzzed by ${esc(v.last.by)}`,
      timeout: "⏱ time's up",
    }[v.last.result];
    return `<p class="muted small center">Last card: <strong>${esc(v.last.word)}</strong> ${what}</p>`;
  }

  // Buzz flashes on every screen for a few seconds.
  let buzzTimer = null;
  function buzzFlash(v, esc) {
    if (!v.buzz) return '';
    clearTimeout(buzzTimer);
    buzzTimer = setTimeout(() => document.querySelector('.buzz-flash') && document.querySelector('.buzz-flash').remove(), 3000);
    return `<div class="buzz-flash">🚨 BUZZ! ${esc(v.buzz.name)} caught a forbidden word on <strong>${esc(v.buzz.word)}</strong></div>`;
  }

  function waiting(v, who) {
    return `<div class="cah-wait"><div class="huge">🤐</div>
      <p>Waiting for players: a team needs at least ${v.minTeam} people online to give and guess clues.</p>
      <p class="muted small">${v.deckSize} cards in the deck</p>
      ${who ? `<button class="big" ${send(who, 'start')}>Start</button>` : ''}</div>`;
  }

  function ready(v, ctx, who) {
    const { esc, team } = ctx;
    const t = team(v.teamId);
    if (v.role === 'giver') {
      return `<div class="picker-badge">🎤 You're giving clues!</div>
        <p class="instruct">Get your team ready. You'll see a word and 5 words you can't say. Don't let the screen be seen by your team!</p>
        <p class="center muted">${v.settings.seconds} seconds · tap "Got it" when they say it, "Pass" to skip (your team owes one back).</p>
        <button class="big" ${send('player', 'start')}>Start the clock</button>`;
    }
    const tip =
      v.role === 'guesser'
        ? 'Get ready to guess!'
        : v.role === 'buzzer'
          ? "You'll see the word too. Hit BUZZ if they say a forbidden word."
          : '';
    return `<div class="up-next" style="--c:${t.color}">
        <div class="small">Up next</div>
        <div class="huge">${esc(v.giver.name)}</div>
        <div>gives clues for ${esc(t.name)}</div>
      </div>
      <p class="instruct">${tip}</p>
      ${who === 'host' ? `<div class="row"><button ${send('host', 'start')}>Start for them</button><button class="secondary" ${send('host', 'skipGiver')}>Pick someone else</button></div>` : ''}`;
  }

  function turn(v, ctx, who) {
    const { esc } = ctx;
    const top = `${buzzFlash(v, esc)}${giverLine(v, ctx)}${timer(v)}${turnStats(v)}`;
    if (v.role === 'giver') {
      return `${top}${card(v, esc)}
        ${v.owed ? `<p class="small center owed">Your next ${v.owed > 1 ? `${v.owed} correct cards pay` : 'correct card pays'} off your pass${v.owed > 1 ? 'es' : ''}: no points until then.</p>` : ''}
        <div class="taboo-actions">
          <button class="big good" ${send('player', 'correct', { card: v.card.id })}>✓ Got it</button>
          <button class="big secondary" ${send('player', 'pass', { card: v.card.id })}>Pass ↷</button>
        </div>`;
    }
    if (v.role === 'guesser') {
      return `${top}<div class="guess-box"><div class="huge">Guess!</div><p>${esc(v.giver.name)} is giving clues</p></div>${lastLine(v, esc)}`;
    }
    if (v.role === 'buzzer') {
      return `${top}${card(v, esc)}
        <button class="buzzer taboo-buzz" data-vibrate="1" ${send('player', 'buzz', { card: v.card.id })}>BUZZ</button>
        <p class="muted small center">Only buzz if ${esc(v.giver.name)} says the word or a forbidden one.</p>`;
    }
    // Host referee / host who is guessing / TV
    const body = v.card ? card(v, esc) : `<div class="guess-box"><div class="huge">🤐</div><p>${esc(v.giver.name)} is giving clues</p></div>`;
    return `${top}${body}${lastLine(v, esc)}
      ${who === 'host' ? `<button class="secondary" ${send('host', 'endTurn')}>End turn now</button>` : ''}`;
  }

  function summary(v, ctx, who) {
    const { esc, team } = ctx;
    const t = team(v.teamId);
    const icon = { correct: '✓', pass: '↷', buzz: '🚨', timeout: '⏱' };
    const label = (r) =>
      r.result === 'correct' ? (r.paidOff ? 'paid off a pass' : '+1') : r.result === 'pass' ? 'passed' : r.result === 'buzz' ? `buzzed by ${esc(r.by)}` : 'time ran out';
    return `${buzzFlash(v, esc)}<div class="result-win" style="--c:${t.color}">
        <div class="small">Turn over</div>
        <div class="win-name">${esc(v.giver.name)} · ${esc(t.name)} <span class="pts">+${v.points}</span></div>
      </div>
      <ul class="taboo-results">${v.results
        .map((r) => `<li class="r-${r.result}"><span class="ico">${icon[r.result]}</span><span class="grow">${esc(r.word)}</span><span class="muted small">${label(r)}</span></li>`)
        .join('')}</ul>
      ${v.role !== 'watch' || who === 'host' ? `<button class="big" ${send(who === 'host' ? 'host' : 'player', who === 'host' ? 'start' : 'next')}>Next team's turn</button>` : ''}
      <p class="muted small center">Next turn lines up in <span data-until="${v.nextAt}"></span></p>`;
  }

  function settings(v) {
    const pill = (key, val, label) =>
      `<button class="pill ${v.settings[key] === val ? 'active' : ''}" ${send('host', 'settings', { [key]: val })}>${label}</button>`;
    return `<details class="cah-settings" ${v.phase === 'waiting' ? 'open' : ''}><summary>Taboo settings</summary>
      <div class="row"><span class="grow">Turn length</span>${[45, 60, 90, 120].map((s) => pill('seconds', s, `${s}s`)).join('')}</div>
      <div class="row"><span class="grow">Rating</span>${pill('rating', 'adult', '21+')}${pill('rating', 'family', 'Family friendly')}</div>
      <div class="row"><span class="grow">Cards</span>${pill('source', 'all', 'All')}${pill('source', 'yours', 'Your deck only')}</div>
      <p class="muted small">${v.deckSize} cards in play. Family friendly leaves out the bar and grown-up cards.</p>
    </details>`;
  }

  function screen(v, ctx, who) {
    if (v.phase === 'waiting') return waiting(v, who === 'tv' ? null : who);
    if (v.phase === 'ready') return ready(v, ctx, who);
    if (v.phase === 'turn') return turn(v, ctx, who);
    return summary(v, ctx, who);
  }

  window.GameViews.taboo = {
    player: (v, ctx) => screen(v, ctx, 'player'),
    host: (v, ctx) => screen(v, ctx, 'host') + settings(v),
    tv: (v, ctx) => screen(v, ctx, 'tv'),
  };
})();
