// Screens for Catchphrase. See server/games/catchphrase.js for the rules.
//
// The timer is hidden: the server only says which "stage" (0-3) the round is in. Every screen
// pulses in the holder's team color, faster each stage, and the holder's phone ticks faster too.
// At the buzzer every phone with sound on plays a buzz and vibrates.
window.GameViews = window.GameViews || {};

(() => {
  const TICK_MS = [900, 600, 350, 180]; // time between ticks per stage

  // ---------- sound (Web Audio; no files) ----------
  let ctx = null;
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // Browsers only allow sound after a tap, so warm the audio up on every tap.
  document.addEventListener('pointerdown', () => audio(), { capture: true });

  function beep(freq, ms, type = 'square', volume = 0.15) {
    const a = ctx;
    if (!a || a.state !== 'running') return;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + ms / 1000);
    osc.connect(gain).connect(a.destination);
    osc.start();
    osc.stop(a.currentTime + ms / 1000);
  }

  // The tick runs off the DOM: it keeps going while a holder card is on screen and reads the
  // current stage from it, so it stops by itself when the round ends or the game changes.
  let tickTimer = null;
  function tick() {
    const card = document.querySelector('.cp-card[data-ticking]');
    if (!card) {
      tickTimer = null;
      return;
    }
    const stage = Number(card.dataset.stage) || 0;
    beep(stage >= 3 ? 1100 : 880, 60);
    tickTimer = setTimeout(tick, TICK_MS[stage]);
  }
  const startTicking = () => {
    if (!tickTimer) tickTimer = setTimeout(tick, 50);
  };

  let buzzedRound = null;
  function buzzer(n) {
    if (buzzedRound === n) return;
    buzzedRound = n;
    beep(140, 900, 'sawtooth', 0.3);
    setTimeout(() => beep(110, 700, 'sawtooth', 0.3), 150);
    if (navigator.vibrate) navigator.vibrate([400, 100, 400]);
  }

  let heldWord = null;
  function newHolderBuzz(v) {
    // A short buzz when the word lands in your hands.
    if (v.role === 'holder' && v.word && heldWord !== v.word.id) {
      heldWord = v.word.id;
      if (navigator.vibrate) navigator.vibrate(120);
    }
  }

  // ---------- screens ----------
  const send = (who, action, payload, extra = '') =>
    who === 'host'
      ? `data-send="host" data-type="game" data-payload='${JSON.stringify({ action, payload })}' ${extra}`
      : `data-send="player" data-payload='${JSON.stringify({ action, payload })}' ${extra}`;

  const RULES = 'No saying the word or part of it · no "rhymes with" · no first letters · no acting it out';
  const soundHint = () => (!ctx || ctx.state !== 'running' ? '<p class="small center cp-sound">🔈 Tap anywhere to turn on the ticking sound</p>' : '');

  function pulse(v, team, inner) {
    const t = team(v.teamId);
    return `<div class="cp-pulse stage-${v.stage}" style="--c:${t.color}">${inner}</div>`;
  }

  function playing(v, ctx2, who) {
    const { esc, team } = ctx2;
    const t = team(v.teamId);
    newHolderBuzz(v);
    if (v.role === 'holder') {
      startTicking();
      return `${pulse(
        v,
        team,
        `<div class="cp-card" data-ticking data-stage="${v.stage}">
          <div class="cp-cat">${esc(v.word.category)}</div>
          <div class="cp-word">${esc(v.word.text)}</div>
        </div>`,
      )}
        <p class="small center muted">${RULES}</p>
        <div class="cp-actions">
          <button class="big good" ${send('player', 'got', { word: v.word.id })}>✓ We got it!</button>
          <button class="big secondary" ${send('player', 'skip', { word: v.word.id })}>Skip</button>
        </div>
        ${soundHint()}`;
    }
    const line =
      v.role === 'guesser'
        ? `<div class="huge">Guess!</div><p>${esc(v.holder.name)} is describing it to your team</p>`
        : v.role === 'waiting'
          ? `<div class="huge">Get ready…</div><p>${esc(v.holder.name)} has it. It comes to your team next!</p>`
          : `<div class="huge">${esc(v.holder.name)}</div><p>has it for ${esc(t.name)}</p>`;
    return `${pulse(v, team, `<div class="cp-watch">${line}</div>`)}
      <p class="muted small center">${v.passes} pass${v.passes === 1 ? '' : 'es'} this round</p>
      ${who === 'host' ? `<div class="row"><button class="secondary" ${send('host', 'pass')}>Holder walked off: pass to a teammate</button><button class="secondary" ${send('host', 'buzz')}>Buzz now</button></div>` : ''}`;
  }

  function ready(v, { esc, team }, who) {
    const t = team(v.teamId);
    if (v.role === 'holder') {
      return `<div class="picker-badge">🎤 You're starting this round!</div>
        <p class="instruct">Get your team close. You'll see a word: get your team to say it.</p>
        <p class="small center muted">${RULES}</p>
        <p class="small center">When they get it, tap <b>We got it!</b> and it jumps to the other team. Don't be holding it when the buzzer goes off!</p>
        <button class="big" ${send('player', 'start')}>Start the round</button>`;
    }
    return `<div class="up-next" style="--c:${t.color}"><div class="small">Starting this round</div><div class="huge">${esc(v.holder.name)}</div><div>${esc(t.name)}</div></div>
      <p class="instruct">The timer is hidden. Screens pulse faster as it runs down.</p>
      ${who === 'host' ? `<button ${send('host', 'start')}>Start for them</button>` : ''}`;
  }

  function buzzed(v, { esc, team }, who) {
    buzzer(v.n);
    const lost = team(v.result.loser);
    const won = team(v.result.winner);
    const icon = { got: '✓', skipped: '↷', stuck: '💥' };
    return `<div class="cp-buzz" style="--c:${lost.color}">
        <div class="huge">BUZZ!</div>
        <div>${esc(v.result.holder)} was stuck with <strong>${esc(v.result.word)}</strong></div>
        <div class="win-name" style="color:${won.color}">${esc(won.name)} +1</div>
      </div>
      <ul class="taboo-results">${v.log
        .map((l) => `<li class="r-${l.result === 'got' ? 'correct' : l.result === 'stuck' ? 'buzz' : 'pass'}"><span class="ico">${icon[l.result]}</span><span class="grow">${esc(l.word)}</span><span class="muted small">${esc(l.name)}</span></li>`)
        .join('')}</ul>
      ${v.role !== 'watch' || who === 'host' ? `<button class="big" ${send(who === 'host' ? 'host' : 'player', who === 'host' ? 'start' : 'next')}>Next round</button>` : ''}
      <p class="muted small center">Next round lines up in <span data-until="${v.nextAt}"></span></p>`;
  }

  function screen(v, c, who) {
    if (v.phase === 'waiting')
      return `<div class="cah-wait"><div class="huge">💬</div><p>Each team needs at least ${v.minPerTeam} players online.</p>
        <p class="muted small">${v.wordCount.toLocaleString()} words and phrases</p>
        ${who !== 'tv' ? `<button class="big" ${send(who, 'start')}>Start</button>` : ''}</div>`;
    if (v.phase === 'ready') return ready(v, c, who);
    if (v.phase === 'playing') return playing(v, c, who);
    return buzzed(v, c, who);
  }

  function settings(v) {
    const pill = (val, label) =>
      `<button class="pill ${v.settings.length === val ? 'active' : ''}" ${send('host', 'settings', { length: val })}>${label}</button>`;
    return `<details class="cah-settings"><summary>Catchphrase settings</summary>
      <div class="row"><span class="grow">Hidden timer</span>${pill('short', '30–50s')}${pill('normal', '45–75s')}${pill('long', '60–100s')}</div>
    </details>`;
  }

  window.GameViews.catchphrase = {
    player: (v, c) => screen(v, c, 'player'),
    host: (v, c) => screen(v, c, 'host') + settings(v),
    tv: (v, c) => screen(v, c, 'tv'),
  };
})();
