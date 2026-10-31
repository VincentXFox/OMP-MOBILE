/**
 * Shared UI primitives for tool renderers. Every renderer composes these
 * instead of inventing new CSS — see tool-render.css for the `tv-` classes.
 */
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ToolRenderHost, ToolResultImage, ToolResultLike } from "./types";
import { getHljs, replaceTabs, resultImagesOf, resultTextOf, shortenPath, stripAnsi } from "./util";

export type Tone = "accent" | "ok" | "err" | "warn";

/** Russian plural: `plural(2, "строка", "строки", "строк")`. */
export function plural(n: number, one: string, few: string, many: string): string {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return one;
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
	return many;
}

/** Number of lines shown per «Показать ещё» portion once expanded. */
const EXPAND_PORTION = 400;

/**
 * 44px tap-target copy button. Shows a check mark for 1.2s after copying.
 * Falls back to a hidden textarea when the async clipboard API is unavailable
 * (non-secure contexts, older webviews).
 */
export function CopyButton({ text, label = "Копировать" }: { text: string; label?: string }): ReactNode {
	const [done, setDone] = useState(false);
	const timerRef = useRef<number | undefined>(undefined);
	const copy = (): void => {
		const finish = (): void => {
			setDone(true);
			clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => setDone(false), 1200);
		};
		if (navigator.clipboard?.writeText !== undefined) {
			navigator.clipboard.writeText(text).then(finish, () => {});
			return;
		}
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.append(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
		finish();
	};
	return (
		<button type="button" className="tv-copy" aria-label={label} title={label} onClick={copy}>
			{done ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
		</button>
	);
}

/** Inline chip. Renders nothing for empty content. */
export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return <span className={`tv-badge${tone ? ` tv-badge--${tone}` : ""}`}>{children}</span>;
}

/** Chip row; falsy items are skipped. Usable inline (summaries) and in bodies. */
export function Badges({ items }: { items: ReadonlyArray<ReactNode> }): ReactNode {
	const visible = items.filter(item => item != null && item !== "" && item !== false);
	if (visible.length === 0) return null;
	return (
		<span className="tv-badges">
			{visible.map((item, i) => (
				<Badge key={i}>{item}</Badge>
			))}
		</span>
	);
}

/** File path with optional `:start-end` line range or raw selector suffix. */
export function PathText({
	path,
	from,
	to,
	sel,
}: {
	path: string;
	from?: number | null;
	to?: number | null;
	sel?: string | null;
}): ReactNode {
	let range = "";
	if (from != null || to != null) {
		const start = from ?? 1;
		range = to != null ? `:${start}-${to}` : `:${start}`;
	}
	return (
		<span className="tv-path">
			{shortenPath(path)}
			{range && <span className="tv-lines">{range}</span>}
			{sel && <span className="tv-lines">:{sel}</span>}
		</span>
	);
}

/** Key/value grid. */
export function KvGrid({ children }: { children: ReactNode }): ReactNode {
	return <div className="tv-kv">{children}</div>;
}

export function Kv({ k, children }: { k: ReactNode; children: ReactNode }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return (
		<>
			<span className="tv-kv-key">{k}</span>
			<span className="tv-kv-val">{children}</span>
		</>
	);
}

function useHighlight(code: string, lang: string | null | undefined): string | null {
	return useMemo(() => {
		if (!lang) return null;
		const hljs = getHljs();
		if (!hljs) return null;
		try {
			if (!hljs.getLanguage(lang)) return null;
			return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		} catch {
			return null;
		}
	}, [code, lang]);
}

export interface OutputProps {
	text: string;
	/** Lines shown before collapsing behind a "more" affordance. */
	maxLines?: number;
	/** highlight.js language (only applied when the host exposes hljs). */
	lang?: string | null;
	/** Render in error color. */
	error?: boolean;
	/** "code": horizontal scroll, inset bg. "plain": soft-wrapped. */
	variant?: "code" | "plain";
	/** Uppercase mini-title above the block. */
	title?: string;
	/** Drop the inset background (inline in flow). */
	bare?: boolean;
}

/**
 * Expandable text block — the workhorse for command output, file previews,
 * search results. Tabs are widened, ANSI escapes stripped.
 */
