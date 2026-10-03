// Screens for Cards Against Humanity (team edition). See server/games/cah.js for the rules.
window.GameViews = window.GameViews || {};

(() => {
  // Cards this phone has tapped but not yet submitted, reset every round.
  let sel = { n: null, cards: [] };
  const selection = (v) => (sel.n === v.n ? sel.cards : []);

  // Put answers into the prompt's blanks; questions with no blank get the answer underneath.
  function fill(prompt, answers, esc, { placeholder = true } = {}) {
    const parts = prompt.split('_');
    const blanks = parts.length - 1;
    const ans = (a) => `<span class="ans">${esc(a)}</span>`;
    if (!blanks) {
      return `${esc(prompt)}${answers.length ? `<div class="ans-block">${answers.map(ans).join('<br>')}</div>` : ''}`;
    }
    let html = esc(parts[0]);
    for (let i = 0; i < blanks; i++) {
      const rest = parts[i + 1];
      let a = answers[i];
      // "A balanced breakfast." mid-sentence reads better without the full stop.
      if (a && rest.trim() && /^[\s,.:;!?)"']/.test(rest) && a.endsWith('.')) a = a.slice(0, -1);
      html += a ? ans(a) : placeholder ? '<span class="blank">_____</span>' : '_____';
      html += esc(rest);
    }
    return html;
  }

  const blackCard = (html, cls = '') => `<div class="black-card ${cls}">${html}</div>`;
  const timer = (v) => (v.deadline ? `<span class="timer" data-until="${v.deadline}"></span>` : '');
  const pickLabel = (v) => (v.pick > 1 ? `<span class="pick-n">Pick ${v.pick}</span>` : '');
  const send = (who, action, payload, extra = '') =>
    who === 'host'
      ? `data-send="host" data-type="game" data-payload='${JSON.stringify({ action, payload }).replace(/'/g, '&#39;')}' ${extra}`
      : `data-send="player" data-payload='${JSON.stringify({ action, payload }).replace(/'/g, '&#39;')}' ${extra}`;

  function pickerLine(v, { team, esc }) {
    if (!v.picker) return '';
    const t = team(v.picker.teamId);
    return `<div class="picker-line" style="--c:${t.color}">Picker: <strong>${esc(v.picker.name)}</strong> <span class="muted">(${esc(t.name)})</span></div>`;
  }

  function waiting(v, ctx, who) {
    return `<div class="cah-wait">
      <div class="huge">🃏</div>
      <p>Waiting for players: <strong>${v.online}/${v.minPlayers}</strong> online</p>
      <p class="muted small">${v.deckSize.packs} decks · ${v.deckSize.black.toLocaleString()} prompts · ${v.deckSize.white.toLocaleString()} answers</p>
      ${who ? `<button class="big" ${send(who, 'start')}>Deal the first round</button>` : ''}
    </div>`;
  }

  // ---------- reveal / judge / result, shared by every screen ----------

  function revealView(v, ctx, who) {
    const a = v.answers[v.revealIndex];
    const last = v.revealIndex === v.total - 1;
    let controls = '';
    if (v.amPicker) controls = `<p class="instruct">Read it out loud, then tap next.</p><button class="big" ${send('player', 'next')}>${last ? 'Done: time to judge' : 'Next answer →'}</button>`;
    else if (who === 'host') controls = `<button class="secondary" ${send('host', 'next')}>${last ? 'Done: time to judge' : 'Next answer →'} (for the picker)</button>`;
    else controls = `<p class="muted center">${ctx.esc(v.picker ? v.picker.name : 'The picker')} is reading the answers…</p>`;
    return `${pickerLine(v, ctx)}
      <div class="reveal-count">Answer ${v.revealIndex + 1} of ${v.total}</div>
      ${blackCard(fill(v.prompt, a.cards, ctx.esc), 'reveal')}
      ${controls}`;
  }

  function judgeView(v, ctx, who) {
    const { esc } = ctx;
    let head;
    let mode = null; // 'pick' | 'vote' | 'pickFor'
    if (v.amPicker) {
      head = v.pickerChoice ? `<p class="instruct">Locked in. Waiting for votes (${v.votesIn}/${v.voterCount}) ${timer(v)}</p>` : '<p class="instruct">Pick the winner!</p>';
      mode = 'pick';
    } else if (v.canVote) {
      head = `<p class="instruct">${v.myVote ? 'Voted! You can change it until voting closes.' : 'Vote for the best answer (yours counts too).'} ${timer(v)}</p>`;
      mode = 'vote';
    } else if (who === 'host') {
      head = `<p class="instruct">${v.pickerChoice ? 'The picker has chosen.' : 'Waiting for the picker…'} Votes: ${v.votesIn}/${v.voterCount} ${timer(v)}</p>`;
      mode = 'pickFor';
    } else {
      head = `<p class="instruct">The picker is choosing and everyone's voting… ${timer(v)}</p>`;
    }
    const chosen = mode === 'pick' || mode === 'pickFor' ? v.pickerChoice : mode === 'vote' ? v.myVote : null;
    const list = v.answers
      .map((a) => {
        const html = fill(v.prompt, a.cards, esc);
        const cls = `answer ${a.key === chosen ? 'chosen' : ''} ${a.mine ? 'mine' : ''}`;
        if (mode === 'pick') return `<button class="${cls}" ${send('player', 'pick', { playerId: a.key })}>${html}</button>`;
        if (mode === 'vote') return `<button class="${cls}" ${send('player', 'vote', { playerId: a.key })}>${html}${a.mine ? '<span class="tag">yours</span>' : ''}</button>`;
        return `<div class="${cls}">${html}</div>`;
      })
      .join('');
    let hostTools = '';
    if (mode === 'pickFor') {
      hostTools = v.pickerChoice
        ? `<button class="secondary" ${send('host', 'next')}>Close voting now</button>`
        : `<details class="small"><summary>Picker wandered off? Pick for them</summary>${v.answers
            .map((a) => `<button class="answer" ${send('host', 'pickFor', { playerId: a.key })}>${fill(v.prompt, a.cards, esc)}</button>`)
            .join('')}</details>`;
    }
    return `${pickerLine(v, ctx)}${blackCard(fill(v.prompt, [], esc))}${head}<div class="answers">${list}</div>${hostTools}`;
  }

  function resultView(v, ctx, who) {
    const { esc, team } = ctx;
    const r = v.result;
    const win = r.answers.find((a) => a.key === r.winnerKey);
    const winAnswer = v.answers.find((a) => a.key === r.winnerKey);
    const wt = win && win.teamId && team(win.teamId);
    const others = r.answers
      .filter((a) => a.key !== r.winnerKey)
      .map((a) => {
        const ans = v.answers.find((x) => x.key === a.key);
        const t = a.teamId && team(a.teamId);
        return `<li style="--c:${t ? t.color : 'var(--line)'}"><span class="who">${esc(a.name)}${a.auto ? ' <span class="muted">(auto)</span>' : ''}</span>
          <span class="grow">${esc(ans.cards.join(' / '))}</span><span class="votes">${a.votes} 🗳</span></li>`;
      })
      .join('');
    const next =
      v.amPicker || who === 'host'
        ? `<button class="big" ${send(v.amPicker ? 'player' : 'host', 'next')}>Next round</button>`
        : '';
    return `<div class="result-win" style="--c:${wt ? wt.color : 'var(--accent)'}">
        <div class="small">🏆 Picker chose</div>
        ${blackCard(fill(v.prompt, winAnswer ? winAnswer.cards : [], esc), 'winner')}
        <div class="win-name">${esc(win ? win.name : '?')} ${wt ? `· ${esc(wt.name)}` : ''} <span class="pts">+${r.points}</span></div>
        <div class="small">${win ? win.votes : 0} vote${win && win.votes === 1 ? '' : 's'} from the crowd</div>
        ${r.crowdAgrees ? '<div class="bonus">🎉 The crowd agreed! Bonus point!</div>' : '<div class="small muted">The crowd liked something else more. No bonus.</div>'}
      </div>
      ${others ? `<ul class="others">${others}</ul>` : ''}
      ${next}
      <p class="muted small center">Next round in <span data-until="${v.nextRoundAt}"></span></p>`;
  }

  // ---------- submit phase ----------

  function submitPlayer(v, ctx) {
    const { esc } = ctx;
    if (v.amPicker) {
      return `<div class="picker-badge">⭐ You're the picker this round</div>
        <p class="instruct">Read this out loud to everyone:</p>
        ${blackCard(fill(v.prompt, [], esc))}
        <p class="center">${v.submittedCount} played ${timer(v)}</p>
        ${v.waitingOn.length ? `<p class="muted small center">Waiting on ${esc(v.waitingOn.join(', '))}</p>` : ''}`;
    }
    if (v.played) {
      return `${pickerLine(v, ctx)}${blackCard(fill(v.prompt, v.played, esc))}
        <p class="center">Locked in ✓ ${timer(v)}</p>
        ${v.waitingOn.length ? `<p class="muted small center">Waiting on ${esc(v.waitingOn.join(', '))}</p>` : ''}`;
    }
    const chosen = selection(v);
    const texts = chosen.map((id) => (v.hand.find((c) => c.id === id) || {}).text).filter(Boolean);
    const ready = chosen.length === v.pick;
    return `${pickerLine(v, ctx)}
      ${blackCard(fill(v.prompt, texts, esc))}
      <div class="row"><span class="grow">${v.pick > 1 ? `Tap ${v.pick} cards in order` : 'Tap a card to play it'} ${pickLabel(v)}</span>${timer(v)}</div>
      <div class="hand">${v.hand
        .map((c) => {
          const at = chosen.indexOf(c.id);
          return `<button class="white-card ${at >= 0 ? 'selected' : ''}" data-local="card" data-id="${c.id}">${at >= 0 && v.pick > 1 ? `<span class="order">${at + 1}</span>` : ''}${esc(c.text)}</button>`;
        })
        .join('')}</div>
      <div class="submit-bar"><button class="big" ${ready ? send('player', 'play', { cards: chosen }) : 'disabled'}>${ready ? 'Play ' + (v.pick > 1 ? 'these cards' : 'this card') : v.pick > 1 ? `Pick ${v.pick - chosen.length} more` : 'Pick a card'}</button></div>
      <p class="muted small center">If time runs out, a random card is played for you.</p>`;
  }

  function submitWatch(v, ctx) {
    return `${pickerLine(v, ctx)}${blackCard(fill(v.prompt, [], ctx.esc))}
      <p class="center">${v.submittedCount} played ${timer(v)}</p>
      ${v.waitingOn.length ? `<p class="muted small center">Waiting on ${ctx.esc(v.waitingOn.join(', '))}</p>` : ''}`;
  }

  function hostSettings(v) {
    const pill = (key, val, label) =>
      `<button class="pill ${v.settings[key] === val ? 'active' : ''}" ${send('host', 'settings', { [key]: val })}>${label}</button>`;
    return `<details class="cah-settings" ${v.phase === 'waiting' ? 'open' : ''}><summary>Card game settings</summary>
      <div class="row"><span class="grow">Timer</span>${[0, 45, 60, 90].map((t) => pill('timer', t, t ? `${t}s` : 'Off')).join('')}</div>
      <div class="row"><span class="grow">Rating</span>${pill('rating', 'adult', '21+')}${pill('rating', 'family', 'Family friendly')}</div>
      <div class="row"><span class="grow">Decks</span>${pill('decks', 'all', 'All published')}${pill('decks', 'official', 'Official CAH only')}</div>
      <p class="muted small">In play: ${v.deckSize.packs} decks · ${v.deckSize.black.toLocaleString()} prompts · ${v.deckSize.white.toLocaleString()} answers</p>
      <p class="muted small">Win = ${v.settings.winPoints} point, +${v.settings.bonusPoints} bonus when the crowd vote matches the picker.</p>
    </details>`;
  }

  window.GameViews.cah = {
    local(data, v) {
      if (data.local !== 'card' || v.phase !== 'submit') return;
      if (sel.n !== v.n) sel = { n: v.n, cards: [] };
      const id = Number(data.id);
      const at = sel.cards.indexOf(id);
      if (at >= 0) sel.cards.splice(at, 1);
      else if (v.pick === 1) sel.cards = [id];
      else if (sel.cards.length < v.pick) sel.cards.push(id);
    },

    player(v, ctx) {
      if (v.phase === 'waiting') return waiting(v, ctx, 'player');
      if (v.phase === 'submit') return submitPlayer(v, ctx);
      if (v.phase === 'reveal') return revealView(v, ctx, 'player');
      if (v.phase === 'judge') return judgeView(v, ctx, 'player');
      if (v.phase === 'result') return resultView(v, ctx, 'player');
      return '';
    },

    host(v, ctx) {
      let body;
      if (v.phase === 'waiting') body = waiting(v, ctx, 'host');
      else if (v.phase === 'submit')
        body = `${submitWatch(v, ctx)}<div class="row"><button class="secondary" ${send('host', 'next')}>Stop waiting: reveal now</button><button class="secondary" ${send('host', 'skip')}>Skip this prompt</button></div>`;
      else if (v.phase === 'reveal') body = revealView(v, ctx, 'host');
      else if (v.phase === 'judge') body = judgeView(v, ctx, 'host');
      else body = resultView(v, ctx, 'host');
      return body + hostSettings(v);
    },

    tv(v, ctx) {
      if (v.phase === 'waiting') return waiting(v, ctx, null);
      if (v.phase === 'submit') return submitWatch(v, ctx);
      if (v.phase === 'reveal') return revealView(v, ctx, 'tv');
      if (v.phase === 'judge') return judgeView(v, ctx, 'tv');
      return resultView(v, ctx, 'tv');
    },
  };
})();
