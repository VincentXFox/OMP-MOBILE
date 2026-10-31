import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Terminal, Wrench } from "lucide-react";
import { pluralRu } from "../../lib/format";
import { PREVIEW_LIMIT, parseSubagentRows, previewLines, type SubRow } from "../../lib/subagent-view";

function ResultRow({ row }: { row: SubRow }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const text = row.text ?? "";
	const total = text.split("\n").length;
	const { lines } = previewLines(text, expanded);
	const canToggle = total > PREVIEW_LIMIT;
	const hidden = Math.max(0, total - PREVIEW_LIMIT);
	return (
		<div className={`ss-sub-result${row.failed ? " ss-sub-result--failed" : ""}`}>
			<pre>{lines.join("\n")}</pre>
			{canToggle && (
				<button type="button" className="ss-sub-more" onClick={() => setExpanded(prev => !prev)}>
					{expanded ? "свернуть" : `ещё ${hidden} ${pluralRu(hidden, "строка", "строки", "строк")}`}
					<ChevronDown size={12} className={expanded ? "ss-sub-more-icon ss-sub-more-icon--open" : "ss-sub-more-icon"} />
				</button>
			)}
		</div>
	);
}

function Row({ row }: { row: SubRow }): ReactNode {
	switch (row.kind) {
		case "user":
			return (
				<div className="ss-sub-row ss-sub-row--user">
					<span className="ss-sub-role">человек</span>
					<p>{row.text}</p>
				</div>
			);
		case "assistant":
			return (
				<div className="ss-sub-row ss-sub-row--assistant">
					<p>{row.text}</p>
				</div>
			);
		case "tool":
			return (
				<div className="ss-sub-tool" title={row.arg}>
					<Wrench size={12} className="ss-sub-tool-icon" />
					<span className="ss-sub-tool-name">{row.name}</span>
					{row.arg ? <code className="ss-sub-tool-arg">{row.arg}</code> : null}
				</div>
			);
		case "result":
			return <ResultRow row={row} />;
		case "system":
			return <div className="ss-sub-system">{row.text}</div>;
		default:
			return (
				<div className="ss-sub-raw">
					<Terminal size={12} />
					<pre>{row.text}</pre>
				</div>
			);
	}
}

/** Читаемая лента сабагента: реплики, инструменты и свёрнутые результаты. */
export function SubagentConversation({ raw, empty }: { raw: string | null; empty?: ReactNode }): ReactNode {
	const [rawMode, setRawMode] = useState(false);
	const rows = useMemo(() => (raw ? parseSubagentRows(raw) : []), [raw]);
	if (!raw) return <>{empty ?? null}</>;
	const nothingParsed = rows.length === 0;
	return (
		<div className="ss-sub">
			<div className="ss-sub-head">
				<span className="ss-sub-count">{nothingParsed ? "записей нет" : `${rows.length} ${pluralRu(rows.length, "запись", "записи", "записей")}`}</span>
				<button type="button" className={`ss-sub-raw-toggle${rawMode ? " ss-sub-raw-toggle--on" : ""}`} onClick={() => setRawMode(prev => !prev)}>
					{rawMode ? "Оформленный вид" : "Сырой текст"}
				</button>
			</div>
			{rawMode || nothingParsed ? (
				<>
					{nothingParsed && !rawMode && <div className="ss-sub-empty">Разобрать нечего — включи «Сырой текст».</div>}
					<pre className="ss-sub-rawtext">{raw}</pre>
				</>
			) : (
				rows.map((row, index) => <Row key={index} row={row} />)
			)}
		</div>
	);
}
