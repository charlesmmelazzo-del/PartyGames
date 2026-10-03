// Screens for Pictionary. See server/games/pictionary.js for the rules.
//
// One <canvas> per turn lives outside the normal re-rendered HTML: after every render it is
// moved back into the #pic-slot placeholder, so the drawing survives state updates. The drawer's
// strokes are drawn locally right away and streamed in small batches; everyone else draws them
// as they arrive. A screen that joins or reloads mid-turn asks for the strokes so far.
window.GameViews = window.GameViews || {};

(() => {
  const SIZE = 1000; // drawing coordinates are 0-1000 on both axes
  const WIDTH = { pen: 9, erase: 60 };
  const FLUSH_MS = 40;

  let canvas = null;
  let g = null; // 2D context
  let turnN = null;
  let tool = 'pen';
  let canDraw = false;
  let stream = () => {};
  // Drawer's in-progress stroke.
  let strokeId = 0;
  let down = false;
  let lastSent = null;
  let buffer = [];
  let flushTimer = null;

  function newCanvas() {
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    canvas.className = 'pic-canvas';
    g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, SIZE, SIZE);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  function drawSeg(mode, pts) {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = mode === 'erase' ? '#fff' : '#111';
    g.fillStyle = g.strokeStyle;
    g.lineWidth = WIDTH[mode];
    if (pts.length === 1) {
      g.beginPath();
      g.arc(pts[0][0], pts[0][1], WIDTH[mode] / 2, 0, Math.PI * 2);
      g.fill();
      return;
    }
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
    g.stroke();
  }

  const toPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * SIZE), Math.round(((e.clientY - r.top) / r.height) * SIZE)];
  };

  function flush() {
    flushTimer = null;
    if (!buffer.length) return;
    const p = lastSent ? [lastSent, ...buffer] : buffer;
    stream({ type: 'seg', n: turnN, s: strokeId, m: tool, p });
    lastSent = buffer[buffer.length - 1];
    buffer = [];
  }
  const queue = (pt) => {
    buffer.push(pt);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  };

  function onDown(e) {
    if (!canDraw) return;
    e.preventDefault();
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    down = true;
    strokeId++;
    lastSent = null;
    const pt = toPoint(e);
    drawSeg(tool, [pt]);
    queue(pt);
  }
  function onMove(e) {
    if (!down || !canDraw) return;
    e.preventDefault();
    const prev = buffer.length ? buffer[buffer.length - 1] : lastSent;
    const pt = toPoint(e);
    if (prev && Math.abs(prev[0] - pt[0]) + Math.abs(prev[1] - pt[1]) < 3) return; // skip jitter
    if (prev) drawSeg(tool, [prev, pt]);
    queue(pt);
  }
  function onUp() {
    if (!down) return;
    down = false;
    clearTimeout(flushTimer);
    flush();
  }

  // ---------- screens ----------
  const send = (who, action, payload, extra = '') =>
    who === 'host'
      ? `data-send="host" data-type="game" data-payload='${JSON.stringify({ action, payload })}' ${extra}`
      : `data-send="player" data-payload='${JSON.stringify({ action, payload })}' ${extra}`;
  const timer = (v) => (v.endsAt ? `<span class="timer big-timer" data-until="${v.endsAt}"></span>` : '');
  const slot = '<div id="pic-slot" class="pic-slot"></div>';

  function feed(v, { esc, team }) {
    if (!v.feed.length) return '<p class="muted small center">Guesses show up here.</p>';
    return `<ul class="pic-feed">${v.feed
      .slice()
      .reverse()
      .map((f) => `<li class="${f.right ? 'right' : ''}" style="--c:${team(f.teamId).color}"><b>${esc(f.name)}</b> ${esc(f.text)}</li>`)
      .join('')}</ul>`;
  }

  const guessBox = (label) => `<div class="pic-guess">
      <input id="pic-guess" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="60" placeholder="${label}">
      <button data-submit="pic-guess" data-action="guess">Guess</button>
    </div>`;

  function header(v, { esc, team }) {
    const t = team(v.drawer.teamId);
    return `<div class="tq-head"><span class="tq-cat" style="color:${t.color}">✏️ ${esc(v.drawer.name)} is drawing for ${esc(t.name)}</span>${timer(v)}</div>`;
  }

  function drawing(v, c, who) {
    const { esc, team } = c;
    if (v.role === 'drawer') {
      return `<div class="pic-word"><span class="muted small">${esc(v.word.category)}</span> <b>${esc(v.word.text)}</b> ${timer(v)}</div>
        ${slot}
        <div class="pic-tools">
          <button class="${tool === 'pen' ? 'active' : ''}" data-local="tool" data-tool="pen">✏️ Marker</button>
          <button class="${tool === 'erase' ? 'active' : ''}" data-local="tool" data-tool="erase">🧽 Eraser</button>
        </div>
        <p class="muted small center">No letters or numbers! Your team types their guesses.</p>
        ${feed(v, c)}`;
    }
    const steal = team(v.stealTeamId);
    const below =
      v.role === 'guesser'
        ? guessBox('Type your guess…')
        : v.role === 'stealer'
          ? `<p class="center small">Watch closely: if they don't get it in time, <b style="color:${steal.color}">${esc(steal.name)}</b> gets ${v.stealSeconds} seconds to steal!</p>`
          : '';
    return `${header(v, c)}${slot}${below}${feed(v, c)}
      ${who === 'host' ? `<button class="secondary" ${send('host', 'timeUp')}>Time's up now (go to steal)</button>` : ''}`;
  }

  function steal(v, c, who) {
    const { esc, team } = c;
    const s = team(v.stealTeamId);
    const head = `<div class="steal-banner" style="--c:${s.color}"><b>${esc(s.name)}</b> can steal for ${v.stealPoints} points! ${timer(v)}</div>`;
    const below = v.role === 'stealer' ? guessBox('Steal it! Type your guess…') : `<p class="center small muted">Time's up for ${esc(team(v.teamId).name)}. Hands off!</p>`;
    return `${head}${slot}${below}${feed(v, c)}
      ${who === 'host' ? `<button class="secondary" ${send('host', 'timeUp')}>End the steal now</button>` : ''}`;
  }

  function ready(v, { esc, team }, who) {
    const t = team(v.teamId);
    if (v.role === 'drawer') {
      return `<div class="picker-badge">✏️ You're drawing!</div>
        <div class="pic-word big"><span class="muted small">${esc(v.word.category)}</span><br><b>${esc(v.word.text)}</b></div>
        <p class="small center muted">Draw it with the marker. No letters or numbers. Your team types guesses, and the faster they get it the more points you score.</p>
        <div class="row"><button class="big" ${send('player', 'start')}>Start drawing</button><button class="secondary" ${send('player', 'newWord')}>New word</button></div>`;
    }
    return `<div class="up-next" style="--c:${t.color}"><div class="small">Drawing next</div><div class="huge">${esc(v.drawer.name)}</div><div>${esc(t.name)}</div></div>
      <p class="instruct">${v.role === 'guesser' ? 'Get ready to type your guesses!' : v.role === 'stealer' ? 'Watch the drawing: you might get to steal!' : ''}</p>
      ${who === 'host' ? `<div class="row"><button ${send('host', 'start')}>Start for them</button><button class="secondary" ${send('host', 'skip')}>Pick someone else</button></div>` : ''}`;
  }

  function result(v, c, who) {
    const { esc, team } = c;
    const r = v.result;
    const w = r.teamId && team(r.teamId);
    const line = w
      ? `${esc(r.name)} got it${r.steal ? ' on the steal' : ''}! <span class="pts" style="color:${w.color}">${esc(w.name)} +${r.points}</span>`
      : 'Nobody got it.';
    return `<div class="result-win" style="--c:${w ? w.color : 'var(--line)'}">
        <div class="small">The word was</div><div class="huge">${esc(r.word)}</div><div class="win-name">${line}</div>
      </div>
      ${slot}
      ${v.role !== 'watch' || who === 'host' ? `<button class="big" ${send(who === 'host' ? 'host' : 'player', who === 'host' ? 'start' : 'next')}>Next turn</button>` : ''}
      <p class="muted small center">Next turn in <span data-until="${v.nextAt}"></span></p>`;
  }

  function screen(v, c, who) {
    if (v.phase === 'waiting')
      return `<div class="cah-wait"><div class="huge">🎨</div><p>A team needs at least ${v.minTeam} players online.</p>
        <p class="muted small">${v.wordCount} words to draw</p>
        ${who !== 'tv' ? `<button class="big" ${send(who, 'start')}>Start</button>` : ''}</div>`;
    if (v.phase === 'ready') return ready(v, c, who);
    if (v.phase === 'drawing') return drawing(v, c, who);
    if (v.phase === 'steal') return steal(v, c, who);
    return result(v, c, who);
  }

  function settings(v) {
    const pill = (s) => `<button class="pill ${v.settings.seconds === s ? 'active' : ''}" ${send('host', 'settings', { seconds: s })}>${s}s</button>`;
    return `<details class="cah-settings"><summary>Pictionary settings</summary>
      <div class="row"><span class="grow">Drawing time</span>${[45, 60, 75, 90, 120].map(pill).join('')}</div>
    </details>`;
  }

  window.GameViews.pictionary = {
    player: (v, c) => screen(v, c, 'player'),
    host: (v, c) => screen(v, c, 'host') + settings(v),
    tv: (v, c) => screen(v, c, 'tv'),

    local(data) {
      if (data.local === 'tool') tool = data.tool === 'erase' ? 'erase' : 'pen';
    },

    // Put the persistent canvas back into the freshly rendered page.
    mounted(v, c) {
      const host = document.getElementById('pic-slot');
      if (!host || !v.n) return;
      stream = c.stream;
      if (turnN !== v.n || !canvas) {
        newCanvas();
        turnN = v.n;
        if (v.strokes) stream({ type: 'sync' }); // joined or reloaded mid-drawing
      }
      canDraw = v.role === 'drawer' && v.phase === 'drawing';
      canvas.classList.toggle('drawable', canDraw);
      if (canvas.parentNode !== host) host.appendChild(canvas);
    },

    onStream(msg) {
      if (!canvas || msg.n !== turnN) return;
      if (msg.type === 'sync') {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, SIZE, SIZE);
        for (const s of msg.segments) drawSeg(s.m, s.p);
      } else if (msg.type === 'seg') drawSeg(msg.m, msg.p);
    },
  };
})();
