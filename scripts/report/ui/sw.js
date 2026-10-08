// The dashboard's service worker: it shows push notifications and opens the page they
// name. Nothing else: no caching, no offline, no fetch handler. Registered at the
// origin's root, so one browser holds one subscription however many boards it opens.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Taskflow', body: event.data ? event.data.text() : '' }; }
  const url = new URL(data.url || '/', self.registration.scope).href;
  event.waitUntil(self.registration.showNotification(data.title || 'Taskflow', {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = new URL(url);
    // A tab already on that board: bring it forward and move it; otherwise open one.
    const open = windows.find((client) => new URL(client.url).pathname === target.pathname) || windows[0];
    if (open) {
      await open.focus();
      if ('navigate' in open) await open.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
