/* global io, GameViews */
(() => {
  const SESSION_KEY = 'pg:session';
  const app = document.getElementById('app');
  const socket = io();

  let state = null; // latest snapshot from the server
  let clockOffset = 0; // serverTime - Date.now()
  let hostTab = 'play'; // a host who also plays: 'play' (their game screen) or 'host' (host menu)
  const drafts = {}; // text typed into inputs, kept across re-renders (keyed by element id)
  let lastHtml = null; // what's on screen now, so unchanged updates don't rebuild the page
  let picking = null; // open chooser: 'cashOut:<teamId>' | 'switch' | 'hostSwitch' | null
  let dismissedAnnouncement = null; // id of the announcement whose display time is over
  let announceTimer = null;

  // ---------- session (keeps a phone locked to its team) ----------
  const loadSession = () => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
    } catch {
      return null;
    }
  };
  const saveSession = (s) => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {}
  };
  const clearSession = () => {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {}
  };

  // ---------- helpers ----------
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const call = (event, msg) =>
    new Promise((resolve) => socket.timeout(8000).emit(event, msg, (err, res) => resolve(err ? { error: 'No connection, try again' } : res)));

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3000);
  }

  const fmtElapsed = (ms) => {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };

  const team = (id) => state.teams.find((t) => t.id === id);
  const joinUrl = () => `${location.origin}/?code=${state.code}`;

  // ---------- views ----------
  function renderHome(prefill = '') {
    state = null;
    lastHtml = null;
    document.body.style.removeProperty('--team');
    document.body.className = '';
    app.innerHTML = `
      <section class="home">
        <h1>Party&nbsp;Games</h1>
        <form id="join" class="card" autocomplete="off">
          <h2>Join a game</h2>
          <label>Code word<input name="code" required autocapitalize="characters" spellcheck="false" value="${esc(prefill)}" placeholder="e.g. MANGO"></label>
          <label>Your name<input name="name" required maxlength="20" placeholder="Your name"></label>
          <button class="big">Join</button>
        </form>
        <div class="card">
          <h2>Running the party?</h2>
          <label>Your name<input id="host-name" maxlength="20" placeholder="Your name"></label>
          <label class="check"><input type="checkbox" id="host-plays" checked> I'm playing too</label>
          <button id="create" class="big secondary">Host a new game</button>
          <button id="tv" class="link">Show a game on a TV / shared screen</button>
        </div>
      </section>`;

    const form = document.getElementById('join');
    if (prefill) form.name.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const res = await call('player:join', { code: form.code.value, name: form.name.value });
      if (res.error) return toast(res.error);
      saveSession({ code: res.code, playerId: res.playerId, playerToken: res.playerToken });
    };
    const plays = document.getElementById('host-plays');
    const hostName = document.getElementById('host-name');
    plays.onchange = () => (hostName.closest('label').hidden = !plays.checked);
    document.getElementById('create').onclick = async () => {
      const name = hostName.value.trim();
      if (plays.checked && !name) {
        hostName.focus();
        return toast("Enter your name, or untick \"I'm playing too\" to just run the game");
      }
      const res = await call('host:create', {});
      if (res.error) return toast(res.error);
      saveSession({ code: res.code, hostToken: res.hostToken });
      if (!plays.checked) return;
      // The host joins a team like everyone else; host controls live in the Host menu.
      const joined = await call('player:join', { code: res.code, name });
      if (joined.error) return toast(joined.error);
      hostTab = 'play';
      saveSession({ code: res.code, hostToken: res.hostToken, playerId: joined.playerId, playerToken: joined.playerToken });
    };
    document.getElementById('tv').onclick = async () => {
      const code = form.code.value || prompt('Code word for the game to show:');
      if (!code) return;
      const res = await call('tv:watch', { code });
      if (res.error) return toast(res.error);
      history.replaceState(null, '', `/?tv=${res.code}`);
    };
  }

  function scoreboard({ big = false } = {}) {
    return `<div class="scoreboard ${big ? 'big' : ''}">${state.teams
      .map(
        (t) => `<div class="score" style="--c:${t.color}">
          <div class="team-name">${esc(t.name)}</div>
          <div class="points">${t.score}</div>
          <div class="muted small">${t.players.length} player${t.players.length === 1 ? '' : 's'}</div>
          ${t.cashOuts ? `<div class="banked small">💰 ${t.cashOuts} cash-out${t.cashOuts === 1 ? '' : 's'} · ${t.banked} banked</div>` : ''}
        </div>`,
      )
      .join('')}</div>`;
  }

  function gameHeader() {
    if (!state.game) return `<div class="game-header"><strong>Intermission</strong><span class="muted">Waiting for the host to start a game</span></div>`;
    return `<div class="game-header"><strong>Round ${state.game.round}: ${esc(state.game.name)}</strong>
      <span class="muted">running <span data-since="${state.game.startedAt}"></span></span></div>`;
  }

  function gameBody(role) {
    if (!state.game) return '';
    const view = GameViews[state.game.id];
    if (!view || !view[role]) return `<p class="muted">This game has no ${role} screen.</p>`;
    // The host tab is for running the game: always show the referee screen with host controls,
    // even when the host is also playing (they take their own turns from the "My team" tab).
    // The server still decides what this viewer may see, so nothing secret can leak here.
    const v = role === 'host' && state.me ? { ...state.game.view, role: 'referee', amPicker: false, canVote: false } : state.game.view;
    return view[role](v, gameCtx(role));
  }

  // The leading team (or the host for them) writes a dare for the other team.
  function dareComposer(send, teamId) {
    const other = state.teams.find((t) => t.id !== teamId);
    return `<div class="dare-picker">
      <div class="dare-title">💰 Cash out</div>
      <p class="small">Write a dare for <strong>${esc(other.name)}</strong>. They vote to accept or reject it. If they accept and do it, ${send === 'host' ? 'the leading team' : 'your'} lead is banked and the score is tied.</p>
      <textarea id="dare-input" maxlength="120" rows="3" placeholder="e.g. Whole team does the worm across the room">${esc(drafts['dare-input'] || '')}</textarea>
      <button class="big" data-act="send-dare" data-who="${send}" data-team="${teamId}">Send the dare</button>
      <button class="link" data-pick="">Never mind</button>
    </div>`;
  }

  // Game list for buying a switch (player) or the host's quick switch.
  function gamePicker(send) {
    const others = state.allGames.filter((g) => !state.game || g.id !== state.game.id);
    const btn = (gameId, label, cls) =>
      send === 'host'
        ? `<button class="${cls}" data-send="host" data-type="setGame" data-payload='${JSON.stringify({ gameId })}'>${label}</button>`
        : `<button class="${cls}" data-send="player" data-payload='${JSON.stringify({ action: 'switchGame', payload: { gameId } })}'>${label}</button>`;
    return `<div class="dare-picker">
      <p class="small muted">${send === 'host' ? 'Switch to:' : `Spend ${state.switchPrice} points to switch to:`}</p>
      ${send === 'host' ? '' : btn('random', '🎲 Random game', 'big')}
      ${others.map((g) => btn(g.id, esc(g.name), 'dare')).join('')}
      <button class="link" data-pick="">Never mind</button>
    </div>`;
  }

  // Banner shown to everyone while a cash out is pending: first the dared team votes, then does it.
  function cashOutBanner(myTeamId) {
    const c = state.cashOut;
    if (!c) return '';
    const winners = team(c.teamId);
    const losers = team(c.owedBy);
    const lead = Math.max(0, winners.score - losers.score);
    const t = c.tally;
    const tally = `<div class="small tally">✓ ${t.accept} accept · ✗ ${t.reject} reject · ${t.needed} of ${t.eligible} needed to accept</div>`;
    if (c.status === 'voting') {
      if (myTeamId === c.owedBy) {
        const btn = (accept, label, cls) =>
          `<button class="big ${cls} ${c.myVote === accept ? 'active' : ''}" data-send="player" data-payload='${JSON.stringify({ action: 'dareVote', payload: { accept } })}'>${label}</button>`;
        return `<div class="cash-banner" style="--c:${winners.color}">
          <div class="dare-title">🎯 ${esc(winners.name)} dares your team:</div>
          <div class="dare-text">${esc(c.dare)}</div>
          <div class="small">Accept it and do it, and their ${lead}-point lead gets wiped to a tie. Reject it and they have to write another.</div>
          <div class="row vote-row">${btn(true, 'Accept ✓', 'good')}${btn(false, 'Reject ✗', 'danger')}</div>
          ${c.myVote === null ? '' : '<div class="small">Voted! You can change your vote until it\'s decided.</div>'}
          ${tally}<div class="small">Voting closes in <span data-until="${c.deadline}"></span></div>
        </div>`;
      }
      const head = myTeamId === c.teamId ? `Dare sent! Waiting for ${esc(losers.name)} to vote…` : `${esc(winners.name)} dares ${esc(losers.name)}:`;
      return `<div class="cash-banner" style="--c:${winners.color}">
        <div class="dare-title">${head}</div>
        <div class="dare-text">${esc(c.dare)}</div>
        ${tally}<div class="small">Voting closes in <span data-until="${c.deadline}"></span></div>
      </div>`;
    }
    let line;
    if (myTeamId === c.owedBy) line = 'Your team accepted the dare. Do it!';
    else if (myTeamId === c.teamId) line = `${esc(losers.name)} accepted your dare!`;
    else line = `${esc(losers.name)} accepted the dare!`;
    return `<div class="cash-banner" style="--c:${losers.color}">
      <div class="dare-title">${line}</div>
      <div class="dare-text">${esc(c.dare)}</div>
      <div class="small">Once it's done, ${esc(winners.name)}'s ${lead}-point lead is banked and the score is tied. The host confirms.</div>
    </div>`;
  }

  // Everything a team can spend its lead on. Open by default when something is affordable.
  function teamShop() {
    const items = state.shop;
    if (picking === `cashOut:${state.me.teamId}`) return `<div class="card cash-offer">${dareComposer('player', state.me.teamId)}</div>`;
    if (picking === 'switch') return `<div class="card cash-offer">${gamePicker('player')}</div>`;
    const any = items.some((i) => i.available);
    const { leader, lead } = leadInfo();
    const headline = any
      ? `💰 You're up by ${lead}! Spend it?`
      : `💰 Team shop${leader.id === state.me.teamId && lead > 0 ? ` · up by ${lead}` : ''}`;
    const pickKey = { cashOut: `cashOut:${state.me.teamId}`, switchGame: 'switch' };
    return `<details class="card shop ${any ? 'cash-offer' : ''}" ${any ? 'open' : ''}>
      <summary class="dare-title">${headline}</summary>
      ${items
        .map(
          (i) => `<div class="shop-item">
            <div class="grow"><strong>${esc(i.name)}</strong> <span class="price">${esc(i.cost)}</span>
              <div class="small muted">${esc(i.what)}</div>
              ${i.available ? '' : `<div class="small why">${esc(i.reason)}</div>`}
            </div>
            <button data-pick="${pickKey[i.id]}" ${i.available ? '' : 'disabled'}>Buy</button>
          </div>`,
        )
        .join('')}
    </details>`;
  }

  function announcementBanner() {
    const a = state.announcement;
    if (!a || a.id === dismissedAnnouncement) return '';
    const t = a.teamId && team(a.teamId);
    return `<div class="announce" style="--c:${t ? t.color : 'var(--accent)'}">${esc(a.text)}</div>`;
  }

  function leadInfo() {
    const [a, b] = [...state.teams].sort((x, y) => y.score - x.score);
    return { leader: a, lead: a.score - b.score };
  }

  // What game screens get to work with.
  const gameCtx = (role) => ({ state, esc, team, role, stream: (msg) => socket.emit('game:stream', msg) });

  function playerHtml() {
    const me = state.me;
    const myTeam = team(me.teamId);
    document.body.style.setProperty('--team', myTeam.color);
    // While a game runs, team + score shrink to one bar so the game sits at the top of the screen.
    const top = state.game
      ? `<div class="mini-head">
          <span class="team-pill">🔒 ${esc(myTeam.name)} · ${esc(me.name)}</span>
          <span class="mini-score">${state.teams.map((t) => `<b style="color:${t.color}">${t.score}</b>`).join(' – ')}</span>
        </div>
        <div class="mini-game muted small">Round ${state.game.round}: ${esc(state.game.name)} · game ${esc(state.code)}</div>`
      : `<div class="team-banner">
          <div class="small">🔒 You're on</div>
          <div class="team-name">${esc(myTeam.name)}</div>
          <div class="small">${esc(me.name)} · game <strong>${esc(state.code)}</strong></div>
        </div>
        ${scoreboard()}
        ${gameHeader()}`;
    return `
      <section class="player">
        ${top}
        ${cashOutBanner(me.teamId)}
        ${state.shop.some((i) => i.available) || !state.game ? teamShop() : ''}
        <div class="game">${gameBody('player')}</div>
        ${state.game && !state.shop.some((i) => i.available) ? teamShop() : ''}
        <details class="card roster"><summary>Your teammates (${myTeam.players.length})</summary>
          <ul>${myTeam.players.map((p) => `<li class="${p.connected ? '' : 'muted'}">${esc(p.name)}</li>`).join('')}</ul>
        </details>
      </section>`;
  }

  function hostCashOut() {
    const c = state.cashOut;
    if (c && c.status === 'voting') {
      return `<div class="card">
        ${cashOutBanner()}
        <p class="small muted">Written by ${esc(c.by)}. Nobody voting? Decide for them:</p>
        <div class="row">
          <button class="good" data-send="host" data-type="dareAccept">Accept for them</button>
          <button class="danger" data-send="host" data-type="dareReject">Reject for them</button>
          <button class="secondary" data-send="host" data-type="cashOutCancel">Cancel</button>
        </div>
      </div>`;
    }
    if (c) {
      return `<div class="card">
        ${cashOutBanner()}
        <div class="row">
          <button class="big good" data-send="host" data-type="cashOutDone">Dare done ✓</button>
          <button class="big secondary" data-send="host" data-type="cashOutCancel">Cancel</button>
        </div>
      </div>`;
    }
    const eligible = state.canCashOut.host;
    if (!eligible.length) return '';
    const t = team(eligible[0]);
    if (picking === `cashOut:${t.id}`) return `<div class="card">${dareComposer('host', t.id)}</div>`;
    return `<div class="card cash-offer"><div class="row">
      <span class="grow">💰 ${esc(t.name)} can cash out (up by ${leadInfo().lead})</span>
      <button data-pick="cashOut:${t.id}">Cash out for them</button>
    </div></div>`;
  }

  // Does the host need to look at the menu? (Shown as a dot on the menu button.)
  const hostNeeded = () => !!state.cashOut;

  function hostHtml() {
    // A host who plays sees their normal player screen with a slim bar to open the host menu.
    if (state.me && hostTab === 'play') {
      return `<div class="host-bar">
          <span class="small muted">You're the host</span>
          <button class="host-menu-btn" data-tab="host">⚙️ Host menu${hostNeeded() ? '<span class="attn"></span>' : ''}</button>
        </div>${playerHtml()}`;
    }
    const bar = state.me
      ? `<div class="host-bar sticky"><strong>⚙️ Host menu</strong><button class="host-menu-btn back" data-tab="play">← Back to the game</button></div>`
      : '';
    document.body.style.removeProperty('--team');
    const running = state.game && Date.now() + clockOffset - state.game.startedAt;
    return `
      ${bar}
      <section class="host">
        <div class="card code-card">
          <div class="muted small">Code word</div>
          <div class="code">${esc(state.code)}</div>
          <div class="muted small">Players go to <strong>${esc(location.host)}</strong> and enter this code</div>
          <img class="qr" src="/qr/${esc(state.code)}.svg" alt="QR code to join">
        </div>

        ${scoreboard()}

        ${hostCashOut()}

        <div class="card">
          <h2>Points</h2>
          ${state.teams
            .map(
              (t) => `<div class="row" style="--c:${t.color}">
                <span class="dot"></span><span class="grow">${esc(t.name)}</span>
                ${[-1, 1, 5]
                  .map((n) => `<button class="pill" data-send="host" data-type="addPoints" data-payload='${JSON.stringify({ teamId: t.id, points: n })}'>${n > 0 ? '+' : ''}${n}</button>`)
                  .join('')}
              </div>`,
            )
            .join('')}
        </div>

        <div class="card">
          ${gameHeader()}
          ${running > 60 * 60 * 1000 ? '<p class="nudge">This game has been going over an hour. Time for a new one?</p>' : ''}
          <div class="game">${gameBody('host')}</div>
          ${picking === 'hostSwitch'
            ? gamePicker('host')
            : `<div class="row quick-switch">
                <span class="grow small muted">Crowd bored?</span>
                <button class="secondary" data-send="host" data-type="randomGame" ${state.allGames.length > (state.game ? 1 : 0) ? '' : 'disabled'}>🎲 Random game</button>
                <button class="secondary" data-pick="hostSwitch">Switch…</button>
              </div>`}
        </div>

        <div class="card">
          <h2>Pick the next game</h2>
          ${state.games
            .map(
              (g) => `<div class="game-pick">
                <div class="grow"><strong>${esc(g.name)}</strong><div class="muted small">${esc(g.description)}</div></div>
                <button data-send="host" data-type="setGame" data-payload='${JSON.stringify({ gameId: g.id })}' ${state.game && state.game.id === g.id ? 'disabled' : ''}>${state.game && state.game.id === g.id ? 'Playing' : 'Start'}</button>
              </div>`,
            )
            .join('')}
          ${state.game ? `<button class="link" data-send="host" data-type="setGame" data-payload='{"gameId":null}'>Stop game (intermission)</button>` : ''}
        </div>

        <div class="card">
          <h2>Teams</h2>
          <div class="teams">
            ${state.teams
              .map(
                (t) => `<div class="team-list" style="--c:${t.color}">
                  <div class="row"><strong class="grow">${esc(t.name)}</strong><button class="link" data-rename="${t.id}">rename</button></div>
                  <ul>${t.players
                    .map(
                      (p) => `<li class="${p.connected ? '' : 'muted'}">${esc(p.name)}${p.connected ? '' : ' (away)'}
                        <button class="x" title="Remove" data-remove="${p.id}" data-name="${esc(p.name)}">×</button></li>`,
                    )
                    .join('') || '<li class="muted">Nobody yet</li>'}</ul>
                </div>`,
              )
              .join('')}
          </div>
          ${state.me ? '' : '<button id="host-join" class="secondary" data-act="host-join">Join a team myself</button>'}
        </div>

        ${state.log.length ? `<div class="card"><h2>Recent points</h2><ul class="log">${state.log
          .map((l) => `<li><span class="dot" style="--c:${team(l.teamId).color}"></span>${l.points > 0 ? '+' : ''}${l.points} ${esc(team(l.teamId).name)} <span class="muted">${esc(l.reason)}</span></li>`)
          .join('')}</ul></div>` : ''}

        <div class="card">
          <h2>Team shop prices</h2>
          <div class="row"><span class="grow">Switch game costs</span>
            ${[10, 15, 20, 30]
              .map((n) => `<button class="pill ${state.switchPrice === n ? 'active' : ''}" data-send="host" data-type="setSwitchPrice" data-payload='{"price":${n}}'>${n}</button>`)
              .join('')}
          </div>
          <div class="row"><span class="grow">Teams can't switch until a game has run</span>
            ${[0, 10, 20, 30]
              .map((n) => `<button class="pill ${state.switchMinMinutes === n ? 'active' : ''}" data-send="host" data-type="setSwitchMinMinutes" data-payload='{"minutes":${n}}'>${n}m</button>`)
              .join('')}
          </div>
          <div class="row"><span class="grow">Lead needed to cash out</span>
            ${[5, 10, 15, 20]
              .map((n) => `<button class="pill ${state.cashOutLead === n ? 'active' : ''}" data-send="host" data-type="setCashOutLead" data-payload='{"lead":${n}}'>${n}</button>`)
              .join('')}
            <button class="pill ${[5, 10, 15, 20].includes(state.cashOutLead) ? '' : 'active'}" id="custom-lead" data-act="custom-lead">${[5, 10, 15, 20].includes(state.cashOutLead) ? '…' : state.cashOutLead}</button>
          </div>
        </div>

        <div class="card danger-zone">
          <h2>Wrap up</h2>
          <button id="reset-scores" class="secondary" data-act="reset-scores">Reset scores to 0</button>
          <button id="end-game" class="danger" data-act="end-game">End game for everyone</button>
          <p class="muted small">Ending the game unlocks everyone's phones so they can join a fresh game.</p>
        </div>
      </section>`;
  }

  function tvHtml() {
    document.body.className = 'tv-mode';
    return `
      <section class="tv">
        <header>
          <div><span class="muted">Join at</span> <strong>${esc(location.host)}</strong> <span class="muted">code</span> <strong class="code">${esc(state.code)}</strong></div>
          <img class="qr" src="/qr/${esc(state.code)}.svg" alt="">
        </header>
        ${scoreboard({ big: !state.game })}
        ${cashOutBanner()}
        ${gameHeader()}
        <div class="game">${gameBody('tv')}</div>
      </section>`;
  }

  function screenHtml() {
    if (state.role === 'tv') return tvHtml();
    if (state.isHost) return hostHtml();
    if (state.me) return playerHtml();
    return '';
  }

  function render() {
    if (!state) return;
    renderGame();
    // Let the current game hook into the fresh DOM (e.g. re-attach a drawing canvas).
    const view = state.game && GameViews[state.game.id];
    if (view && view.mounted) view.mounted(state.game.view, gameCtx(state.role === 'tv' ? 'tv' : state.isHost && hostTab === 'host' ? 'host' : 'player'));
  }

  function renderGame() {
    const a = state.announcement;
    const html = (a && a.id !== dismissedAnnouncement ? announcementBanner() : '') + screenHtml();
    if (a && a.id !== dismissedAnnouncement && !announceTimer)
      announceTimer = setTimeout(() => {
        dismissedAnnouncement = a.id;
        announceTimer = null;
        render();
      }, Math.max(1000, 8000 - (Date.now() + clockOffset - a.at)));
    if (html === lastHtml) return;
    lastHtml = html;
    const focused = document.activeElement && document.activeElement.id && app.contains(document.activeElement) ? document.activeElement : null;
    const sel = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;
    app.innerHTML = html;
    if (focused) {
      const el = document.getElementById(focused.id);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel) el.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  // ---------- events ----------
  const handleResult = (res) => res && res.error && toast(res.error);

  // Pressing Enter in a text box clicks its submit button.
  app.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.id) return;
    const btn = document.querySelector(`[data-submit="${e.target.id}"]`);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  });

  app.addEventListener('input', (e) => {
    if (e.target.id) drafts[e.target.id] = e.target.value;
  });

  app.addEventListener('click', async (e) => {
    // A button that sends what was typed into a text box as a game action, then clears it.
    const submit = e.target.closest('[data-submit]');
    if (submit) {
      const id = submit.dataset.submit;
      const text = (drafts[id] || '').trim();
      if (!text) return;
      drafts[id] = '';
      const res = await call('player:action', { action: submit.dataset.action, payload: { text } });
      if (res.error) toast(res.error);
      const input = document.getElementById(id);
      if (input) {
        input.value = '';
        input.focus();
      }
      return;
    }
    const hostAct = e.target.closest('[data-act="host-join"], [data-act="custom-lead"], [data-act="reset-scores"], [data-act="end-game"]');
    if (hostAct) {
      const what = hostAct.dataset.act;
      if (what === 'host-join') {
        const name = prompt('Your name:');
        if (!name) return;
        const res = await call('player:join', { code: state.code, name });
        if (res.error) return toast(res.error);
        saveSession({ ...loadSession(), playerId: res.playerId, playerToken: res.playerToken });
        hostTab = 'play';
      } else if (what === 'custom-lead') {
        const lead = prompt('Lead needed to cash out:', state.cashOutLead);
        if (lead) call('host:action', { type: 'setCashOutLead', lead: Number(lead) }).then(handleResult);
      } else if (what === 'reset-scores') {
        if (confirm('Reset both scores to 0?')) call('host:action', { type: 'resetScores' }).then(handleResult);
      } else if (confirm('End the game for everyone? Teams and scores will be wiped.')) call('host:action', { type: 'endGame' });
      return;
    }
    const act = e.target.closest('[data-act="send-dare"]');
    if (act) {
      const dare = (drafts['dare-input'] || '').trim();
      const res =
        act.dataset.who === 'host'
          ? await call('host:action', { type: 'cashOut', teamId: act.dataset.team, dare })
          : await call('player:action', { action: 'cashOut', payload: { dare } });
      if (res.error) return toast(res.error);
      drafts['dare-input'] = '';
      picking = null;
      return render();
    }
    // Taps a game handles on the phone itself (e.g. choosing cards before submitting).
    const local = e.target.closest('[data-local]');
    if (local && state && state.game) {
      const view = GameViews[state.game.id];
      if (view && view.local) view.local(local.dataset, state.game.view);
      return render();
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      hostTab = tab.dataset.tab;
      render();
      window.scrollTo(0, 0); // switching between the game and the host menu starts at the top
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      picking = pick.dataset.pick || null;
      return render();
    }
    const send = e.target.closest('[data-send]');
    if (send) {
      if (send.closest('.dare-picker')) picking = null;
      const payload = JSON.parse(send.dataset.payload || '{}');
      if (navigator.vibrate && send.dataset.vibrate) navigator.vibrate(60);
      if (send.dataset.send === 'host') call('host:action', { type: send.dataset.type, ...payload }).then(handleResult);
      else call('player:action', payload).then(handleResult);
      return;
    }
    const rename = e.target.closest('[data-rename]');
    if (rename) {
      const name = prompt('New team name:', team(rename.dataset.rename).name);
      if (name) call('host:action', { type: 'renameTeam', teamId: rename.dataset.rename, name }).then(handleResult);
      return;
    }
    const remove = e.target.closest('[data-remove]');
    if (remove && confirm(`Remove ${remove.dataset.name} from the game?`)) {
      call('host:action', { type: 'removePlayer', playerId: remove.dataset.remove }).then(handleResult);
    }
  });

  socket.on('state', (s) => {
    const prev = state;
    state = s;
    // Buzz the dared team's phones when a dare arrives.
    if (s.cashOut && !(prev && prev.cashOut) && s.me && s.me.teamId === s.cashOut.owedBy && navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (s.cashOut) picking = null;
    clockOffset = s.serverTime - Date.now();
    render();
  });

  socket.on('game:stream', (msg) => {
    const view = state && state.game && GameViews[state.game.id];
    if (view && view.onStream) view.onStream(msg, state.game.view);
  });

  socket.on('room:closed', () => {
    clearSession();
    history.replaceState(null, '', '/');
    renderHome();
    toast('The host ended the game');
  });

  socket.on('player:removed', () => {
    const s = loadSession();
    if (s && s.hostToken) {
      saveSession({ code: s.code, hostToken: s.hostToken });
      hostTab = 'host';
      return;
    }
    clearSession();
    renderHome();
    toast('The host removed you from the game');
  });

  // On every (re)connect, rejoin whatever this phone was part of.
  socket.on('connect', async () => {
    const params = new URLSearchParams(location.search);
    const session = loadSession();
    if (session) {
      const res = await call('session:resume', session);
      if (!res.error) {
        // The player record may be gone (e.g. host removed us) while host access remains.
        if (!res.isPlayer && session.playerId) saveSession({ code: session.code, hostToken: session.hostToken });
        return;
      }
      clearSession();
    }
    if (params.get('tv')) {
      const res = await call('tv:watch', { code: params.get('tv') });
      if (!res.error) return;
      toast(res.error);
    }
    if (!document.getElementById('join')) renderHome(params.get('code') || '');
  });

  const fmtLeft = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  function tick(onlyEmpty) {
    const now = Date.now() + clockOffset;
    for (const el of document.querySelectorAll(`[data-since]${onlyEmpty ? ':empty' : ''}`)) el.textContent = fmtElapsed(now - Number(el.dataset.since));
    for (const el of document.querySelectorAll(`[data-until]${onlyEmpty ? ':empty' : ''}`)) {
      const left = Number(el.dataset.until) - now;
      el.textContent = fmtLeft(left);
      el.classList.toggle('urgent', left < 10000);
    }
  }
  setInterval(() => tick(false), 1000);
  // Fill timers immediately after each render too.
  new MutationObserver(() => tick(true)).observe(app, { childList: true, subtree: true });
})();
