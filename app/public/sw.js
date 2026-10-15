/* OMP Pocket service worker — plain JS, no build step. */
// App-shell офлайн: один кэш 'pocket-shell'. Ядро precache'им в install,
// hashed-ассеты (content-addressed) дописываем из DOM открытой страницы,
// навигация — network-first с откатом в кэш.

const SHELL_CACHE = "pocket-shell";

// Хэшированные имена ассетов: 8 символов [a-z0-9] + расширение
// (bun-хэш: g9pm4d2p.js, av4mkawg.css, …).
const HASHED_RE = /\/[a-z0-9]{8}\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?|ttf)$/i;

const CORE_URLS = [
	"/",
	"/manifest.webmanifest",
	"/notify-192.png",
	"/favicon.ico",
	"/favicon.svg",
	"/favicon.png",
	"/favicon-16x16.png",
	"/favicon-32x32.png",
	"/favicon-180x180.png",
	"/favicon-192x192.png",
	"/favicon-512x512.png",
	"/favicon-maskable-192x192.png",
	"/favicon-maskable-512x512.png",
];

async function cacheAdd(cache, url) {
	// minfresh: не брать ассет из HTTP-кэша браузера — кладём честный сетевой ответ.
	try {
		await cache.add(new Request(url, { cache: "no-cache" }));
	} catch (e) {
		// Отдельный ассет не скачался — shell всё равно может работать без него.
	}
}

// index.html при каждом билде получает новые hashed-имена: парсим DOM
// живой страницы (script[src], link[href]) и кэшируем то, что похоже на ассет.
async function precacheShell() {
	const cache = await caches.open(SHELL_CACHE);
	const urls = new Set(CORE_URLS);
	try {
		const html = await fetch("/", { cache: "no-cache" }).then((r) => r.text());
		const doc = new DOMParser().parseFromString(html, "text/html");
		const seen = new Set();
		for (const el of doc.querySelectorAll("script[src], link[href]")) {
			const raw = el.getAttribute("src") || el.getAttribute("href") || "";
			if (!raw || seen.has(raw)) continue;
			seen.add(raw);
			const abs = new URL(raw, self.registration.scope);
			if (abs.origin !== self.location.origin) continue;
			if (HASHED_RE.test(abs.pathname)) urls.add(abs.pathname + abs.search);
		}
	} catch (e) {
		// Нет сети / нет index — precache ограничится ядром.
	}
	await Promise.all([...urls].map((u) => cacheAdd(cache, u)));
}

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			await precacheShell();
			await self.skipWaiting();
		})(),
	);
});

// Убираем чужие кэши и внутри pocket-shell — записи, не входящие в текущий
// shell (у hashed-ассетов после билда сменились имена).
async function pruneShell() {
	const names = await caches.keys();
	await Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)));
	const cache = await caches.open(SHELL_CACHE);
	const keys = await cache.keys();
	await Promise.all(
		keys
			.filter((req) => {
				const p = new URL(req.url).pathname;
				if (CORE_URLS.includes(p)) return false;
				return !HASHED_RE.test(p);
			})
			.map((req) => cache.delete(req)),
	);
}

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			await pruneShell();
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;
	// API и websocket не перехватываем: оффлайн-состояния рисует UI.
	if (url.pathname.startsWith("/api/") || url.pathname === "/api" || url.pathname.startsWith("/ws")) return;
	// Всё остальное незнакомое — пропускаем, чтобы случайно не закэшировать.
	const isHashed = HASHED_RE.test(url.pathname);
	const isNavigation = req.mode === "navigate";
	const isIndex = url.pathname === "/" || url.pathname === "/index.html";
	if (!isHashed && !isNavigation && !isIndex) return;

	if (isHashed) {
		// Content-addressed: cache-first.
		event.respondWith(
			(async () => {
				const cache = await caches.open(SHELL_CACHE);
				const hit = await cache.match(req);
				if (hit) return hit;
				const res = await fetch(req);
				if (res.ok) cache.put(req, res.clone());
				return res;
			})(),
		);
		return;
	}

	// Навигация / index: network-first, при ошибке сети — shell из кэша.
	event.respondWith(
		(async () => {
			try {
				const res = await fetch(req);
				if (res.ok && isIndex) {
					const cache = await caches.open(SHELL_CACHE);
					await cache.put("/", res.clone());
				}
				return res;
			} catch (e) {
				const cache = await caches.open(SHELL_CACHE);
				return (
					(await cache.match("/")) ||
					(await cache.match(req)) ||
					new Response("Offline", { status: 503, statusText: "Offline" })
				);
			}
		})(),
	);
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
