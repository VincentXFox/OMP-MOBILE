import type { ReactNode } from "react";

export interface ContextUsageView {
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
}

function short(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

/**
 * Полоса контекста: сколько окна уже занято. Живёт между туду и вводом —
 * ровно там, куда смотрит человек, когда пишет следующее сообщение.
 * Цвет меняется заранее (60% / 85%), чтобы успеть начать новую сессию,
 * а при переполнении показываем «почти всё».
 */
export function ContextBar({ usage }: { usage: ContextUsageView | null | undefined }): ReactNode {
	if (!usage || usage.percent == null) return null;
	const percent = Math.max(0, Math.min(100, usage.percent));
	const tone = percent >= 85 ? "ss-ctx--danger" : percent >= 60 ? "ss-ctx--warn" : "ss-ctx--ok";
	const tokens = typeof usage.tokens === "number" ? usage.tokens : null;
	const window = typeof usage.contextWindow === "number" ? usage.contextWindow : null;
	const label = tokens !== null && window !== null ? `${short(tokens)} / ${short(window)}` : tokens !== null ? short(tokens) : "";
	return (
		<div className={`ss-ctx ${tone}`} role="status" aria-label={`Контекст занят на ${Math.round(percent)} процентов`}>
			<span className="ss-ctx-label">
				<span className="ss-ctx-title">{percent >= 85 ? "контекст почти полон" : "контекст"}</span>
				<span className="ss-ctx-value">{Math.round(percent)}%</span>
				{label !== "" && <span className="ss-ctx-tokens">{label}</span>}
			</span>
			<span className="ss-ctx-track" aria-hidden="true">
				<span className="ss-ctx-fill" style={{ width: `${percent}%` }} />
			</span>
		</div>
	);
}
