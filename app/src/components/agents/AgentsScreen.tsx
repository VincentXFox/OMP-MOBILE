import { Check, CircleAlert, Lock, OctagonPause, Play, Plus, Timer, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { basename } from "../../lib/format";
import type { HostInfo, SuperAgent, SuperBoard } from "../../lib/gateway";
import { fetchSuperBoard, startAgent } from "../../lib/gateway";
import "./agents.css";

export type HostStatus = {
	label: string;
	tone: "accent" | "warning" | "success" | "muted";
	pulse: boolean;
	/** Status is never colour-only: shape + text come with the dot. */
	icon: ReactNode;
};

export function hostStatus(host: HostInfo): HostStatus {
	if (!host.relayConnected)
		return { label: "Нет связи", tone: "muted", pulse: false, icon: <CircleAlert size={14} /> };
	if (host.inputRequired)
		return { label: "Ждёт подтверждения", tone: "warning", pulse: false, icon: <OctagonPause size={14} /> };
	if (host.busy) return { label: "Работает", tone: "accent", pulse: true, icon: <Play size={14} /> };
	// Idle = агент дошёл до конца своей задачи: завершён, а не «ждёт».
	return { label: "Выполнен", tone: "success", pulse: false, icon: <Check size={14} /> };
}

/** Приоритет карточки: работающий → ждёт подтверждения → завершён. */
function statusRank(host: HostInfo): number {
	if (host.busy) return 0;
	if (host.inputRequired) return 1;
	return 2;
}

/** Живое время работы: <60с «только что», <60м «N мин», иначе «N ч M мин». */
function elapsedText(startedAt: number): string {
	const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	if (s < 60) return "только что";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} мин`;
	return `${Math.floor(m / 60)} ч ${m % 60} мин`;
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

/** One-shot board fetch per screen mount — identity hints only, not a poll loop. */
function useSuperBoardOnce(): SuperBoard | null {
	const [board, setBoard] = useState<SuperBoard | null>(null);
	useEffect(() => {
		let alive = true;
		fetchSuperBoard()
			.then(b => {
				if (alive) setBoard(b);
			})
			.catch(() => {
				// identity stays on fallbacks (session title / basename)
			});
		return () => {
			alive = false;
		};
	}, []);
	return board;
}

/**
 * Host ⇄ board-agent identity: super board knows agent names (qa, qa-rb-1…),
 * /api/hosts does not. Match by live instance first (board agent carries the
 * host session), then — for hostless board agents — by unique cwd, then cwd+title.
 */
function matchBoardAgent(host: HostInfo, board: SuperBoard | null): SuperAgent | undefined {
	if (board == null) return undefined;
	const byInstance = board.agents.find(a => a.host?.instanceId === host.instanceId);
	if (byInstance) return byInstance;
	const hostless = board.agents.filter(a => a.host == null && a.cwd === host.cwd);
	if (hostless.length === 1) return hostless[0];
	return hostless.find(a => a.title !== "" && a.title === host.sessionName);
}

/** Имя чата: пользовательское → заголовок сессии → herdr-имя → basename(cwd). */
/** Служебные имена (resume--x, restore-x, черновики Pocket) → человеческий текст. */
function humanizeServiceName(name: string): string {
	if (/^resume--/.test(name)) {
		const tail = name.slice("resume--".length).trim();
		return tail ? `Восстановленная сессия · ${tail}` : "Восстановленная сессия";
	}
	if (/^restore-/.test(name)) {
		const tail = name.slice("restore-".length).trim();
		return tail ? `Восстановленная сессия · ${tail}` : "Восстановленная сессия";
	}
	if (name.includes("omp-pocket-scratch")) return "Черновик Pocket";
	return name;
}

function hostDisplayName(host: HostInfo, board: SuperBoard | null): string {
	if (host.displayName) return host.displayName;
	if (host.sessionName) return humanizeServiceName(host.sessionName);
	return humanizeServiceName(matchBoardAgent(host, board)?.name ?? basename(host.cwd));
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

function HostCard(props: { host: HostInfo; board: SuperBoard | null; onOpen: (host: HostInfo) => void }): ReactNode {
	const { host, board, onOpen } = props;
	const status = hostStatus(host);
	const dim = !host.relayConnected;
	// Re-render every 30s so «5 мин назад» stays fresh.
	useTick(30_000);
	return (
		<button
			className={`pk-card pk-host${dim ? " pk-host--dim" : ""}${host.inputRequired ? " pk-host--attention" : ""}`}
			onClick={() => onOpen(host)}
		>
			<span className="ag-name">{hostDisplayName(host, board)}</span>
			<span className="ag-status">
				<span className={`pk-dot pk-dot--${status.tone}${status.pulse ? " pk-dot--pulse" : ""}`} />
				<span className="ag-status-icon">{status.icon}</span>
				<span>{status.label}</span>
				{host.busy && (
					<span className="ag-elapsed">
						<Timer size={12} />
						{elapsedText(host.startedAt)}
					</span>
				)}
				{host.access === "view" && (
					<span className="ag-lock">
						<Lock size={12} />
						только просмотр
					</span>
				)}
			</span>
			<span className="ag-meta">
				<span className="ag-meta-proj">{basename(host.cwd)}</span>
				<span aria-hidden="true">·</span>
				<span className="ag-meta-model">
					{host.model.provider}/{host.model.id}
				</span>
				<span className="ag-uptime">{agoText(host.startedAt)}</span>
			</span>
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
	const sheetRef = useRef<HTMLDivElement | null>(null);

	// .pk-sheet contract: focus moves in, Escape closes, focus returns on close.
	useEffect(() => {
		const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		sheetRef.current?.focus();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			prev?.focus();
		};
	}, [onClose]);

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
		if (result.ok === true) {
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
			<div className="pk-sheet" role="dialog" aria-modal="true" aria-labelledby="na-title" ref={sheetRef} tabIndex={-1}>
				<div className="pk-sheet-handle" />
				<div className="pk-sheet-title" id="na-title">
					Новый агент
				</div>
				<div className="pk-field">
					<label className="pk-field-label" htmlFor="na-cwd">
						Папка проекта
					</label>
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
					<label className="pk-field-label" htmlFor="na-model">
						Модель (необязательно)
					</label>
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
					<label className="pk-field-label" htmlFor="na-label">
						Имя (необязательно)
					</label>
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
	const board = useSuperBoardOnce();

	// Polling errors must not blank the screen: keep the last good list.
	const lastHosts = useRef<HostInfo[] | null>(null);
	if (hosts != null) lastHosts.current = hosts;
	const shown = hosts ?? lastHosts.current;
	const stale = error != null && shown != null;

	const showToast = useCallback((text: string) => {
		setToast(text);
		window.setTimeout(() => setToast(null), 5000);
	}, []);

	const retry = onRefresh ? (
		<button type="button" className="pk-btn pk-btn--ghost ag-retry" onClick={onRefresh}>
			Повторить
		</button>
	) : null;

	const staleBanner =
		stale && onRefresh ? (
			<div className="ag-stale" role="alert">
				<CircleAlert size={16} />
				<span className="ag-stale-text">Нет связи со шлюзом — показаны последние данные</span>
				{retry}
			</div>
		) : null;

	const suggestions: string[] = [];
	if (shown != null) {
		for (const h of shown) if (!suggestions.includes(h.cwd)) suggestions.push(h.cwd);
	}

	let body: ReactNode;
	if (shown == null && error != null) {
		body = (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить список</div>
				<div className="pk-empty-text">{error}</div>
				<div className="pk-empty-text">Проверьте адрес шлюза и токен в Настройках.</div>
				{retry}
			</div>
		);
	} else if (shown == null) {
		// First load: skeleton, not a bare «Загрузка…».
		body = (
			<div className="pk-list ag-list">
				{[0, 1, 2].map(i => (
					<div key={i} className="pk-card ag-skel" aria-hidden="true">
						<span className="pk-skeleton ag-skel-name" />
						<span className="pk-skeleton ag-skel-line" />
						<span className="pk-skeleton ag-skel-meta" />
					</div>
				))}
			</div>
		);
	} else {
		const filtered = filterCwd ? shown.filter(h => h.cwd === filterCwd) : shown;
		if (filtered.length === 0) {
			body = (
				<>
					{staleBanner}
					<div className="pk-empty">
						<div className="pk-empty-title">Агентов нет</div>
						<div className="pk-empty-text">Создай агента кнопкой «+» или выполни /collab в сессии OMP.</div>
					</div>
				</>
			);
		} else {
			body = (
				<div className="pk-list ag-list">
					{staleBanner}
					{filterCwd && (
						<button className="pk-filter" onClick={onClearFilter}>
							Проект: {basename(filterCwd)}
							<X size={14} />
						</button>
					)}
					{[...filtered]
						.sort((a, b) => statusRank(a) - statusRank(b) || b.startedAt - a.startedAt)
						.map(h => (
							<HostCard key={h.instanceId} host={h} board={board} onOpen={onOpen} />
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
			{sheetOpen && shown != null && (
				<NewAgentSheet
					suggestions={suggestions}
					onClose={() => setSheetOpen(false)}
					onCreated={() => onRefresh?.()}
					onToast={showToast}
				/>
			)}
			{toast != null && (
				<div className="pk-toast" role="status">
					<span>{toast}</span>
					<button type="button" className="pk-toast-x" aria-label="Скрыть" onClick={() => setToast(null)}>
						<X size={14} />
					</button>
				</div>
			)}
		</>
	);
}
