// Screens for the Trivia Board. See server/games/trivia.js for the rules.
window.GameViews = window.GameViews || {};

(() => {
  const LETTERS = ['A', 'B', 'C', 'D'];
  // The chooser taps an answer first, then "Lock in", so a fat-fingered tap isn't final.
  let sel = { n: null, pos: null };
  const selected = (v) => (sel.n === v.n ? sel.pos : null);

  const send = (who, action, payload, extra = '') =>
    who === 'host'
      ? `data-send="host" data-type="game" data-payload='${JSON.stringify({ action, payload })}' ${extra}`
      : `data-send="player" data-payload='${JSON.stringify({ action, payload })}' ${extra}`;

  const pts = (n) => `${n} pt${n === 1 ? '' : 's'}`;
  const timer = (v) => (v.endsAt ? `<span class="timer big-timer" data-until="${v.endsAt}"></span>` : '');

  function chooserLine(v, { esc, team }) {
    if (!v.chooser) return '';
    const t = team(v.chooser.teamId);
    return `<div class="picker-line" style="--c:${t.color}">On the board: <strong>${esc(v.chooser.name)}</strong> <span class="muted">(${esc(t.name)})</span></div>`;
  }

  // The Jeopardy grid. `pickAs` is 'player' (chooser), 'host' (picking for them) or null.
  function board(v, { esc, team }, pickAs) {
    const head = v.categories.map((c) => `<div class="tb-head">${esc(c)}</div>`).join('');
    const cells = v.levels
      .map((level) =>
        v.categories
          .map((category) => {
            const i = v.board.findIndex((c) => c.category === category && c.level === level);
            const c = v.board[i];
            if (c.used) {
              const t = team(c.teamId);
              return `<div class="tb-cell used" style="--c:${t ? t.color : 'var(--line)'}">${c.right ? '✓' : '✗'}</div>`;
            }
            if (!pickAs) return `<div class="tb-cell">${level}</div>`;
            const action = pickAs === 'host' ? 'pickFor' : 'pick';
            return `<button class="tb-cell open" ${send(pickAs, action, { cell: i })}>${level}</button>`;
          })
          .join(''),
      )
      .join('');
    return `<div class="trivia-board" style="--cols:${v.categories.length}">${head}${cells}</div>
      <p class="muted small center">Board ${v.boardNo} · squares are worth 1–5 points</p>`;
  }

  function header(v, esc) {
    return `<div class="tq-head"><span class="tq-cat">${esc(v.category)} · ${pts(v.level)}</span>${timer(v)}</div>
      <div class="tq-question">${esc(v.question)}</div>`;
  }

  // One answer row. `bar` shows crowd picks when this screen is allowed to see them.
  function option(v, i, { esc }, { cls = '', attrs = '', bar = false } = {}) {
    const n = v.crowd ? v.crowd[i] : 0;
    const pct = v.crowdTotal ? Math.round((100 * n) / v.crowdTotal) : 0;
    return `<button class="tq-opt ${cls}" ${attrs}>
      <span class="tq-letter">${LETTERS[i]}</span><span class="grow">${esc(v.answers[i])}</span>
      ${bar && v.crowd ? `<span class="tq-count">${n}</span><span class="tq-bar" style="width:${pct}%"></span>` : ''}
    </button>`;
  }

  function question(v, ctx, who) {
    const { esc } = ctx;
    if (v.role === 'chooser') {
      const s = selected(v);
      return `${header(v, esc)}
        <p class="small center muted">The bars show what the crowd picked (${v.crowdTotal} so far). Your team might be helping… or the other team might be trying to fool you.</p>
        <div class="tq-opts">${v.answers
          .map((a, i) => option(v, i, ctx, { cls: s === i ? 'selected' : '', attrs: `data-local="trivia" data-pos="${i}"`, bar: true }))
          .join('')}</div>
        <div class="submit-bar"><button class="big" ${s === null ? 'disabled' : send('player', 'answer', { answer: s })}>${s === null ? 'Tap an answer' : `Lock in ${LETTERS[s]}`}</button></div>`;
    }
    if (v.role === 'crowd') {
      const team = ctx.team(v.chooser.teamId);
      return `${chooserLine(v, ctx)}${header(v, esc)}
        <p class="small center">Pick an answer. ${esc(v.chooser.name)} sees how many people picked each one (not who). ${
          ctx.state.me.teamId === v.chooser.teamId ? 'Help your teammate!' : `Help ${esc(team.name)}… or lead them astray 😈`
        }</p>
        <div class="tq-opts">${v.answers
          .map((a, i) => option(v, i, ctx, { cls: v.myGuess === i ? 'selected' : '', attrs: send('player', 'guess', { answer: i }) }))
          .join('')}</div>
        <p class="muted small center">${v.myGuess === null ? 'Only their answer scores.' : 'Got it. You can change your pick until they lock in.'}</p>`;
    }
    // Referee host sees the crowd split; the TV doesn't (the crowd can see the TV too).
    const seesBars = v.role === 'referee';
    return `${chooserLine(v, ctx)}${header(v, esc)}
      <div class="tq-opts">${v.answers.map((a, i) => option(v, i, ctx, { bar: seesBars })).join('')}</div>
      <p class="muted small center">${v.crowdTotal} crowd answer${v.crowdTotal === 1 ? '' : 's'} in</p>
      ${who === 'host' ? `<button class="secondary" ${send('host', 'next')}>Time's up: reveal now</button>` : ''}`;
  }

  function reveal(v, ctx, who) {
    const { esc, team } = ctx;
    const t = team(v.teamId);
    const top = Math.max(...v.crowd);
    const crowdRight = v.crowdTotal > 0 && v.crowd[v.correct] === top;
    const verdict =
      v.answer === null
        ? `⏱ ${esc(v.chooser.name)} ran out of time`
        : v.right
          ? `✓ ${esc(v.chooser.name)} got it! <span class="pts">+${v.level}</span>`
          : `✗ ${esc(v.chooser.name)} picked ${LETTERS[v.answer]}`;
    const split = Object.entries(v.crowdByTeam)
      .map(([teamId, counts]) => {
        const tm = team(teamId);
        const picks = counts.map((n, i) => (n ? `${LETTERS[i]}×${n}` : '')).filter(Boolean).join(' ');
        return `<li style="--c:${tm.color}"><strong>${esc(tm.name)}</strong> crowd: ${picks || 'no picks'}</li>`;
      })
      .join('');
    const next =
      v.role === 'chooser' || who === 'host'
        ? `<button class="big" ${send(who === 'host' ? 'host' : 'player', 'next')}>Next turn</button>`
        : '';
    return `<div class="result-win" style="--c:${t.color}">
        <div class="small">${esc(v.category)} · ${pts(v.level)}</div>
        <div class="win-name">${verdict}</div>
      </div>
      <div class="tq-question small-q">${esc(v.question)}</div>
      <div class="tq-opts">${v.answers
        .map((a, i) => option(v, i, ctx, { cls: i === v.correct ? 'correct' : i === v.answer ? 'wrong' : '', bar: true }))
        .join('')}</div>
      <p class="center small">${v.crowdTotal ? (crowdRight ? '👥 The crowd was right.' : '👥 The crowd got it wrong.') : 'Nobody in the crowd answered.'}</p>
      <ul class="crowd-split">${split}</ul>
      ${next}
      <p class="muted small center">Next turn in <span data-until="${v.nextAt}"></span></p>`;
  }

  function pick(v, ctx, who) {
    const { esc, team } = ctx;
    if (v.role === 'chooser') {
      return `<div class="picker-badge">🎯 Your turn! Pick a category and difficulty</div>
        <p class="small center muted">Harder squares are worth more. Everyone else answers too, and you'll see their picks.</p>
        ${board(v, ctx, 'player')}`;
    }
    const t = team(v.teamId);
    return `<div class="up-next" style="--c:${t.color}"><div class="small">Picking a square</div><div class="huge">${esc(v.chooser.name)}</div><div>${esc(t.name)}</div></div>
      ${board(v, ctx, who === 'host' ? 'host' : null)}
      ${who === 'host' ? `<p class="small muted center">Tap a square to pick for them.</p><button class="secondary" ${send('host', 'skip')}>Let someone else pick</button>` : ''}`;
  }

  function screen(v, ctx, who) {
    if (v.phase === 'waiting')
      return `<div class="cah-wait"><div class="huge">❓</div><p>Waiting for at least ${v.minPlayers} players online.</p>
        ${who !== 'tv' ? `<button class="big" ${send(who, 'start')}>Start</button>` : ''}</div>`;
    if (v.phase === 'pick') return pick(v, ctx, who);
    if (v.phase === 'question') return question(v, ctx, who);
    return reveal(v, ctx, who);
  }

  function settings(v) {
    const pill = (s) => `<button class="pill ${v.settings.seconds === s ? 'active' : ''}" ${send('host', 'settings', { seconds: s })}>${s}s</button>`;
    return `<details class="cah-settings"><summary>Trivia settings</summary>
      <div class="row"><span class="grow">Time to answer</span>${[20, 30, 45, 60].map(pill).join('')}</div>
      <button class="secondary" ${send('host', 'newBoard')}>Deal a fresh board</button>
    </details>`;
  }

  window.GameViews.trivia = {
    local(data, v) {
      if (data.local !== 'trivia' || v.phase !== 'question' || v.role !== 'chooser') return;
      sel = { n: v.n, pos: Number(data.pos) };
    },
    player: (v, ctx) => screen(v, ctx, 'player'),
    host: (v, ctx) => screen(v, ctx, 'host') + settings(v),
    tv: (v, ctx) => screen(v, ctx, 'tv'),
  };
})();
