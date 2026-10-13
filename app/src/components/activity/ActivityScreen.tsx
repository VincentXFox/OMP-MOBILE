import { useMemo, type ReactNode } from "react";
import { AlertTriangle, MessageCircle, Wrench } from "lucide-react";
import { messageText } from "../../lib/format";
import type { HostInfo } from "../../lib/gateway";
import type { GuestClient } from "../../lib/client";
import { useGuestSnapshot } from "../../lib/use-guest";
import type { SessionEntry } from "@oh-my-pi/pi-wire";

interface ActivityRow {
	id: string;
	kind: "tool" | "message" | "error";
	title: string;
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
				if (msg?.role === "toolCall") list.push({ id: entry.id, kind: "tool", title: entryTitle(entry) });
				else list.push({ id: entry.id, kind: entryKind(entry), title: entryTitle(entry) });
			}
		}
		return list.slice(-50);
	}, [snap.entries]);

	return (
		<div className="pk-list" onClick={props.onOpenSession}>
			{rows.length === 0 ? (
				<div className="pk-empty">
					<div className="pk-empty-text">Пока нет активности в этой сессии.</div>
				</div>
			) : (
				rows.map(r => (
					<button key={r.id} className="pk-row">
						<span className={`pk-row-icon pk-row-icon--${r.kind}`}>
							{r.kind === "tool" ? <Wrench size={16} /> : r.kind === "error" ? <AlertTriangle size={16} /> : <MessageCircle size={16} />}
						</span>
						<span className="pk-row-title">{r.title || "…"}</span>
					</button>
				))
			)}
		</div>
	);
}

export function ActivityScreen(props: {
	client: GuestClient | null;
	onOpenSession: () => void;
	hosts: HostInfo[] | null;
}): ReactNode {
	if (!props.client) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Нет открытой сессии</div>
				<div className="pk-empty-text">Открой агента, чтобы увидеть активность.</div>
			</div>
		);
	}
	return <ActivityFeed client={props.client} onOpenSession={props.onOpenSession} />;
}
