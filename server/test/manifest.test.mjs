// The account pages are installable too: one manifest for the whole server, linked from every page.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { profile, startHosted } from './helpers/hosted.mjs';

describe('the root manifest', () => {
  let h;
  before(async () => { h = await startHosted({ admins: ['ann'] }); });
  after(async () => { await h.close().catch(() => {}); });

  test('every account page links the manifest, and the manifest and icons are public', async () => {
    const ann = h.browser();
    let res = await ann.get('/');
    assert.match(await res.text(), /<link rel="manifest" href="\/manifest.webmanifest"/, 'signed out');
    await ann.signIn(profile('ann'));
    res = await ann.get('/settings');
    assert.match(await res.text(), /<link rel="manifest" href="\/manifest.webmanifest"/, 'signed in');
    assert.match(res.headers.get('content-security-policy'), /manifest-src 'self'/);

    res = await fetch(new URL('/manifest.webmanifest', h.origin));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/manifest+json');
    const manifest = await res.json();
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.start_url, '/');
    for (const icon of manifest.icons) {
      const got = await fetch(new URL(icon.src, h.origin));
      assert.equal(got.status, 200, icon.src);
      assert.equal(got.headers.get('content-type'), icon.type);
    }
  });
});
