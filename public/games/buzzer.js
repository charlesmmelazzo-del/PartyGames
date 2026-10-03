// Screens for the Buzzer Round. Each function returns HTML for one role.
// Buttons with data-send="player"/"host" are wired up by app.js.
window.GameViews = window.GameViews || {};

window.GameViews.buzzer = {
  player(v, { esc, team }) {
    if (v.status === 'buzzed') {
      const t = team(v.buzz.teamId);
      return `<div class="buzz-result" style="--c:${t.color}">
        ${v.iBuzzed ? '<div class="huge">You buzzed first!</div><div>Answer out loud</div>' : `<div class="huge">${esc(v.buzz.name)}</div><div>buzzed for ${esc(t.name)}</div>`}
      </div>`;
    }
    if (v.canBuzz) {
      return `<button class="buzzer" data-send="player" data-vibrate="1" data-payload='{"action":"buzz"}'>BUZZ</button>`;
    }
    const lockedOut = v.status === 'open';
    return `<button class="buzzer off" disabled>${lockedOut ? 'Your team is out this time' : 'Wait for the host…'}</button>`;
  },

  host(v, { esc, team }) {
    const pts = [1, 2, 3, 5]
      .map((n) => `<button class="pill ${v.points === n ? 'active' : ''}" data-send="host" data-type="game" data-payload='${JSON.stringify({ action: 'setPoints', payload: { points: n } })}'>${n}</button>`)
      .join('');
    const btn = (action, label, cls = '') => `<button class="${cls}" data-send="host" data-type="game" data-payload='{"action":"${action}"}'>${label}</button>`;
    let body;
    if (v.status === 'closed') body = btn('open', 'Open buzzers', 'big');
    else if (v.status === 'open')
      body = `<p class="center">Buzzers are open…${v.lockedOut.length ? ` (${v.lockedOut.map((id) => esc(team(id).name)).join(', ')} out)` : ''}</p>${btn('close', 'Close buzzers', 'secondary')}`;
    else {
      const t = team(v.buzz.teamId);
      body = `<div class="buzz-result" style="--c:${t.color}"><div class="huge">${esc(v.buzz.name)}</div><div>${esc(t.name)}</div></div>
        <div class="row">${btn('correct', `Correct (+${v.points})`, 'big good')}${btn('wrong', 'Wrong', 'big danger')}</div>`;
    }
    return `<div class="row"><span class="grow">Points per question</span>${pts}</div>${body}`;
  },

  tv(v, { esc, team }) {
    if (v.status === 'buzzed') {
      const t = team(v.buzz.teamId);
      return `<div class="buzz-result tv-big" style="--c:${t.color}"><div class="huge">${esc(v.buzz.name)}</div><div>${esc(t.name)}</div></div>`;
    }
    return `<div class="center tv-status">${v.status === 'open' ? 'Buzzers open! Grab your phones' : 'Get ready…'}</div>`;
  },
};
