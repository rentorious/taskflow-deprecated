// A hosted app with sign-in switched on, a stand-in GitHub behind it, and browsers
// that keep their own cookies.

import { createServer } from 'node:net';
import { createHostedApp } from '../../app.mjs';
import { testDb } from './db.mjs';
import { fakeGithub } from './github.mjs';

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

let nextGithubId = 1000;
export const profile = (login, extra = {}) => ({ id: nextGithubId++, login, name: `${login} (test)`, avatar_url: `https://avatars.example.com/${login}`, ...extra });

export async function startHosted({ admins = ['ann'], secureCookies = false, push = null, pushFetch } = {}) {
  const t = await testDb();
  const github = await fakeGithub();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createHostedApp({
    db: t.db, publicUrl: origin, version: 'test', github: github.endpoints,
    auth: { clientId: github.clientId, clientSecret: github.clientSecret, sessionSecret: 'x'.repeat(40), admins, secureCookies },
    push, ...(pushFetch ? { pushFetch } : {}),
  });
  await app.listen({ host: '127.0.0.1', port });

  /** Cookies per browser; redirects followed by hand so every hop can be looked at. */
  function browser() {
    const jar = new Map();
    const hops = [];
    async function request(path, { method = 'GET', headers = {}, body, form, json, follow = true, origin: sendOrigin = true } = {}) {
      let url = new URL(path, origin);
      let init = { method, headers: { ...headers }, redirect: 'manual' };
      if (form) { init.body = new URLSearchParams(form).toString(); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
      if (json) { init.body = JSON.stringify(json); init.headers['Content-Type'] = 'application/json'; }
      if (body !== undefined) init.body = body;
      if (method !== 'GET' && sendOrigin) init.headers.Origin = origin;
      for (let hop = 0; hop < 8; hop++) {
        const ours = url.origin === origin;
        const cookie = ours ? [...jar].filter(([, c]) => url.pathname.startsWith(c.path)).map(([name, c]) => `${name}=${c.value}`).join('; ') : '';
        const res = await fetch(url, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) } });
        if (ours) for (const line of res.headers.getSetCookie()) {
          const [pair, ...attrs] = line.split(';').map((s) => s.trim());
          const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
          const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? '/';
          if (/max-age=0/i.test(line)) jar.delete(name); else jar.set(name, { value, path, attrs: line });
        }
        hops.push(`${res.status} ${url.pathname}`);
        if (!follow || ![301, 302, 303, 307, 308].includes(res.status)) return res;
        url = new URL(res.headers.get('location'), url);
        if (res.status === 303 || res.status === 302) init = { method: 'GET', headers: {}, redirect: 'manual' };
      }
      throw new Error('too many redirects');
    }
    return {
      jar, hops, request,
      get: (path, options) => request(path, options),
      post: (path, options) => request(path, { method: 'POST', ...options }),
      /** The whole dance: our server, "GitHub", and back. */
      async signIn(who, { next } = {}) {
        github.as(who);
        return request(`/auth/github${next ? `?next=${encodeURIComponent(next)}` : ''}`);
      },
    };
  }

  return { t, db: t.db, app, github, origin, port, browser, close: async () => { await app.close(); await github.close(); await t.close(); } };
}
