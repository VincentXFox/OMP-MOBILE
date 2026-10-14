import { useMemo, type ReactNode } from "react";
import { CircleAlert, MessageCircle, Wrench } from "lucide-react";
import { messageText } from "../../lib/format";
import type { HostInfo } from "../../lib/gateway";
import type { GuestClient } from "../../lib/client";
import { useGuestSnapshot } from "../../lib/use-guest";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import "./activity.css";

interface ActivityRow {
	id: string;
	kind: "tool" | "message" | "error";
	title: string;
	ts: string;
}

interface ActivitySection {
	label: string;
	rows: ActivityRow[];
}

const TIME_FMT = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const DAY_MS = 86_400_000;

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

function entryTitle(entry: SessionEntry): string {
	if (entry.type === "message") {
		const msg = entry.message as { role?: string } | undefined;
		if (msg?.role === "toolResult") return messageText(entry.message).slice(0, 120);
		return messageText(entry.message).slice(0, 120);
	}
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

function entryKind(entry: SessionEntry): ActivityRow["kind"] {
	if (entry.type === "message") {
		const msg = entry.message as { role?: string; stopReason?: string } | undefined;
		if (msg?.role === "toolResult") return "tool";
		const text = messageText(entry.message);
		if (msg?.role === "assistant" && /error|failed|panic/i.test(text)) return "error";
		return "message";
	}
	return "message";
}

function ActivityFeed(props: { client: GuestClient; onOpenSession: () => void }): ReactNode {
	const snap = useGuestSnapshot(props.client);
	const rows = useMemo<ActivityRow[]>(() => {
		const list: ActivityRow[] = [];
		for (const entry of snap.entries) {
			if (entry.type === "message") {
				const msg = entry.message as { role?: string } | undefined;
				if (msg?.role === "toolCall") list.push({ id: entry.id, kind: "tool", title: entryTitle(entry), ts: entry.timestamp });
				else list.push({ id: entry.id, kind: entryKind(entry), title: entryTitle(entry), ts: entry.timestamp });
			}
		}
		return list.slice(-50);
	}, [snap.entries]);

	const sections = useMemo<ActivitySection[]>(() => {
		const out: ActivitySection[] = [];
		for (const row of rows) {
			const label = sectionLabel(row.ts);
			const last = out[out.length - 1];
			if (last && last.label === label) last.rows.push(row);
			else out.push({ label, rows: [row] });
		}
		return out;
	}, [rows]);

	return (
		<div className="ac-feed">
			{rows.length === 0 ? (
				<div className="pk-empty">
					<div className="pk-empty-title">Тишина</div>
					<div className="pk-empty-text">Пока нет активности в этой сессии.</div>
				</div>
			) : (
				sections.map(section => (
					<section key={`${section.label}:${section.rows[0]?.id ?? ""}`} className="ac-section">
						<div className="ac-section-title">{section.label}</div>
						<div className="ac-section-rows">
							{section.rows.map(r => (
								<div key={r.id} className={`ac-row${r.kind === "error" ? " ac-row--error" : ""}`}>
									<span className={`ac-row-icon ac-row-icon--${r.kind}`}>
										{r.kind === "tool" ? <Wrench size={15} /> : r.kind === "error" ? <CircleAlert size={15} /> : <MessageCircle size={15} />}
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
				))
			)}
		</div>
	);
}

export function ActivityScreen(props: {
	client: GuestClient | null;
	onOpenSession: () => void;
	hosts: HostInfo[] | null;
	error: string | null;
	onRetry: () => void;
}): ReactNode {
	if (props.client) {
		return <ActivityFeed client={props.client} onOpenSession={props.onOpenSession} />;
	}
	// Сессии нет И шлюз ошибся — честная ошибка с повтором вместо пустого состояния.
	if (props.error != null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось загрузить активность</div>
				<div className="pk-empty-text">{props.error}</div>
				<div className="pk-empty-text">Проверьте адрес шлюза и токен в Настройках.</div>
				<button type="button" className="pk-btn pk-btn--ghost" onClick={props.onRetry}>
					Повторить
				</button>
			</div>
		);
	}
	return (
		<div className="pk-empty">
			<div className="pk-empty-title">Нет открытой сессии</div>
			<div className="pk-empty-text">Открой агента, чтобы увидеть активность.</div>
		</div>
	);
}
