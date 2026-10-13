import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { basename } from "../../lib/format";
import type { HostInfo } from "../../lib/gateway";
import { startAgent } from "../../lib/gateway";

export type HostStatus = {
	label: string;
	tone: "accent" | "warning" | "success" | "muted";
	pulse: boolean;
};

export function hostStatus(host: HostInfo): HostStatus {
	if (!host.relayConnected) return { label: "Нет связи", tone: "muted", pulse: false };
	if (host.inputRequired) return { label: "Требует решения", tone: "warning", pulse: false };
	if (host.busy) return { label: "Работает", tone: "accent", pulse: true };
	return { label: "Ожидает", tone: "success", pulse: false };
}

/** Re-renders every `intervalMs` so relative times stay fresh. */
function useTick(intervalMs: number): number {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick(t => t + 1), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return tick;
}

function agoText(startedAt: number): string {
	const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	if (s < 60) return "только что";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} мин назад`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} ч назад`;
	return `${Math.floor(h / 24)} дн назад`;
}

function HostCard(props: { host: HostInfo; onOpen: (host: HostInfo) => void }): ReactNode {
	const { host, onOpen } = props;
	const status = hostStatus(host);
	const dim = !host.relayConnected;
	// Re-render every 30s so «запущен … назад» stays fresh.
	useTick(30_000);
	return (
		<button
			className={`pk-card pk-host${dim ? " pk-host--dim" : ""}${host.inputRequired ? " pk-host--attention" : ""}`}
			onClick={() => onOpen(host)}
		>
			<div className="pk-host-head">
				<span className="pk-host-title">{host.sessionName || basename(host.cwd)}</span>
				<span className="pk-pill">{host.model.provider}/{host.model.id}</span>
			</div>
			<div className="pk-host-cwd">{host.cwd}</div>
			<div className="pk-host-meta">
				<span className={`pk-dot pk-dot--${status.tone}${status.pulse ? " pk-dot--pulse" : ""}`} />
				<span>{status.label}</span>
				<span className="pk-host-uptime">запущен {agoText(host.startedAt)}</span>
				{host.access === "view" && <span className="pk-lock">🔒 только просмотр</span>}
			</div>
		</button>
	);
}

function NewAgentSheet(props: {
	suggestions: readonly string[];
	onClose: () => void;
	onCreated: () => void;
	onToast: (text: string) => void;
}): ReactNode {
	const { suggestions, onClose, onCreated, onToast } = props;
	const [cwd, setCwd] = useState(suggestions[0] ?? "");
	const [model, setModel] = useState("");
	const [label, setLabel] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(async () => {
		if (submitting) return;
		const trimmed = cwd.trim();
		if (trimmed.length === 0) {
			setError("Укажи путь к проекту");
			return;
		}
		setSubmitting(true);
		setError(null);
		const result = await startAgent(trimmed, model.trim() || undefined, label.trim() || undefined);
		if (result.ok) {
			onToast("Агент создаётся…");
			onCreated();
			onClose();
		} else {
			setError(result.error);
			setSubmitting(false);
		}
	}, [cwd, label, model, onClose, onCreated, onToast, submitting]);

	return (
		<>
			<div className="pk-sheet-backdrop" onClick={onClose} />
			<div className="pk-sheet" role="dialog" aria-modal="true">
				<div className="pk-sheet-handle" />
				<div className="pk-sheet-title">Новый агент</div>
				<div className="pk-field">
					<label className="pk-field-label" htmlFor="na-cwd">Папка проекта</label>
					<input
						id="na-cwd"
						className="pk-field-input"
						value={cwd}
						placeholder="/home/user/project"
						spellCheck={false}
						onChange={e => setCwd(e.target.value)}
					/>
					{suggestions.length > 0 && (
						<div className="pk-chips">
							{suggestions.map(s => (
								<button key={s} type="button" className={`pk-chip${s === cwd ? " pk-chip--on" : ""}`} onClick={() => setCwd(s)}>
									{basename(s)}
								</button>
							))}
						</div>
					)}
				</div>
				<div className="pk-field">
					<label className="pk-field-label" htmlFor="na-model">Модель (необязательно)</label>
					<input
						id="na-model"
						className="pk-field-input"
						value={model}
						placeholder="glm-5.3-flash"
						spellCheck={false}
						onChange={e => setModel(e.target.value)}
					/>
				</div>
				<div className="pk-field">
					<label className="pk-field-label" htmlFor="na-label">Имя (необязательно)</label>
					<input
						id="na-label"
						className="pk-field-input"
						value={label}
						placeholder="Основной агент"
						onChange={e => setLabel(e.target.value)}
					/>
				</div>
				{error != null && <div className="pk-form-error">{error}</div>}
				<button type="button" className="pk-sheet-submit" disabled={submitting || cwd.trim().length === 0} onClick={() => void submit()}>
					{submitting ? <span className="pk-spinner" aria-label="Создание…" /> : "Создать"}
				</button>
			</div>
		</>
	);
}

export function AgentsScreen(props: {
	hosts: HostInfo[] | null;
	error: string | null;
	filterCwd: string | null;
	onClearFilter: () => void;
	onOpen: (host: HostInfo) => void;
	onRefresh?: () => void;
}): ReactNode {
	const { hosts, error, filterCwd, onClearFilter, onOpen, onRefresh } = props;
	const [sheetOpen, setSheetOpen] = useState(false);
	const [toast, setToast] = useState<string | null>(null);

	const showToast = useCallback((text: string) => {
		setToast(text);
		window.setTimeout(() => setToast(null), 5000);
	}, []);

	const suggestions: string[] = [];
	if (hosts != null) {
		for (const h of hosts) if (!suggestions.includes(h.cwd)) suggestions.push(h.cwd);
	}

	let body: ReactNode;
	if (error != null) {
		body = (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить список</div>
				<div className="pk-empty-text">{error}</div>
				<div className="pk-empty-text">Проверьте адрес шлюза и токен в Настройках.</div>
			</div>
		);
	} else if (hosts == null) {
		body = (
			<div className="pk-empty">
				<div className="pk-empty-text">Загрузка…</div>
			</div>
		);
	} else {
		const filtered = filterCwd ? hosts.filter(h => h.cwd === filterCwd) : hosts;
		if (filtered.length === 0) {
			body = (
				<div className="pk-empty">
					<div className="pk-empty-title">Агентов нет</div>
					<div className="pk-empty-text">
						Создай агента кнопкой «+» или выполни /collab в сессии OMP.
					</div>
				</div>
			);
		} else {
			body = (
				<div className="pk-list">
					{filterCwd && (
						<button className="pk-filter" onClick={onClearFilter}>
							Проект: {basename(filterCwd)} ✕
						</button>
					)}
					{filtered.map(h => (
						<HostCard key={h.instanceId} host={h} onOpen={onOpen} />
					))}
				</div>
			);
		}
	}

	return (
		<>
			{body}
			{error == null && (
				<button type="button" className="pk-fab" aria-label="Новый агент" onClick={() => setSheetOpen(true)}>
					<Plus size={26} />
				</button>
			)}
			{sheetOpen && hosts != null && (
				<NewAgentSheet
					suggestions={suggestions}
					onClose={() => setSheetOpen(false)}
					onCreated={() => onRefresh?.()}
					onToast={showToast}
				/>
			)}
			{toast != null && (
				<div className="pk-toast">
					<span>{toast}</span>
					<button type="button" className="pk-toast-x" aria-label="Скрыть" onClick={() => setToast(null)}>
						<X size={14} />
					</button>
				</div>
			)}
		</>
	);
}
