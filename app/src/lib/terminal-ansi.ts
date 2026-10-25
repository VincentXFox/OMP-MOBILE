export interface TerminalAnsiStyle {
	color?: string;
	backgroundColor?: string;
	fontWeight?: number;
	opacity?: number;
	fontStyle?: "italic";
	textDecorationLine?: string;
}

export interface TerminalAnsiSpan {
	text: string;
	style: TerminalAnsiStyle;
}

interface SgrState {
	color?: string;
	backgroundColor?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	inverse?: boolean;
}

// ANSI's 16 named colors use the xterm defaults; 16–255 follow its color cube.
const PALETTE = [
	[0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
	[0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
	[127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0],
	[92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const CUBE = [0, 95, 135, 175, 215, 255];
const rgb = (r: number, g: number, b: number): string => `rgb(${r}, ${g}, ${b})`;
const byte = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 255;

function indexedColor(index: number): string | undefined {
	if (!byte(index)) return undefined;
	if (index < 16) return rgb(PALETTE[index][0], PALETTE[index][1], PALETTE[index][2]);
	if (index >= 232) {
		const gray = 8 + (index - 232) * 10;
		return rgb(gray, gray, gray);
	}
	const cube = index - 16;
	return rgb(CUBE[Math.floor(cube / 36)], CUBE[Math.floor(cube / 6) % 6], CUBE[cube % 6]);
}

function cssStyle(state: SgrState): TerminalAnsiStyle {
	const style: TerminalAnsiStyle = {};
	if (state.inverse) {
		style.color = state.backgroundColor ?? "var(--terminal-bg)";
		style.backgroundColor = state.color ?? "var(--terminal-fg)";
	} else {
		if (state.color) style.color = state.color;
		if (state.backgroundColor) style.backgroundColor = state.backgroundColor;
	}
	if (state.bold) style.fontWeight = 700;
	if (state.dim) style.opacity = 0.65;
	if (state.italic) style.fontStyle = "italic";
	const decorations = [state.underline && "underline", state.strike && "line-through"].filter(Boolean);
	if (decorations.length) style.textDecorationLine = decorations.join(" ");
	return style;
}

function applySgr(params: string, state: SgrState): SgrState {
	// No arbitrary CSS strings: only finite numeric SGR parameters are accepted.
	if (params.length > 256 || !/^[\d;]*$/.test(params)) return state;
	const codes = params.split(";").map(value => value === "" ? 0 : Number(value));
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === 0) state = {};
		else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = true;
		else if (code === 7) state.inverse = true;
		else if (code === 9) state.strike = true;
		else if (code === 22) { state.bold = false; state.dim = false; }
		else if (code === 23) state.italic = false;
		else if (code === 24) state.underline = false;
		else if (code === 27) state.inverse = false;
		else if (code === 29) state.strike = false;
		else if (code === 39) delete state.color;
		else if (code === 49) delete state.backgroundColor;
		else if (code >= 30 && code <= 37) state.color = indexedColor(code - 30);
		else if (code >= 90 && code <= 97) state.color = indexedColor(code - 90 + 8);
		else if (code >= 40 && code <= 47) state.backgroundColor = indexedColor(code - 40);
		else if (code >= 100 && code <= 107) state.backgroundColor = indexedColor(code - 100 + 8);
		else if (code === 38 || code === 48) {
			const field = code === 38 ? "color" : "backgroundColor";
			let color: string | undefined;
			if (codes[i + 1] === 5) {
				color = indexedColor(codes[i + 2]);
				i += 2;
			} else if (codes[i + 1] === 2) {
				const [r, g, b] = codes.slice(i + 2, i + 5);
				if (byte(r) && byte(g) && byte(b)) color = rgb(r, g, b);
				i += 4;
			}
			if (color) state[field] = color;
		}
	}
	return state;
}

function skipStringControl(text: string, start: number, osc: boolean): number {
	for (let i = start; i < text.length; i++) {
		if ((osc && text.charCodeAt(i) === 7) || text.charCodeAt(i) === 0x9c) return i + 1;
		if (text[i] === "\x1b" && text[i + 1] === "\\") return i + 2;
	}
	return text.length;
}

/** Snapshot decoder, not a VT interpreter: only SGR affects the rendered data.
 * OSC, cursor/device commands and other controls never become links or HTML.
 * Parse before selecting the tail so styles from omitted rows remain intact. */
export function parseTerminalAnsi(text: string): { lines: TerminalAnsiSpan[][]; cut: number } {
	const lines: TerminalAnsiSpan[][] = [[]];
	let state: SgrState = {};
	let style: TerminalAnsiStyle = {};
	let start = 0;
	let i = 0;
	const append = (end: number): void => {
		if (end <= start) return;
		const line = lines[lines.length - 1];
		const chunk = text.slice(start, end);
		const previous = line[line.length - 1];
		if (previous?.style === style) previous.text += chunk;
		else line.push({ text: chunk, style });
	};
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (code === 10) {
			append(i);
			lines.push([]);
			start = ++i;
		} else if (code === 0x1b || code === 0x9b) {
			append(i);
			const esc = code === 0x1b ? text[i + 1] : "[";
			if (esc === "[") {
				const paramsStart = i + (code === 0x1b ? 2 : 1);
				i = paramsStart;
				while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i++;
				if (text[i] === "m") {
					state = applySgr(text.slice(paramsStart, i), state);
					style = cssStyle(state);
				}
				i = Math.min(i + 1, text.length);
			} else if (esc === "]" || esc === "P" || esc === "X" || esc === "^" || esc === "_") {
				i = skipStringControl(text, i + 2, esc === "]");
			} else {
				// Consume an ESC sequence's intermediates and final byte.
				i++;
				while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
				i = Math.min(i + 1, text.length);
			}
			start = i;
		} else if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			append(i);
			i = skipStringControl(text, i + 1, code === 0x9d);
			start = i;
		} else if ((code < 32 && code !== 9) || (code >= 0x7f && code <= 0x9f)) {
			append(i);
			start = ++i;
		} else i++;
	}
	append(i);
	const cut = Math.max(0, lines.length - 700);
	return { lines: lines.slice(cut), cut };
}