/** Ошибка инструмента: максимум 4 визуальные строки, длинный текст раскрывается по тапу. */
function ErrorOutput({ text }: { text: string }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const ref = useRef<HTMLPreElement | null>(null);
	const clean = useMemo(() => replaceTabs(stripAnsi(text)).replace(/\n+$/, ""), [text]);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		setOverflows(el.scrollHeight > el.clientHeight + 2);
	}, [clean, expanded]);
	return (
		<div className="tv-out">
			<pre
				ref={ref}
				className={`tv-pre tv-pre--wrap tv-pre--error${expanded ? " tv-pre--error-open" : ""}`}
			>
				{clean}
			</pre>
			{overflows && !expanded && (
				<div className="tv-out-foot">
					<button type="button" className="tv-expand" onClick={() => setExpanded(true)}>
						показать полностью
					</button>
				</div>
			)}
		</div>
	);
}

export function Output({ text, maxLines = 10, lang, error, variant = "plain", title, bare }: OutputProps): ReactNode {
	const [limit, setLimit] = useState<number | null>(null);
	const clean = useMemo(() => replaceTabs(stripAnsi(text)).replace(/\n+$/, ""), [text]);
	const lines = useMemo(() => clean.split("\n"), [clean]);
	const collapsible = lines.length > maxLines + 1;
	// Collapsed: `maxLines`. Expanded: `limit` lines, grown in portions so a
	// 10k-line output never renders (or re-renders) in one shot.
	const shown =
		!collapsible || limit === null ? lines.slice(0, maxLines).join("\n") : lines.slice(0, limit).join("\n");
	const hidden = collapsible ? lines.length - (limit ?? maxLines) : 0;
	const html = useHighlight(shown, error ? null : lang);
	const classes = ["tv-pre"];
	if (variant === "plain") classes.push("tv-pre--wrap");
	if (error) classes.push("tv-pre--error");
	if (bare) classes.push("tv-pre--bare");
	return (
		<div className="tv-out">
			{title && <div className="tv-out-title">{title}</div>}
			{html !== null ? (
				<pre className={classes.join(" ")} dangerouslySetInnerHTML={{ __html: html }} />
			) : (
				<pre className={classes.join(" ")}>{shown}</pre>
			)}
			{(collapsible || limit !== null) && (
				<div className="tv-out-foot">
					{limit !== null && <CopyButton text={clean} />}
					{hidden > 0 && (
						<button
							type="button"
							className="tv-expand"
							onClick={() => setLimit(v => (v === null ? EXPAND_PORTION : v + EXPAND_PORTION))}
						>
							{limit === null
								? `ещё ${lines.length - maxLines} ${plural(lines.length - maxLines, "строка", "строки", "строк")}`
								: "Показать ещё"}
						</button>
					)}
					{limit !== null && hidden > 0 && (
						<button type="button" className="tv-expand" onClick={() => setLimit(null)}>
							Свернуть
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/** Source-code block: inset background, no soft wrap, optional title chip. */
export function CodeBlock({
	code,
	lang,
	title,
	maxLines = 14,
}: {
	code: string;
	lang?: string | null;
	title?: string;
	maxLines?: number;
}): ReactNode {
	if (!code) return null;
	return <Output text={code} lang={lang} maxLines={maxLines} variant="code" title={title} />;
}

/**
 * Result text of a tool result, styled for success or error automatically.
 * Renders nothing when the result is absent or has no text.
 */
export function ResultText({
	result,
	maxLines = 10,
	lang,
	variant,
	title,
}: {
	result: ToolResultLike | undefined;
	maxLines?: number;
	lang?: string | null;
	variant?: "code" | "plain";
	title?: string;
}): ReactNode {
	const text = resultTextOf(result).trim();
	if (!text) return null;
	if (result?.isError === true) return <ErrorOutput text={text} />;
	return (
		<Output
			text={text}
			maxLines={maxLines}
			lang={lang}
			// ошибки уходят в ErrorOutput выше, сюда попадает только успешный вывод
			error={false}
			variant={variant ?? (lang ? "code" : "plain")}
			title={title}
		/>
	);
}

function openImage(img: ToolResultImage): void {
	try {
		const bin = atob(img.data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType }));
		window.open(url, "_blank", "noopener");
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch {
		// undecodable image data — the broken thumbnail already conveys it
	}
}

/** Thumbnails for every image block in a result; click opens full size. */
export function ResultImages({ result }: { result: ToolResultLike | undefined }): ReactNode {
	const images = resultImagesOf(result);
	if (images.length === 0) return null;
	return (
		<div className="tv-imgs">
			{images.map((img, i) => (
				<button
					key={i}
					type="button"
					style={{ all: "unset", display: "inline-flex" }}
					onClick={() => openImage(img)}
					aria-label={`Open tool result image ${i + 1}`}
				>
					<img className="tv-img" src={`data:${img.mimeType};base64,${img.data}`} alt={`tool result ${i + 1}`} />
				</button>
			))}
		</div>
	);
}

/** Callout block. */
export function Note({ tone, children }: { tone?: "err" | "warn" | "ok"; children: ReactNode }): ReactNode {
	if (children == null || children === "" || children === false) return null;
	return <div className={`tv-note${tone ? ` tv-note--${tone}` : ""}`}>{children}</div>;
}

/** Labeled row inside a `.tv-list`. */
export function Row({ k, children }: { k?: ReactNode; children: ReactNode }): ReactNode {
	return (
		<div className="tv-row">
			{k != null && k !== "" && <span className="tv-row-key">{k}</span>}
			<span className="tv-row-val">{children}</span>
		</div>
	);
}

/** Marker for arguments that arrived with the wrong JSON type. */
export function InvalidArg({ what }: { what?: string }): ReactNode {
	return <span className="tv-err-text">[invalid {what ?? "arg"}]</span>;
}

/**
 * Unified-diff-ish block: `+` rows added, `-` rows removed, `@@` hunk headers
 * faint, blank rows render as `…` gaps (non-contiguous regions).
 */
export function DiffBlock({ diff, maxLines = 80 }: { diff: string; maxLines?: number }): ReactNode {
	const [limit, setLimit] = useState<number | null>(null);
	const lines = useMemo(() => replaceTabs(stripAnsi(diff)).replace(/\n+$/, "").split("\n"), [diff]);
	const collapsible = lines.length > maxLines + 1;
	const shown = !collapsible || limit === null ? lines.slice(0, maxLines) : lines.slice(0, limit);
	const hidden = collapsible ? lines.length - (limit ?? maxLines) : 0;
	return (
		<div className="tv-out">
			<div className="tv-diff">
				{shown.map((line, i) => {
					let cls = "";
					if (line.trim().length === 0) cls = "--gap";
					else if (line.startsWith("+")) cls = "--add";
					else if (line.startsWith("-")) cls = "--del";
					else if (line.startsWith("@@")) cls = "--hunk";
					return (
						<div key={i} className={`tv-diff-row${cls ? ` tv-diff-row${cls}` : ""}`}>
							{line.trim().length === 0 ? "…" : line}
						</div>
					);
				})}
			</div>
			{(collapsible || limit !== null) && (
				<div className="tv-out-foot">
					{limit !== null && <CopyButton text={lines.join("\n")} />}
					{hidden > 0 && (
						<button
							type="button"
							className="tv-expand"
							onClick={() => setLimit(v => (v === null ? EXPAND_PORTION : v + EXPAND_PORTION))}
						>
							{limit === null
								? `ещё ${lines.length - maxLines} ${plural(lines.length - maxLines, "строка", "строки", "строк")}`
								: "Показать ещё"}
						</button>
					)}
					{limit !== null && (
						<button type="button" className="tv-expand" onClick={() => setLimit(null)}>
							Свернуть
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Agent id chip. Becomes a drill-down button when the host can open that
 * agent's sub-session; otherwise renders as a plain accent badge.
 */
export function AgentLink({
	id,
	host,
	children,
}: {
	id: string;
	host?: ToolRenderHost;
	children?: ReactNode;
}): ReactNode {
	const clickable = host?.openAgent !== undefined && (host.hasAgent === undefined || host.hasAgent(id));
	if (!clickable) return <Badge tone="accent">{children ?? id}</Badge>;
	return (
		<button type="button" className="tv-badge tv-badge--accent tv-agent-link" onClick={() => host.openAgent?.(id)}>
			{children ?? id}
			<span className="tv-agent-link-arrow" aria-hidden="true">
				{" ↗"}
			</span>
		</button>
	);
}
