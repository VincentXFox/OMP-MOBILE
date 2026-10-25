import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseTerminalAnsi } from "../../lib/terminal-ansi";
import { TerminalAnsiLine } from "./TerminalScreen";

test("terminal renderer uses escaped React text and typed style spans", () => {
	const spans = parseTerminalAnsi('\x1b[3;32m<script>alert("x")</script>').lines[0];
	const html = renderToStaticMarkup(<TerminalAnsiLine spans={spans} />);
	expect(html).toContain("&lt;script&gt;");
	expect(html).not.toContain("<script>");
	expect(html).toContain("font-style:italic");
	expect(html).toContain("color:rgb(0, 205, 0)");
});
