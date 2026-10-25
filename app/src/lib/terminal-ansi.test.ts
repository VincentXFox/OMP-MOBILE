import { describe, expect, test } from "bun:test";
import { parseTerminalAnsi } from "./terminal-ansi";

const textOf = (lines: ReturnType<typeof parseTerminalAnsi>["lines"]): string =>
	lines.map(line => line.map(span => span.text).join("")).join("\n");

describe("terminal ANSI snapshot", () => {
	test("SGR colors and reset do not leak into subsequent text", () => {
		const { lines } = parseTerminalAnsi("\x1b[31;1mred\x1b[0m plain");
		expect(lines[0]).toEqual([
			{ text: "red", style: { color: "rgb(205, 0, 0)", fontWeight: 700 } },
			{ text: " plain", style: {} },
		]);
	});

	test("attributes cross line boundaries and individual resets retain the rest", () => {
		const { lines } = parseTerminalAnsi("\x1b[1;2;3;4;9;36mone\ntwo\x1b[22;23;24;29mthree\x1b[39mfour");
		expect(lines[0][0].style).toEqual({
			color: "rgb(0, 205, 205)", fontWeight: 700, opacity: 0.65,
			fontStyle: "italic", textDecorationLine: "underline line-through",
		});
		expect(lines[1][0].style).toEqual(lines[0][0].style);
		expect(lines[1][1]).toEqual({ text: "three", style: { color: "rgb(0, 205, 205)" } });
		expect(lines[1][2]).toEqual({ text: "four", style: {} });
	});

	test("bright, indexed and truecolor foreground/background are decoded", () => {
		const { lines } = parseTerminalAnsi("\x1b[92;104ma\x1b[38;5;196;48;5;244mb\x1b[38;2;12;34;56;48;2;90;80;70mc\x1b[49md");
		expect(lines[0].map(span => span.style)).toEqual([
			{ color: "rgb(0, 255, 0)", backgroundColor: "rgb(92, 92, 255)" },
			{ color: "rgb(255, 0, 0)", backgroundColor: "rgb(128, 128, 128)" },
			{ color: "rgb(12, 34, 56)", backgroundColor: "rgb(90, 80, 70)" },
			{ color: "rgb(12, 34, 56)" },
		]);
	});

	test("inverse selection swaps default terminal colors and SGR 27 restores them", () => {
		const { lines } = parseTerminalAnsi("\x1b[7mselected\x1b[27m normal");
		expect(lines[0]).toEqual([
			{ text: "selected", style: { color: "var(--terminal-bg)", backgroundColor: "var(--terminal-fg)" } },
			{ text: " normal", style: {} },
		]);
	});

	test("inverse preserves logical foreground/background when colors change", () => {
		const { lines } = parseTerminalAnsi("\x1b[31;44mA\x1b[7mB\x1b[32mC\x1b[27mD");
		expect(lines[0].map(span => span.style)).toEqual([
			{ color: "rgb(205, 0, 0)", backgroundColor: "rgb(0, 0, 238)" },
			{ color: "rgb(0, 0, 238)", backgroundColor: "rgb(205, 0, 0)" },
			{ color: "rgb(0, 0, 238)", backgroundColor: "rgb(0, 205, 0)" },
			{ color: "rgb(0, 205, 0)", backgroundColor: "rgb(0, 0, 238)" },
		]);
	});

	test("inverse crosses lines and color resets retain it until a full reset", () => {
		const { lines } = parseTerminalAnsi("\x1b[31;44;7mA\n\x1b[39mB\x1b[49mC\x1b[0mD");
		expect(lines[0][0].style).toEqual({ color: "rgb(0, 0, 238)", backgroundColor: "rgb(205, 0, 0)" });
		expect(lines[1].map(span => span.style)).toEqual([
			{ color: "rgb(0, 0, 238)", backgroundColor: "var(--terminal-fg)" },
			{ color: "var(--terminal-bg)", backgroundColor: "var(--terminal-fg)" },
			{},
		]);
	});

	test("out-of-range colors and unknown SGR do not become CSS values", () => {
		const { lines } = parseTerminalAnsi("\x1b[38;2;999;0;0mA\x1b[48;5;256mB\x1b[999999999mC");
		expect(textOf(lines)).toBe("ABC");
		expect(lines.flat().every(span => Object.keys(span.style).length === 0)).toBe(true);
	});

	test("OSC links/clipboard and cursor or device controls are discarded", () => {
		const input = "A\x1b]8;;javascript:alert(1)\x07link\x1b]8;;\x1b\\B\x1b]52;c;secret\x07C\x1b[2JD\x1bPdevice\x1b\\E\x9b?25lF\x00\x08\r";
		expect(textOf(parseTerminalAnsi(input).lines)).toBe("AlinkBCDEF");
		expect(textOf(parseTerminalAnsi("before\x1b]unterminated payload").lines)).toBe("before");
	});

	test("HTML remains literal text, including after a styled segment", () => {
		const raw = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
		expect(textOf(parseTerminalAnsi(`\x1b[32m${raw}`).lines)).toBe(raw);
	});

	test("the 700-line tail keeps attributes established in discarded lines", () => {
		const input = "\x1b[3;32m" + Array.from({ length: 703 }, (_, i) => `line ${i}`).join("\n");
		const snapshot = parseTerminalAnsi(input);
		expect(snapshot.cut).toBe(3);
		expect(snapshot.lines).toHaveLength(700);
		expect(snapshot.lines[0][0]).toEqual({ text: "line 3", style: { color: "rgb(0, 205, 0)", fontStyle: "italic" } });
		expect(snapshot.lines[699][0].text).toBe("line 702");
	});

	test("indentation, trailing spaces, tabs and empty final rows keep table alignment", () => {
		const raw = "  │ A\t B │  \n  └──────┘  \n";
		expect(textOf(parseTerminalAnsi(`\x1b[36m${raw}`).lines)).toBe(raw);
	});
});
