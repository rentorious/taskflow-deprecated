// The pages around the dashboard, rendered here as plain HTML: sign-in, the
// project list, settings. No script. Everything that came from a person or from
// GitHub goes through `esc` on its way into the markup; `html` does that for every
// interpolated value unless it was itself produced by `html`.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

class Safe { constructor(text) { this.text = text; } toString() { return this.text; } }

/** Tagged template: values are escaped, arrays are joined, nested `html` results pass through. */
export function html(strings, ...values) {
  const render = (value) => (value instanceof Safe ? value.text : Array.isArray(value) ? value.map(render).join('') : value === false || value === null || value === undefined ? '' : esc(value));
  return new Safe(strings.reduce((out, part, i) => out + part + (i < values.length ? render(values[i]) : ''), ''));
}

// These pages post plain forms, so unlike the dashboard they allow form-action 'self'. Still no script at all.
export const ACCOUNT_CSP = ["default-src 'none'", "style-src 'self'", "font-src 'self'", "img-src 'self'", "manifest-src 'self'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');

function layout({ title, user = null, body }) {
  return `<!doctype html>\n${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${title} · Taskflow</title>
<link rel="stylesheet" href="/assets/account.css">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-180.png">
<meta name="theme-color" content="#16222c">
</head>
<body>
<main>
<header class="top">
  <h1 class="wordmark"><a href="/">Taskflow</a></h1>
  ${user ? html`<nav aria-label="Account">
    <span class="quiet">${user.login}</span>
    <a href="/">Projects</a>
    <a href="/settings">Settings</a>
    <form method="post" action="/auth/logout"><button class="quiet" type="submit">Sign out</button></form>
  </nav>` : ''}
</header>
${body}
</main>
</body>
</html>`}`;
}

export function signInPage({ next = '/', notice = null }) {
  return layout({
    title: 'Sign in',
    body: html`
      ${notice ? html`<div class="card trouble"><p>${notice}</p></div>` : ''}
      <div class="card mark">
        <h2>Sign in</h2>
        <p>This dashboard holds client ticket text, so it is for invited people only. GitHub is asked who you are and nothing else: no scopes, no access to repositories.</p>
        <p><a class="button primary" href="/auth/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a></p>
      </div>`,
  });
}

export function notInvitedPage({ login }) {
  return layout({
    title: 'Not invited',
    body: html`<div class="card trouble">
      <h2>Not invited</h2>
      <p>GitHub says you are <strong>${login}</strong>. Nobody has invited that login to a project here, so there is nothing to show.</p>
      <p class="quiet">Ask a project admin to invite <code>${login}</code>, then sign in again. Nothing about you was stored.</p>
      <p><a class="button" href="/">Back</a></p>
    </div>`,
  });
}

export function messagePage({ title, message, user = null }) {
  return layout({ title, user, body: html`<div class="card trouble"><h2>${title}</h2><p>${message}</p><p><a class="button" href="/">Back</a></p></div>` });
}

const when = (date) => (date ? new Date(date).toISOString().slice(0, 16).replace('T', ' ') : 'never');

export function homePage({ user, projects }) {
  return layout({
    title: 'Projects',
    user,
    body: html`
      <h2>Projects</h2>
      ${projects.length ? '' : html`<div class="card"><p>You are not in a project yet.${user.isInstanceAdmin ? html` Create one in <a href="/settings">Settings</a>.` : ' Ask an admin for an invite.'}</p></div>`}
      ${projects.map((p) => html`<div class="card">
        <h3>${p.name} <span class="quiet">· ${p.role}</span></h3>
        ${p.role === 'answerer'
          ? html`<p class="quiet">You are here to answer questions. That view is not built yet.</p>`
          : p.cycles.length
            ? html`<ul class="plain">${p.cycles.map((c) => html`<li>
                <a class="grow" href="/p/${p.id}/u/${c.login}/">${c.login === user.login ? 'Your cycle' : `${c.login}'s cycle`}</a>
                <span class="quiet">pushed ${when(c.pushedAt)} UTC</span>
              </li>`)}</ul>`
            : html`<p class="quiet">Nothing has been pushed yet. Run <code>taskflow push</code> in the project.</p>`}
      </div>`)}`,
  });
}

const roleSelect = (selected) => html`<select name="role" aria-label="Role">${['developer', 'admin', 'answerer'].map((r) => html`<option value="${r}"${r === selected ? new Safe(' selected') : ''}>${r}</option>`)}</select>`;

/**
 * @param {object} view
 * @param {{id, label, createdAt, lastUsedAt}[]} view.tokens
 * @param {string|null} view.newToken  shown once, straight after it was made
 * @param {{id, name, members, invites}[]} view.managed  projects this person may manage
 */
export function settingsPage({ user, tokens, canHoldTokens, newToken = null, managed, canCreateProject, error = null, serverUrl }) {
  return layout({
    title: 'Settings',
    user,
    body: html`
      ${error ? html`<div class="card trouble"><p>${error}</p></div>` : ''}

      ${canHoldTokens ? html`
      <h2>CLI tokens</h2>
      <p class="quiet">A token lets <code>taskflow</code> on your machine push a cycle and claim a batch as you. It is shown once and only its hash is kept.</p>
      ${newToken ? html`<div class="card mark">
        <p><strong>Copy it now.</strong> It cannot be shown again.</p>
        <code class="token">${newToken}</code>
        <p class="quiet">Then, in the project: <code>node &lt;plugin&gt;/scripts/taskflow.mjs login ${serverUrl}</code></p>
      </div>` : ''}
      <div class="card">
        ${tokens.length ? html`<ul class="plain">${tokens.map((t) => html`<li>
          <span class="grow"><strong>${t.label}</strong><br><span class="quiet">made ${when(t.createdAt)} · last used ${when(t.lastUsedAt)}</span></span>
          <form method="post" action="/settings/tokens/revoke"><input type="hidden" name="id" value="${t.id}"><button class="quiet" type="submit">Revoke</button></form>
        </li>`)}</ul>` : html`<p class="quiet">No tokens yet.</p>`}
        <form class="row" method="post" action="/settings/tokens">
          <label>Name it after the machine<input name="label" maxlength="100" placeholder="laptop" autocomplete="off"></label>
          <button class="primary" type="submit">Create a token</button>
        </form>
      </div>` : ''}

      ${managed.map((p) => html`
      <h2>${p.name} <span class="quiet mono">${p.id}</span></h2>
      <div class="card">
        <ul class="plain">
          ${p.members.map((m) => html`<li>
            <span class="grow"><strong>${m.login}</strong>${m.name ? html` <span class="quiet">${m.name}</span>` : ''}</span>
            <form class="row" method="post" action="/settings/members/role"><input type="hidden" name="project" value="${p.id}"><input type="hidden" name="user" value="${m.id}">${roleSelect(m.role)}<button class="quiet" type="submit">Set</button></form>
            <form method="post" action="/settings/members/remove"><input type="hidden" name="project" value="${p.id}"><input type="hidden" name="user" value="${m.id}"><button class="quiet" type="submit">Remove</button></form>
          </li>`)}
          ${p.invites.map((i) => html`<li>
            <span class="grow"><strong>${i.login}</strong> <span class="quiet">invited as ${i.role}${i.valid ? '' : ' · expired'}</span></span>
            <form method="post" action="/settings/invites/remove"><input type="hidden" name="project" value="${p.id}"><input type="hidden" name="login" value="${i.login}"><button class="quiet" type="submit">Withdraw</button></form>
          </li>`)}
        </ul>
        <form class="row" method="post" action="/settings/members/invite">
          <input type="hidden" name="project" value="${p.id}">
          <label>GitHub login<input name="login" maxlength="40" required autocapitalize="none" autocomplete="off" spellcheck="false"></label>
          ${roleSelect('developer')}
          <button class="primary" type="submit">Invite</button>
        </form>
      </div>`)}

      ${canCreateProject ? html`
      <h2>New project</h2>
      <div class="card">
        <form class="row" method="post" action="/settings/projects">
          <label>Key, as it appears in URLs<input name="id" maxlength="39" required pattern="[a-z0-9][a-z0-9\\-]{1,38}" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="harbor-books"></label>
          <label>Name<input name="name" maxlength="200" placeholder="Harbor Books"></label>
          <button class="primary" type="submit">Create</button>
        </form>
      </div>` : ''}`,
  });
}
