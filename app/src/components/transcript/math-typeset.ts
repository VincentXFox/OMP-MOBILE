/**
 * Набор формул по требованию: KaTeX подгружается, только если в сообщении
 * действительно есть `$…$`/`$$…$$`. Разметка (data-tex) приходит из math.ts,
 * поэтому основной чанк чата не тянет 300+ КБ движка формул.
 */

type KatexModule = typeof import("katex");

let loading: Promise<KatexModule | null> | null = null;

function loadKatex(): Promise<KatexModule | null> {
	loading ??= import("katex").then(
		module => module,
		() => null,
	);
	return loading;
}

/**
 * Заменяет заглушки `.tr-math-pending` набранными формулами.
 * Ошибка набора или недоступный чанк оставляют исходник — читаемо в любом случае.
 */
export async function typesetPending(root: HTMLElement | null): Promise<void> {
	if (root === null) return;
	const pending = root.querySelectorAll<HTMLElement>(".tr-math-pending");
	if (pending.length === 0) return;
	const katex = await loadKatex();
	if (katex === null) return;
	for (const node of pending) {
		const tex = node.dataset.tex ?? "";
		if (tex === "") continue;
		try {
			const html = katex.renderToString(tex, {
				displayMode: node.dataset.display === "1",
				output: "mathml",
				throwOnError: false,
				strict: false,
				trust: false,
			});
			node.innerHTML = html;
			node.classList.remove("tr-math-pending");
		} catch {
			node.classList.remove("tr-math-pending");
		}
	}
}

// Наблюдаемость и живая проверка: набор формул можно вызвать из консоли
// (`window.__pocketTypeset(node)`) и убедиться, что KaTeX реально набирает.
if (typeof window !== "undefined") {
	(window as typeof window & { __pocketTypeset?: typeof typesetPending }).__pocketTypeset = typesetPending;
}
