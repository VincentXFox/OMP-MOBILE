/**
 * Единый разбор итогового статуса для всех гейтов OMP.
 *
 * Зачем: основной стоп-гейт и состязательная проверка раньше разбирали статус
 * каждый по-своему (нашёл аудит). Две реализации = два разных ответа на один
 * финальный текст. Теперь правило одно на всех.
 *
 * Что учитывается:
 *   - примеры статусов внутри кода и цитат не считаются итоговым статусом;
 *   - противоречивые статусы (два разных в одном ответе) помечаются;
 *   - разбор устойчив к markdown-выделению вокруг слова.
 */

export type Status = "DONE" | "CAVEATS" | "PARTIAL" | "BLOCKED";

const STATUS_RE =
	/(?:СТАТУС|STATUS)\s*:\s*\**\s*(ГОТОВО-С-ОГРАНИЧЕНИЯМИ|DONE-WITH-CAVEATS|ГОТОВО|DONE|PARTIAL|BLOCKED)/giu;

/** Убирает блоки кода и инлайн-цитаты: статус-пример там — не итоговый статус. */
export function stripQuoted(text: string): string {
	return text
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/`[^`\n]*`/gu, " ")
		.replace(/^\s*>.*$/gmu, " ")
		.replace(/<!--[\s\S]*?-->/gu, " ");
}

/** Все статусы в тексте после вырезания кода и цитат. */
export function allStatuses(text: string): Status[] {
	const clean = stripQuoted(text);
	const out: Status[] = [];
	for (const match of clean.matchAll(STATUS_RE)) {
		const raw = (match[1] ?? "").toUpperCase();
		const value: Status | null =
			raw === "ГОТОВО" || raw === "DONE"
				? "DONE"
				: raw === "ГОТОВО-С-ОГРАНИЧЕНИЯМИ" || raw === "DONE-WITH-CAVEATS"
					? "CAVEATS"
					: raw === "PARTIAL"
						? "PARTIAL"
						: raw === "BLOCKED"
							? "BLOCKED"
							: null;
		if (value !== null) out.push(value);
	}
	return out;
}

/** Итоговый статус: последний по тексту; null — статуса нет. */
export function parseStatus(text: string): Status | null {
	const all = allStatuses(text);
	return all.length === 0 ? null : (all[all.length - 1] ?? null);
}

/** Противоречие: в ответе больше одного РАЗНОГО статуса. */
export function statusConflict(text: string): Status[] | null {
	const all = allStatuses(text);
	const unique = [...new Set(all)];
	return unique.length > 1 ? unique : null;
}
