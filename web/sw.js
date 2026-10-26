// SafeTemp service worker: shows alert notifications, even when the app isn't open.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "SafeTemp alert", {
      body: data.body || "",
      icon: "icon.svg",
      badge: "icon.svg",
      tag: data.tag, // the same alert never stacks up twice
      data: { url: data.url || "./" },
    })
  );
});

// Tapping a notification opens SafeTemp (or brings it to the front if it's already open).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url || "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
