/* OMP Pocket service worker — plain JS, no build step. */
// Обновление без ручных перезапусков PWA: новая версия сразу активируется
// и перехватывает окна (кэша ассетов нет — бояться разрыва нечего).
self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	let payload = { title: "OMP Pocket", body: "", url: "/" };
	try {
		const data = JSON.parse(event.data ? event.data.text() : "{}");
		if (typeof data.title === "string") payload.title = data.title;
		if (typeof data.body === "string") payload.body = data.body;
		if (typeof data.url === "string") payload.url = data.url;
	} catch (e) {
		// malformed payload — show the default
	}
	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			icon: "/notify-192.png",
			badge: "/notify-192.png",
			renotify: true,
			tag: "omp-pocket",
			data: { url: payload.url },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = (event.notification.data && event.notification.data.url) || "/";
	event.waitUntil(
		(async () => {
			const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of clients) {
				if (!("focus" in client)) continue;
				// Reuse an open window: focus it and point it at the target.
				if ("navigate" in client) {
					try {
						await client.navigate(url);
					} catch (e) {
						// Cross-origin or closed: opening a new window below still covers it.
					}
				}
				return client.focus();
			}
			return self.clients.openWindow(url);
		})(),
	);
});

// Subscription rotated by the browser (push service expiry, permission cycle):
// re-subscribe best-effort; if that is impossible, at least clear the dead
// subscription on the gateway.
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(
		(async () => {
			const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
			const vapid = await fetch("/api/push/vapid").then((r) => r.json()).then((d) => d.publicKey).catch(() => null);
			try {
				const sub = await self.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: vapid,
				});
				await fetch("/api/push/subscribe", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...sub.toJSON(), authOk: true, replacedEndpoint: oldEndpoint }),
				});
			} catch (e) {
				// Cannot re-subscribe (e.g. permission revoked): drop the stale record.
				if (oldEndpoint) {
					await fetch("/api/push/subscribe", {
						method: "DELETE",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ endpoint: oldEndpoint }),
					}).catch(() => {});
				}
			}
		})(),
	);
});
