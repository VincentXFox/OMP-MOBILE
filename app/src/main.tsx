import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);

/** Печатает ли человек прямо сейчас: авто-reload не должен рвать набор. */
function isTyping(): boolean {
	const el = document.activeElement;
	if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return false;
	return el.value.length > 0;
}

// PWA: register the service worker in secure contexts only.
if ("serviceWorker" in navigator && window.isSecureContext) {
	// Была ли страница под управлением воркера до этой загрузки: на первой
	// установке reload не нужен — он просто выбросил бы из приложения.
	const hadController = navigator.serviceWorker.controller !== null;
	let reloading = false;
	const reloadNow = (): void => {
		if (reloading) return;
		reloading = true;
		window.location.reload();
	};
	// Новый воркер активировался (skipWaiting + clients.claim): открытая
	// страница всё ещё крутит старый бандл — без перезагрузки фиксы не видны.
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hadController) return;
		if (isTyping()) {
			// Не рвать набор: ждём, когда человек отпустит поле с текстом или
			// свернёт приложение, и обновляемся сами (опрос, не одно событие —
			// focusout можно не дождаться, если поле так и осталось в фокусе).
			window.setInterval(() => {
				if (!isTyping() || document.visibilityState === "hidden") reloadNow();
			}, 2000);
			return;
		}
		reloadNow();
	});

	window.addEventListener("load", () => {
		void navigator.serviceWorker
			.register("/sw.js")
			.then(registration => {
				// Установленная PWA может не «навигировать» сутками, а браузер
				// без навигации sw.js не перезапрашивает: проверяем сами.
				const check = (): void => {
					if (document.visibilityState !== "visible") return;
					void registration.update().catch(() => {});
				};
				check();
				window.setInterval(check, 60_000);
				document.addEventListener("visibilitychange", check);
			})
			.catch(() => {
				// SW не критичен для работы приложения.
			});
	});
}

