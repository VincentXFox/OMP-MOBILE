import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import {
	type MathSpan,
	mathBlockInContext,
	mathSpanInContext,
	mathStartIndex,
} from "@oh-my-pi/pi-utils/math-delimiters";
import { escapeHtml } from "../../lib/format";

/**
 * A backtick between the delimiters means the run is prose that merely looks
 * like math (`$x `code` y$`): KaTeX cannot express a code span, so typesetting
 * would swallow it and print an error instead.
 */
function typesettable(span: MathSpan): boolean {
	return !span.body.includes("`");
}

/**
 * Разметка формулы без KaTeX: исходник в `data-tex`, а сам KaTeX грузится
 * отдельным чанком и набирает формулу, когда она реально встретилась
 * (`math-typeset.ts`). Иначе его 300+ КБ ехали при каждом открытии чата,
 * хотя формулы есть далеко не в каждой сессии.
 */
function renderMath(token: Tokens.Generic): string | false {
	if (token.type !== "math" || typeof token.text !== "string" || typeof token.display !== "boolean") return false;
	const source = escapeHtml(token.text);
	const attrs = `data-tex="${source}" data-display="${token.display ? "1" : "0"}"`;
	// Класс `.tr-math` даёт горизонтальную прокрутку длинной формуле: у самого
	// math-элемента чернила (дроби, радикалы) выходят за его рамку.
	return token.display
		? `<span class="tr-math tr-math-pending" ${attrs}>${source}</span>`
		: `<span class="tr-math-pending" ${attrs}>${source}</span>`;
}

/**
 * Renders LaTeX in transcript Markdown: `$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Delimiters and the
 * scan hint come from `@oh-my-pi/pi-utils/math-delimiters`, so this renderer and
 * the TUI agree on what counts as math; only presentation policy lives here.
 *
 * Two limits follow from that shared behavior, both matching the TUI: a rejected
 * opener hides later spans on its line ("it costs $5, and the growth is $x^2$"
 * typesets nothing, since marked drops a start hint at its own position), and a
 * display block whose body contains a blank line must be preceded by one —
 * attached blocks are tokenized by the inline rule, which a blank line ends.
 */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			// No `start` hint: this parser probes block extensions only at a block
			// boundary and never consults their hints.
			tokenizer(source) {
				const block = mathBlockInContext(this, source);
				if (!block) return undefined;
				return { type: "math", raw: block.raw, text: block.body, display: true };
			},
			renderer: renderMath,
		},
		{
			name: "math",
			level: "inline",
			startFrom: mathStartIndex,
			tokenizer(source) {
				const span = mathSpanInContext(this, source);
				if (!span || !typesettable(span)) return undefined;
				return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
			},
			renderer: renderMath,
		},
	],
};
