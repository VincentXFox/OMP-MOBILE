import type { HostInfo } from "./gateway";

/**
 * Имя агента для людей — одно правило на весь интерфейс. Источники по старшинству:
 * пользовательское переименование → заголовок сессии из файла → первый запрос
 * пользователя → имя из collab-реестра → короткий sessionId.
 *
 * Заголовок из файла свежее реестра (переименование из TUI) и есть у сессий,
 * запущенных без панели шлюза: реестр им имени не даёт вовсе, и в списках
 * агентов они выглядели слагом или путём «/home/user».
 */

/** Служебные имена (resume--x, restore-x, черновики Pocket) → человеческий текст. */
export function humanizeServiceName(name: string): string {
	if (/^resume--/.test(name)) {
		const tail = name.slice("resume--".length).trim();
		return tail ? `Восстановленная сессия · ${tail}` : "Восстановленная сессия";
	}
	if (/^restore-/.test(name)) {
		const tail = name.slice("restore-".length).trim();
		return tail ? `Восстановленная сессия · ${tail}` : "Восстановленная сессия";
	}
	if (name.includes("omp-pocket-scratch")) return "Черновик Pocket";
	return name;
}

export function agentName(host: HostInfo): string {
	if (host.displayName) return host.displayName;
	if (host.sessionTitle) return host.sessionTitle;
	if (host.sessionPreview) return host.sessionPreview;
	if (host.sessionName) return humanizeServiceName(host.sessionName);
	// Имени нет нигде: честная короткая примета вместо пути «/home/user».
	return `Сессия ${host.sessionId.slice(0, 8)}`;
}
