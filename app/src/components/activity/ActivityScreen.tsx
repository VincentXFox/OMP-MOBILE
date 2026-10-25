import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, MessageCircle, Wrench } from "lucide-react";
import { messageText } from "../../lib/format";
import { fetchActivity, type ActivityRow as FeedRow, type HostInfo } from "../../lib/gateway";
import type { GuestClient } from "../../lib/client";
import { useGuestSnapshot } from "../../lib/use-guest";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import "./activity.css";

interface LiveRow {
	id: string;
	kind: "tool" | "message" | "error";
	title: string;
	ts: string;
}

interface ActivitySection<Row> {
	label: string;
	rows: Row[];
}

const TIME_FMT = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const DAY_MS = 86_400_000;
const FEED_LIMIT = 60;
const FEED_REFRESH_MS = 15_000;

function rowTime(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? "" : TIME_FMT.format(date);
}

function sectionLabel(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "Раньше";
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	if (day === today) return "Сегодня";
	if (day === today - DAY_MS) return "Вчера";
	return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** Группировка по дням: общая для живой ленты и истории. */
function groupByDay<Row extends { ts: string }>(rows: readonly Row[]): ActivitySection<Row>[] {
	const out: ActivitySection<Row>[] = [];
	for (const row of rows) {
		const label = sectionLabel(row.ts);
		const last = out[out.length - 1];
		if (last && last.label === label) last.rows.push(row);
		else out.push({ label, rows: [row] });
	}
	return out;
}

function liveTitle(entry: SessionEntry): string {
	if (entry.type === "message") return messageText(entry.message).slice(0, 120);
	if (entry.type === "custom_message") {
		if (typeof entry.content === "string") return entry.content.slice(0, 120);
		const text = entry.content.find(c => typeof c === "object" && "text" in c);
		return typeof text === "object" && text !== null && "text" in text ? String(text.text).slice(0, 120) : entry.customType;
	}
	if (entry.type === "compaction") return entry.shortSummary ?? entry.summary;
	if (entry.type === "branch_summary") return entry.summary ?? "ветка";
	if (entry.type === "model_change") return `Модель: ${entry.model}`;
	return entry.type;
}

function liveKind(entry: SessionEntry): LiveRow["kind"] {
	if (entry.type === "message") {
		const msg = entry.message as { role?: string } | undefined;
		if (msg?.role === "toolResult") return "tool";
		const text = messageText(entry.message);
		if (msg?.role === "assistant" && /error|failed|panic/i.test(text)) return "error";
		return "message";
	}
	return "message";
}

function RowIcon(props: { kind: LiveRow["kind"] }): ReactNode {
	if (props.kind === "tool") return <Wrench size={15} />;
	if (props.kind === "error") return <CircleAlert size={15} />;
	return <MessageCircle size={15} />;
}

/** Живая лента открытого чата: события приходят по сокету гостя. */
function LiveFeed(props: { client: GuestClient; onOpenSession: () => void }): ReactNode {
	const snap = useGuestSnapshot(props.client);
	const rows = useMemo<LiveRow[]>(() => {
		const list: LiveRow[] = [];
		for (const entry of snap.entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string } | undefined;
			list.push({
				id: entry.id,
				kind: msg?.role === "toolCall" ? "tool" : liveKind(entry),
				title: liveTitle(entry),
				ts: entry.timestamp,
			});
		}
		return list.slice(-50);
	}, [snap.entries]);

	const sections = useMemo(() => groupByDay(rows), [rows]);

	if (rows.length === 0) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Тишина</div>
				<div className="pk-empty-text">Пока нет активности в этой сессии.</div>
			</div>
		);
	}
	return (
		<div className="ac-feed">
			{sections.map(section => (
				<section key={`${section.label}:${section.rows[0]?.id ?? ""}`} className="ac-section">
					<div className="ac-section-title">{section.label}</div>
					<div className="ac-section-rows">
						{section.rows.map(r => (
							<div key={r.id} className={`ac-row${r.kind === "error" ? " ac-row--error" : ""}`}>
								<span className={`ac-row-icon ac-row-icon--${r.kind}`}>
									<RowIcon kind={r.kind} />
								</span>
								<span className="ac-row-title">{r.title || "…"}</span>
								{r.ts !== "" && <span className="ac-row-time">{rowTime(r.ts)}</span>}
								<button type="button" className="pk-btn pk-btn--ghost ac-row-open" onClick={props.onOpenSession}>
									Открыть
								</button>
							</div>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

/** История активности по недавним сессиям: источник — логи сессий на шлюзе. */
function GlobalFeed(props: { onOpenRow: (row: FeedRow) => void }): ReactNode {
	const [rows, setRows] = useState<FeedRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		let timer = 0;
		const load = async (): Promise<void> => {
			try {
				const next = await fetchActivity(FEED_LIMIT, controller.signal);
				if (controller.signal.aborted) return;
				setRows(next);
				setError(null);
			} catch (err) {
				if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
			}
			if (!controller.signal.aborted) timer = window.setTimeout(() => void load(), FEED_REFRESH_MS);
		};
		void load();
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [attempt]);

	const sections = useMemo(() => (rows === null ? [] : groupByDay(rows)), [rows]);

	if (rows === null) {
		return error !== null ? (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось загрузить активность</div>
				<div className="pk-empty-text">{error}</div>
				<button type="button" className="pk-btn pk-btn--ghost" onClick={() => setAttempt(n => n + 1)}>
					Повторить
				</button>
			</div>
		) : (
			<div className="pk-empty">
				<div className="pk-empty-text">Загрузка…</div>
			</div>
		);
	}

	if (rows.length === 0) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Тишина</div>
				<div className="pk-empty-text">В недавних сессиях ещё нет реплик.</div>
			</div>
		);
	}

	return (
		<div className="ac-feed">
			{/* Ошибка обновления не прячет уже загруженную ленту — но и не молчит. */}
			{error !== null && (
				<div className="pk-form-error" role="alert">
					Обновление не удалось: {error}{" "}
					<button type="button" className="pk-btn pk-btn--ghost" onClick={() => setAttempt(n => n + 1)}>
						Повторить
					</button>
				</div>
			)}
			{sections.map(section => (
				<section key={section.label} className="ac-section">
					<div className="ac-section-title">{section.label}</div>
					<div className="ac-section-rows">
						{section.rows.map(row => (
							<button
								key={`${row.sessionId}:${row.id}`}
								type="button"
								className={`ac-row ac-row--global${row.kind === "error" ? " ac-row--error" : ""}`}
								onClick={() => props.onOpenRow(row)}
							>
								<span className={`ac-row-icon ac-row-icon--${row.kind}`}>
									<RowIcon kind={row.kind} />
								</span>
								<span className="ac-row-body">
									<span className="ac-row-session">{row.sessionTitle ?? row.cwd ?? "Сессия"}</span>
									<span className="ac-row-text">{row.text}</span>
								</span>
								<span className="ac-row-time">{rowTime(row.ts)}</span>
							</button>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

export function ActivityScreen(props: {
	client: GuestClient | null;
	onOpenSession: () => void;
	onOpenRow: (row: FeedRow) => void;
	hosts: HostInfo[] | null;
	error: string | null;
	onRetry: () => void;
}): ReactNode {
	if (props.client) return <LiveFeed client={props.client} onOpenSession={props.onOpenSession} />;
	// Без открытого чата вкладка показывает историю по всем сессиям, а не пустоту.
	return <GlobalFeed onOpenRow={props.onOpenRow} />;
}
