/* global io, GameViews */
(() => {
  const SESSION_KEY = 'pg:session';
  const app = document.getElementById('app');
  const socket = io();

  let state = null; // latest snapshot from the server
  let clockOffset = 0; // serverTime - Date.now()
  let hostTab = 'host'; // when the host is also a player: 'host' | 'play'

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
    document.getElementById('create').onclick = async () => {
      const res = await call('host:create', {});
      if (res.error) return toast(res.error);
      saveSession({ code: res.code, hostToken: res.hostToken });
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
    return view[role](state.game.view, { state, esc, team });
  }

  function renderPlayer() {
    const me = state.me;
    const myTeam = team(me.teamId);
    document.body.style.setProperty('--team', myTeam.color);
    app.innerHTML = `
      <section class="player">
        <div class="team-banner">
          <div class="small">🔒 You're on</div>
          <div class="team-name">${esc(myTeam.name)}</div>
          <div class="small">${esc(me.name)} · game <strong>${esc(state.code)}</strong></div>
        </div>
        ${scoreboard()}
        ${gameHeader()}
        <div class="game">${gameBody('player')}</div>
        <details class="card roster"><summary>Your teammates (${myTeam.players.length})</summary>
          <ul>${myTeam.players.map((p) => `<li class="${p.connected ? '' : 'muted'}">${esc(p.name)}</li>`).join('')}</ul>
        </details>
      </section>`;
  }

  function renderHost() {
    const tabs = state.me
      ? `<nav class="tabs">
          <button data-tab="host" class="${hostTab === 'host' ? 'active' : ''}">Host controls</button>
          <button data-tab="play" class="${hostTab === 'play' ? 'active' : ''}">My team</button>
        </nav>`
      : '';
    if (state.me && hostTab === 'play') {
      renderPlayer();
      app.insertAdjacentHTML('afterbegin', tabs);
      return;
    }
    document.body.style.removeProperty('--team');
    const running = state.game && Date.now() + clockOffset - state.game.startedAt;
    app.innerHTML = `
      ${tabs}
      <section class="host">
        <div class="card code-card">
          <div class="muted small">Code word</div>
          <div class="code">${esc(state.code)}</div>
          <div class="muted small">Players go to <strong>${esc(location.host)}</strong> and enter this code</div>
          <img class="qr" src="/qr/${esc(state.code)}.svg" alt="QR code to join">
        </div>

        ${scoreboard()}

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
          ${state.me ? '' : '<button id="host-join" class="secondary">Join a team myself</button>'}
        </div>

        ${state.log.length ? `<div class="card"><h2>Recent points</h2><ul class="log">${state.log
          .map((l) => `<li><span class="dot" style="--c:${team(l.teamId).color}"></span>${l.points > 0 ? '+' : ''}${l.points} ${esc(team(l.teamId).name)} <span class="muted">${esc(l.reason)}</span></li>`)
          .join('')}</ul></div>` : ''}

        <div class="card danger-zone">
          <h2>Wrap up</h2>
          <button id="reset-scores" class="secondary">Reset scores to 0</button>
          <button id="end-game" class="danger">End game for everyone</button>
          <p class="muted small">Ending the game unlocks everyone's phones so they can join a fresh game.</p>
        </div>
      </section>`;

    const hj = document.getElementById('host-join');
    if (hj)
      hj.onclick = async () => {
        const name = prompt('Your name:');
        if (!name) return;
        const res = await call('player:join', { code: state.code, name });
        if (res.error) return toast(res.error);
        saveSession({ ...loadSession(), playerId: res.playerId, playerToken: res.playerToken });
      };
    document.getElementById('reset-scores').onclick = () => {
      if (confirm('Reset both scores to 0?')) call('host:action', { type: 'resetScores' }).then(handleResult);
    };
    document.getElementById('end-game').onclick = () => {
      if (confirm('End the game for everyone? Teams and scores will be wiped.')) call('host:action', { type: 'endGame' });
    };
  }

  function renderTv() {
    document.body.className = 'tv-mode';
    app.innerHTML = `
      <section class="tv">
        <header>
          <div><span class="muted">Join at</span> <strong>${esc(location.host)}</strong> <span class="muted">code</span> <strong class="code">${esc(state.code)}</strong></div>
          <img class="qr" src="/qr/${esc(state.code)}.svg" alt="">
        </header>
        ${scoreboard({ big: true })}
        ${gameHeader()}
        <div class="game">${gameBody('tv')}</div>
      </section>`;
  }

  function render() {
    if (!state) return;
    if (state.role === 'tv') return renderTv();
    if (state.isHost) return renderHost();
    if (state.me) return renderPlayer();
  }

  // ---------- events ----------
  const handleResult = (res) => res && res.error && toast(res.error);

  app.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      hostTab = tab.dataset.tab;
      return render();
    }
    const send = e.target.closest('[data-send]');
    if (send) {
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
    state = s;
    clockOffset = s.serverTime - Date.now();
    render();
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

  setInterval(() => {
    const now = Date.now() + clockOffset;
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = fmtElapsed(now - Number(el.dataset.since));
  }, 1000);
  // Fill timers immediately after each render too.
  new MutationObserver(() => {
    const now = Date.now() + clockOffset;
    for (const el of document.querySelectorAll('[data-since]:empty')) el.textContent = fmtElapsed(now - Number(el.dataset.since));
  }).observe(app, { childList: true, subtree: true });
})();
