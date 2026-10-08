// What the server is told by its environment, checked before anything listens.
//
// The rule that matters: the dashboard shows client ticket text. Without sign-in
// configured, the server therefore only starts on a loopback address, read-only,
// and says why. Configuring sign-in is what lifts that, not removing a check.
//
//   DATABASE_URL                  required
//   PUBLIC_URL                    required; the origin people open
//   GITHUB_OAUTH_CLIENT_ID        \
//   GITHUB_OAUTH_CLIENT_SECRET     } all four, or none
//   SESSION_SECRET (32+ chars)     }
//   ADMIN_GITHUB_LOGINS           /  comma-separated; the first people allowed in
//   PORT                          where to listen when sign-in is on (hosts inject it)
//   TRUST_PROXY=1                 take the client address from X-Forwarded-For
//   VAPID_PUBLIC_KEY              \ both or none: Web Push to phones, with sign-in on
//   VAPID_PRIVATE_KEY             /  (node server/push.mjs generate-keys)
//   VAPID_SUBJECT                 optional; a mailto: or https: contact for the push service; PUBLIC_URL by default

import { vapidKeys } from './push.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
const AUTH_VARS = ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'SESSION_SECRET', 'ADMIN_GITHUB_LOGINS'];
const PUSH_VARS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
const SUBJECT = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/;
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/;

const refuse = (message) => Object.assign(new Error(message), { config: true });

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{databaseUrl: string, publicUrl: URL, bind: {host: string, port: number}, auth: object|null, trustProxy: boolean, push: {publicKey: string, privateKey: string, subject: string}|null}}
 */
export function readConfig(env) {
  if (!env.DATABASE_URL) throw refuse('DATABASE_URL is not set.');
  if (!env.PUBLIC_URL) throw refuse('PUBLIC_URL is not set. It is the address people open, for example http://127.0.0.1:3900.');

  let url;
  try {
    url = new URL(env.PUBLIC_URL);
  } catch {
    throw refuse(`PUBLIC_URL is not a URL: ${env.PUBLIC_URL}`);
  }
  if (url.username || url.password) throw refuse('PUBLIC_URL must not carry credentials.');
  if (url.pathname !== '/' || url.search || url.hash) throw refuse('PUBLIC_URL is an origin: no path, no query, no fragment.');
  // Compared whole. "127.0.0.1.example.com" starts with a loopback address and is not one.
  const loopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);

  const given = AUTH_VARS.filter((name) => env[name]);
  if (given.length && given.length < AUTH_VARS.length) {
    throw refuse(`Sign-in is half configured. Also set: ${AUTH_VARS.filter((name) => !env[name]).join(', ')}.`);
  }

  const pushGiven = PUSH_VARS.filter((name) => env[name]);
  let push = null;
  if (pushGiven.length && pushGiven.length < PUSH_VARS.length) throw refuse(`Web Push is half configured. Also set: ${PUSH_VARS.filter((name) => !env[name]).join(', ')}.`);
  if (pushGiven.length) {
    // A subscription belongs to a signed-in person; without sign-in there is nobody to notify.
    if (!given.length) throw refuse('Web Push needs sign-in configured: notifications go to signed-in people.');
    try { vapidKeys({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }); } catch (error) { throw refuse(error.message); }
    const subject = env.VAPID_SUBJECT || url.origin;
    if (!SUBJECT.test(subject)) throw refuse('VAPID_SUBJECT must be a mailto: address or an https: URL.');
    push = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject };
  }

  if (!given.length) {
    if (!loopback) {
      throw refuse(`No sign-in is configured, so this server only starts on a loopback address. PUBLIC_URL is ${url.origin}; use http://127.0.0.1:<port>, or set ${AUTH_VARS.join(', ')}. It would otherwise publish ticket text to anyone who can reach it.`);
    }
    if (!url.port) throw refuse('PUBLIC_URL needs a port, for example http://127.0.0.1:3900.');
    // The address is fixed here, never read from the environment: a stray HOST=0.0.0.0 must not open it up.
    return { databaseUrl: env.DATABASE_URL, publicUrl: url, bind: { host: '127.0.0.1', port: Number(url.port) }, auth: null, trustProxy: false, push: null };
  }

  if (env.SESSION_SECRET.length < 32) throw refuse('SESSION_SECRET is too short: 32 characters at least (openssl rand -hex 32).');
  const admins = env.ADMIN_GITHUB_LOGINS.split(',').map((login) => login.trim().toLowerCase()).filter(Boolean);
  if (!admins.length || !admins.every((login) => LOGIN.test(login))) throw refuse('ADMIN_GITHUB_LOGINS must be GitHub logins, comma-separated.');
  // Session cookies must be Secure anywhere but on this machine.
  if (!loopback && url.protocol !== 'https:') throw refuse(`PUBLIC_URL must be https (or loopback http for development): ${url.origin}`);

  let bind;
  if (loopback) {
    if (!url.port) throw refuse('PUBLIC_URL needs a port, for example http://127.0.0.1:3900.');
    bind = { host: '127.0.0.1', port: Number(url.port) };
  } else {
    const port = Number.parseInt(env.PORT ?? '', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw refuse('PORT is not set. The host injects it; set it by hand when running elsewhere.');
    bind = { host: '0.0.0.0', port };
  }

  return {
    databaseUrl: env.DATABASE_URL,
    publicUrl: url,
    bind,
    trustProxy: env.TRUST_PROXY === '1',
    push,
    auth: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      sessionSecret: env.SESSION_SECRET,
      admins,
      secureCookies: url.protocol === 'https:',
    },
  };
}
