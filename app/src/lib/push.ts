import { deletePushSubscription, getVapidPublicKey, savePushSubscription } from "./gateway";

export type PushState = "unsupported" | "denied" | "subscribed" | "unsubscribed";

/** base64url VAPID key → ArrayBuffer (BufferSource for pushManager.subscribe). */
function urlBase64ToArrayBuffer(base64: string): ArrayBuffer {
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(b64);
	const out = new ArrayBuffer(raw.length);
	const bytes = new Uint8Array(out);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (!("serviceWorker" in navigator)) return null;
	try {
		return (await navigator.serviceWorker.getRegistration()) ?? null;
	} catch {
		return null;
	}
}

/** Current push capability/subscription state, best-effort. */
export async function pushState(): Promise<PushState> {
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
	if (typeof Notification !== "undefined" && Notification.permission === "denied") return "denied";
	const reg = await registration();
	if (!reg) return "unsubscribed";
	const sub = await reg.pushManager.getSubscription();
	return sub ? "subscribed" : "unsubscribed";
}

/** Ask permission, subscribe via the SW registration, and persist to the gateway. */
export async function subscribePush(): Promise<PushState> {
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
	const permission = await Notification.requestPermission();
	if (permission === "denied") return "denied";
	const reg = await registration();
	if (!reg) return "unsubscribed";
	const vapidKey = await getVapidPublicKey();
	const existing = await reg.pushManager.getSubscription();
	const sub =
		existing ??
		(await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToArrayBuffer(vapidKey),
		}));
	await savePushSubscription(sub.toJSON());
	return "subscribed";
}

/** Unsubscribe and remove the persisted subscription from the gateway. */
export async function unsubscribePush(): Promise<PushState> {
	const reg = await registration();
	const sub = await reg?.pushManager.getSubscription();
	if (sub) {
		try {
			await deletePushSubscription(sub.endpoint);
		} catch {
			// gateway cleanup is best-effort; still unsubscribe locally
		}
		await sub.unsubscribe();
	}
	return "unsubscribed";
}
