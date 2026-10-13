/* OMP Pocket service worker — plain JS, no build step. */
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
			icon: "./favicon-192x192.png",
			badge: "./favicon-32x32.png",
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
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				if ("focus" in client) return client.focus();
			}
			return self.clients.openWindow(url);
		}),
	);
});
