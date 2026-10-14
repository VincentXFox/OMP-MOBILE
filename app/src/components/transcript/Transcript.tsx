import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ChevronRight, Layers } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImageViewer } from "./ImageViewer";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

function Row({
	kind,
	gutter,
	title,
	append,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	append?: boolean;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}${append ? " tr-row--append" : ""}`}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={12} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				размышления{redacted ? " · скрыто" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(скрыто провайдером)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return pending ? <StreamingMarkdown key={i} text={block.text} /> : <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>
						{stop === "error" ? "ошибка" : stop === "aborted" ? "прервано" : stop === "maxTokens" ? "лимит токенов" : stop}
					</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	/** `tr-row--append` opts the freshly streamed row into the rise animation. */
	append?: boolean;
	/** Первая строка подряд одного автора — только у неё виден ярлык в гуттере. */
	firstInGroup?: boolean;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.host !== next.host || prev.append !== next.append) return false;
	if (prev.firstInGroup !== next.firstInGroup) return false;
	const e = next.entry;
	const isAssistant = e.type === "message" && e.message.role === "assistant";
	if (prev.entry === e && !isAssistant) return true;
	// Entry неизменяем после добавления; перерисовка нужна только другому id
	// (копия с тем же id — перечитанный тем же контент, входы ниже решают).
	if (prev.entry.id !== e.id) return false;
	if (isAssistant && e.type === "message" && e.message.role === "assistant") {
		for (const block of e.message.content) {
			if (block.type !== "toolCall") continue;
			if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
			if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
		}
	}
	return true;
}

const EntryRow = memo(function EntryRow({ entry, results, active, host, append, firstInGroup = true }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" gutter={firstInGroup ? "host" : ""} title={entry.timestamp} append={append}>
							<MsgContent content={msg.content} />
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" gutter={firstInGroup ? "agent" : ""} title={entry.timestamp} append={append}>
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</Row>
					);
				default:
					// toolResult entries are consumed via pairing; developer & unknown roles skipped
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row kind="user" gutter="" title={entry.timestamp}>
						<div className="tr-collab-from">{from}</div>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>Контекст сжат · {fmtTokens(entry.tokensBefore)} токенов</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/* ---- Progressive disclosure: свёртка серий committed tool-карточек ---- */

const MIN_GROUP = 3;
/** Вопросы модели всегда развёрнуты — требуют внимания пользователя. */
const UNGROUPABLE_TOOLS: Record<string, true> = { ask: true };

/**
 * Классификация entry для построения серий: "tool" — группируемая committed
 * tool-карточка, "spacer" — невидимый toolResult (не рвёт серию), иначе —
 * разрыв (сообщения, текст/thinking в ассистенте, маркеры и т.д.).
 */
function toolRunClass(entry: SessionEntry, results: ReadonlyMap<string, ToolResultMessage>): "tool" | "spacer" | "break" {
	if (entry.type !== "message") return "break";
	const msg = entry.message;
	if (msg.role === "toolResult") return "spacer";
	if (msg.role !== "assistant" || msg.content.length === 0) return "break";
	for (const block of msg.content) {
		if (block.type !== "toolCall") return "break";
		if (UNGROUPABLE_TOOLS[block.name]) return "break";
		if (!results.has(block.id)) return "break"; // ещё бежит — не прячем
	}
	return "tool";
}

interface ToolGroupInfo {
	/** id entry-й серии (в исходном порядке). */
	ids: string[];
	/** toolName каждого toolCall'а серии, с повторами. */
	names: string[];
	/** toolResult'ы с isError внутри серии. */
	errors: number;
}

/** Свёрнутая группа: одна строка-карточка с агрегатом и статус-бейджем. */
function ToolGroupBlock({
	info,
	entryById,
	results,
	active,
	host,
	firstInGroup,
}: {
	info: ToolGroupInfo;
	entryById: ReadonlyMap<string, SessionEntry>;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	firstInGroup: boolean;
}): ReactNode {
	const [open, setOpen] = useState(false);
	if (!open) {
		const counts = new Map<string, number>();
		for (const name of info.names) counts.set(name, (counts.get(name) ?? 0) + 1);
		const parts = [...counts].map(([name, n]) => `${name} ×${n}`);
		let aggregate = parts.slice(0, 2).join(", ");
		if (parts.length > 2) aggregate += ` и ещё ${parts.length - 2}`;
		return (
			<Row kind="assistant" gutter="">
				<button type="button" className="tr-group" aria-expanded={false} onClick={() => setOpen(true)}>
					<Layers size={15} className="tr-group-ico" />
					<span className="tr-group-label">
						{info.names.length} операций · {aggregate}
					</span>
					{info.errors > 0 ? (
						<span className="tv-badge tv-badge--err">{info.errors} с ошибкой</span>
					) : (
						<span className="tv-badge tv-badge--ok">✓</span>
					)}
					<ChevronRight size={16} className="tr-chev" />
				</button>
			</Row>
		);
	}
	return (
		<>
			{info.ids.map((id, i) => {
				const entry = entryById.get(id);
				if (entry === undefined) return null;
				return (
					<EntryRow
						key={id}
						entry={entry}
						results={results}
						active={active}
						host={host}
						firstInGroup={i === 0 && firstInGroup}
					/>
				);
			})}
			<button type="button" className="tr-group-collapse" onClick={() => setOpen(false)}>
				Свернуть
			</button>
		</>
	);
}

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;
/**
 * «Показать ещё» (кнопка и автотриггер скроллом вверх) монтирует предыдущие
 * записи порциями, а не всем окном разом — большой единовременный монтиング
 * даёт длинный кадр и джанк на телефоне.
 */
const EARLIER_STEP = 40;

interface CommittedListProps {
	visible: readonly SessionEntry[];
	toolGroups: { starts: Map<string, ToolGroupInfo>; covered: Set<string> };
	entryById: ReadonlyMap<string, SessionEntry>;
	results: ReadonlyMap<string, ToolResultMessage>;
	activeTools: ReadonlyMap<string, ActiveTool>;
	groupStarts: ReadonlySet<string>;
	/** Наконец добавленные в хвост записи — только для анимации появления. */
	animIds: ReadonlySet<string>;
	host?: ToolRenderHost;
}

/**
 * Голова ленты: все смонтированные committed-записи (включая свёрнутые группы).
 * Мемоизирована отдельно от стрим-хвоста, чтобы обновления snap.stream
 * (токены, частичные результаты) не перерисовывали тысячи строк выше хвоста.
 * `activeTools` сравнивается не по ссылке, а по содержимому для toolCall'ов
 * committed-записей: карта пересоздаётся на каждый коммит, но состояние
 * активного инструмента в committed-строке меняется редко.
 */
function committedListEqual(prev: CommittedListProps, next: CommittedListProps): boolean {
	if (
		prev.visible !== next.visible ||
		prev.results !== next.results ||
		prev.groupStarts !== next.groupStarts ||
		prev.entryById !== next.entryById ||
		prev.toolGroups !== next.toolGroups ||
		prev.host !== next.host
	) {
		return false;
	}
	if (prev.activeTools === next.activeTools) return true;
	for (const entry of next.visible) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			if (prev.activeTools.get(block.id) !== next.activeTools.get(block.id)) return false;
		}
	}
	return true;
}

const CommittedList = memo(function CommittedList({
	visible,
	toolGroups,
	entryById,
	results,
	activeTools,
	groupStarts,
	animIds,
	host,
}: CommittedListProps): ReactNode {
	return (
		<>
			{visible.map(entry => {
				if (toolGroups.covered.has(entry.id)) {
					// Свёрнуто — вся серия заменена одной строкой-карточкой по первой записи.
					if (!toolGroups.starts.has(entry.id)) return null;
					return (
						<ToolGroupBlock
							key={entry.id}
							info={toolGroups.starts.get(entry.id)!}
							entryById={entryById}
							results={results}
							active={activeTools}
							host={host}
							firstInGroup={groupStarts.has(entry.id)}
						/>
					);
				}
				return (
					<EntryRow
						key={entry.id}
						entry={entry}
						results={results}
						active={activeTools}
						host={host}
						append={animIds.has(entry.id)}
						firstInGroup={groupStarts.has(entry.id)}
					/>
				);
			})}
		</>
	);
}, committedListEqual);

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, phase } = props;

	// null follows the tail. A number pins the first mounted entry while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them.
	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// Ярлык автора в гуттере — только у первой строки подряд одного автора.
	const groupStarts = useMemo(() => {
		const s = new Set<string>();
		let prevKind: string | null = null;
		for (const e of visible) {
			let kind: string;
			if (e.type === "message") kind = `m:${e.message.role}`;
			else if (e.type === "custom_message") {
				const d = e.details;
				const from = d !== null && typeof d === "object" && typeof (d as Record<string, unknown>).from === "string"
					? ((d as Record<string, unknown>).from as string)
					: "";
				kind = `c:${e.customType}:${from}`;
			} else kind = e.type;
			if (kind !== prevKind) s.add(e.id);
			prevKind = kind;
		}
		return s;
	}, [visible]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	/**
	 * First visible row and its offset from the viewport top, captured before
	 * mounting earlier rows. Restoring against the row, not the total height
	 * delta, stays exact when the same commit also appends live entries.
	 */
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [start]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		// Пользователь явно идёт в историю — отвязываем tail-follow, иначе
		// следование за хвостом возвращает окно к концу и раскрытие откатывается.
		lockRef.current = false;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (row.classList.contains("tr-earlier")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
		setPinnedStart(Math.max(0, start - EARLIER_STEP));
	};

	// Tail-append detection in one pointer compare: new entries extend the
	// previous array (same prefix) → animate only the appended rows. A replaced
	// array (snapshot download / retract) clears the animation set so batch
	// loads and re-mounts never rise.
	const animRef = useRef<Set<string>>(new Set());
	const tailRef = useRef<{ length: number; tailId: string | null }>({ length: 0, tailId: null });
	{
		const prev = tailRef.current;
		if (entries.length === prev.length && (entries[prev.length - 1]?.id ?? null) === prev.tailId) {
			// unchanged
		} else if (
			prev.length > 0 &&
			entries.length > prev.length &&
			(entries[prev.length - 1]?.id ?? null) === prev.tailId
		) {
			for (let i = prev.length; i < entries.length; i++) animRef.current.add(entries[i].id);
		} else {
			animRef.current.clear();
		}
		tailRef.current = { length: entries.length, tailId: entries[entries.length - 1]?.id ?? null };
	}

	// Tool calls committed anywhere in the session: incremental cursor over
	// appended entries only; a replaced array (snapshot retract) rescans from
	// scratch. Bumping `committedVersion` re-derives `tailTools` without
	// rescanning per streaming token or tool output update.
	const scanRef = useRef<{ count: number; tailId: string | null; ids: Set<string> }>({
		count: 0,
		tailId: null,
		ids: new Set<string>(),
	});
	const [committedVersion, setCommittedVersion] = useState(0);
	{
		const s = scanRef.current;
		const last = entries.length > 0 ? entries[entries.length - 1] : null;
		// Already scanned this exact array (incl. the empty one) — otherwise the
		// setState below loops forever on an empty transcript.
		const sameTail = s.count === entries.length && (last === null || last.id === s.tailId);
		if (!sameTail) {
			const incremental = s.count > 0 && s.count <= entries.length && entries[s.count - 1].id === s.tailId;
			let from: number;
			if (incremental) {
				from = s.count;
			} else {
				s.ids.clear();
				from = 0;
			}
			for (let i = from; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				for (const block of entry.message.content) {
					if (block.type === "toolCall") s.ids.add(block.id);
				}
			}
			s.count = entries.length;
			s.tailId = last?.id ?? null;
			setCommittedVersion(v => v + 1);
		}
	}
	const committedToolIds = scanRef.current.ids;

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		void committedVersion;
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, committedVersion, stream, activeTools]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	// ---- Progressive disclosure: серии ≥MIN_GROUP подряд идущих committed tool-карточек ----
	const activeTail = stream !== null || tailTools.length > 0 || working;
	const lastEntryId = entries.length > 0 ? entries[entries.length - 1].id : null;
	const entryById = useMemo(() => {
		const map = new Map<string, SessionEntry>();
		for (const entry of visible) map.set(entry.id, entry);
		return map;
	}, [visible]);
	const toolGroups = useMemo(() => {
		const starts = new Map<string, ToolGroupInfo>();
		const covered = new Set<string>();
		let run: string[] = [];
		let names: string[] = [];
		let errors = 0;
		// Серия, идущая непосредственно перед активным хвостом (stream/tailTools/working),
		// не сворачивается — пользователь смотрит живые карточки.
		const flush = (tailBlocked: boolean): void => {
			if (run.length >= MIN_GROUP && !tailBlocked) {
				const firstId = run[0];
				starts.set(firstId, { ids: [...run], names, errors });
				for (const id of run) covered.add(id);
			}
			run = [];
			names = [];
			errors = 0;
		};
		visible.forEach((entry, i) => {
			const kind = toolRunClass(entry, results);
			if (kind === "spacer") return;
			if (kind === "tool") {
				if (entry.type === "message" && entry.message.role === "assistant") {
					for (const block of entry.message.content) {
						if (block.type !== "toolCall") continue;
						names.push(block.name);
						if (results.get(block.id)?.isError === true) errors++;
					}
				}
				run.push(entry.id);
				// Окно начинается в середине серии — её начало в несмонтированных
				// строках; ложная группировка хуже лишней карточки.
				if ((start === 0 || i > 0) && entry.id === lastEntryId && activeTail) flush(true);
				return;
			}
			flush(false);
		});
		flush(false);
		return { starts, covered };
	}, [visible, results, activeTail, lastEntryId, start]);

	const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);

	// Делегирование: клик по любой картинке ленты (миниатюра сообщения или md) — просмотр.
	const onImageClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
		const target = e.target;
		if (!(target instanceof HTMLImageElement)) return;
		const src = target.getAttribute("src");
		if (src === null || src.length === 0) return;
		e.preventDefault();
		setViewer({ src, alt: target.alt });
	};

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onClick={onImageClick}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				updateTranscriptTailLock(el, lockRef);
				// Back at the bottom: drop the pin so the window trims to the tail again.
				if (lockRef.current) {
					if (pinnedStart !== null) setPinnedStart(null);
				} else if (pinnedStart === null) {
					setPinnedStart(start);
				}
				if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">Пока тихо — напиши агенту</div>
			)}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={showEarlier}>
					Показать ещё · {start.toLocaleString("ru-RU")}
				</button>
			)}
			<CommittedList
				visible={visible}
				toolGroups={toolGroups}
				entryById={entryById}
				results={results}
				activeTools={activeTools}
				groupStarts={groupStarts}
				animIds={animRef.current}
				host={host}
			/>
			{stream !== null && (
				<Row kind="assistant" gutter={groupStarts.has(visible[visible.length - 1]?.id ?? "") ? "agent" : ""}>
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
			{viewer !== null && <ImageViewer src={viewer.src} alt={viewer.alt} onClose={() => setViewer(null)} />}
		</div>
	);
}
