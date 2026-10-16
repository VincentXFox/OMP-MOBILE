import { ArrowLeft, ChevronDown, Check, CircleAlert, Folder, Lock, OctagonPause, Play, Plus, Search, Star, Timer, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { basename, dayTimeLabel, pluralRu, shortenPath } from "../../lib/format";
import { agentName } from "../../lib/agent-name";
import { openedTimes, pinnedSessions, sectionCollapsedPrefs, setSectionCollapsed, togglePinned } from "../../lib/agent-prefs";
import type { HostInfo, ModelOption, ProjectFileEntry, SuperAgent, SuperBoard } from "../../lib/gateway";
import { fetchModels, fetchSuperBoard, listProjectFiles, resumeAgentHost, startAgent } from "../../lib/gateway";
import { ModelPickerSheet } from "../shell/ModelPickerSheet";
import "./agents.css";

export type HostStatus = {
	label: string;
	tone: "accent" | "warning" | "success" | "muted";
	pulse: boolean;
	/** Status is never colour-only: shape + text come with the dot. */
	icon: ReactNode;
};

export function hostStatus(host: HostInfo): HostStatus {
	// Мёртвый процесс реестра: join невозможен — только resume.
	if (host.alive === false)
		return { label: "Завершён", tone: "muted", pulse: false, icon: <Check size={14} /> };
	if (!host.relayConnected)
		return { label: "Нет связи", tone: "muted", pulse: false, icon: <CircleAlert size={14} /> };
	if (host.inputRequired)
		return { label: "Ждёт подтверждения", tone: "warning", pulse: false, icon: <OctagonPause size={14} /> };
	if (host.busy) return { label: "Работает", tone: "accent", pulse: true, icon: <Play size={14} /> };
	// Idle = агент дошёл до конца своей задачи: завершён, а не «ждёт».
	return { label: "Выполнен", tone: "success", pulse: false, icon: <Check size={14} /> };
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

/** Секция хаба: агенты лежат не одним мешком, а по тому, что от них нужно. */
type SectionId = "pins" | "attention" | "working" | "idle" | "scratch" | "asleep";

const SECTION_TITLE: Record<SectionId, string> = {
	pins: "Закреплённые",
	attention: "Ждут ответа",
	working: "Работают",
	idle: "На паузе",
	scratch: "Черновики и эксперименты",
	asleep: "Спят и без связи",
};

const SECTION_ORDER: readonly SectionId[] = ["pins", "attention", "working", "idle", "scratch", "asleep"];

/** Свёрнутые по умолчанию секции: мусор не занимает первый экран, но и не
 * исчезает — агент, который ждёт ввода или работает, всегда поднимается наверх. */
const SECTION_COLLAPSED_DEFAULT: readonly SectionId[] = ["scratch", "asleep"];

function isScratchCwd(cwd: string): boolean {
	return cwd === "/tmp" || cwd.startsWith("/tmp/");
}

/** Палитра проектов. Цвет выдаётся папкам по алфавиту (не по хешу): одинаковый
 * цвет = один проект, и он не сталкивается у двух разных папок. */
const PROJECT_HUES: readonly number[] = [265, 205, 160, 95, 45, 10, 330, 300];

function projectHues(hosts: readonly HostInfo[]): Map<string, number> {
	const projects = [...new Set(hosts.map(h => h.cwd))].sort();
	return new Map(projects.map((cwd, i) => [cwd, PROJECT_HUES[i % PROJECT_HUES.length] ?? 265]));
}

function sectionOf(host: HostInfo): SectionId {
	if (host.inputRequired) return "attention";
	if (host.busy) return "working";
	if (host.alive === false || !host.relayConnected) return "asleep";
	return isScratchCwd(host.cwd) ? "scratch" : "idle";
}

type AgentRow = {
	host: HostInfo;
	name: string;
	project: string;
	scratch: boolean;
	hue: number;
	/** Живые субагенты этой сессии (доска «Роя»). */
	subagents: number;
	/** Ключ сортировки внутри секции: свежее открытие важнее времени старта. */
	recency: number;
	haystack: string;
};

function agentRow(host: HostInfo, board: SuperBoard | null, opened: Record<string, number>, hues: ReadonlyMap<string, number>): AgentRow {
	const name = agentName(host);
	return {
		host,
		name,
		project: shortenPath(host.cwd),
		scratch: isScratchCwd(host.cwd),
		hue: hues.get(host.cwd) ?? 265,
		subagents: matchBoardAgent(host, board)?.subagents.filter(s => s.active).length ?? 0,
		recency: Math.max(opened[host.sessionId] ?? 0, host.startedAt),
		haystack: [name, host.cwd, host.model.provider, host.model.id, host.sessionName ?? ""].join(" ").toLowerCase(),
	};
}

function AgentCard(props: {
	row: AgentRow;
	opening?: boolean;
	pinned: boolean;
	onOpen: (host: HostInfo) => void;
	onTogglePin: (sessionId: string) => void;
}): ReactNode {
	const { row, opening = false, pinned } = props;
	const { host } = row;
	const status = hostStatus(host);
	const dim = !host.relayConnected || host.alive === false;
	// Re-render every 30s so «Работает 1 ч 6 мин» stays fresh.
	useTick(30_000);
	return (
		<div
			className={`pk-card ag-card pk-host${dim ? " pk-host--dim" : ""}${host.inputRequired ? " pk-host--attention" : ""}${opening ? " pk-host--opening" : ""}`}
		>
			<span aria-hidden="true" className="ag-rail" style={{ background: `hsl(${row.hue} 55% 55%)` }} />
			<button type="button" className="ag-card-main" disabled={opening} onClick={() => props.onOpen(host)}>
				<span className="ag-name">{row.name}</span>
				<span className="ag-status">
					<span className={`pk-dot pk-dot--${status.tone}${status.pulse ? " pk-dot--pulse" : ""}`} />
					<span className="ag-status-icon">{status.icon}</span>
					<span>{opening ? "Открываю…" : status.label}</span>
					{host.busy && (
						<span className="ag-elapsed">
							<Timer size={12} />
							{elapsedText(host.startedAt)}
						</span>
					)}
					{row.subagents > 0 && (
						<span className="ag-badge ag-badge--live">
							+{row.subagents} {pluralRu(row.subagents, "субагент", "субагента", "субагентов")}
						</span>
					)}
					{row.scratch && <span className="ag-badge">черновик</span>}
					{host.access === "view" && (
						<span className="ag-lock">
							<Lock size={12} />
							только просмотр
						</span>
					)}
				</span>
				<span className="ag-meta">
					<span className="ag-meta-proj">{row.project}</span>
					<span aria-hidden="true">·</span>
					<span className="ag-when">{dayTimeLabel(host.startedAt)}</span>
					<span aria-hidden="true">·</span>
					<span className="ag-meta-model">
						{host.model.provider}/{host.model.id}
					</span>
				</span>
			</button>
			<button
				type="button"
				className={`ag-pin${pinned ? " ag-pin--on" : ""}`}
				aria-pressed={pinned}
				aria-label={pinned ? `Открепить «${row.name}»` : `Закрепить «${row.name}» наверху списка`}
				title={pinned ? "Открепить" : "Закрепить наверху"}
				onClick={() => props.onTogglePin(host.sessionId)}
			>
				<Star size={16} fill={pinned ? "currentColor" : "none"} />
			</button>
		</div>
	);
}

function AgentSection(props: {
	id: SectionId;
	rows: readonly AgentRow[];
	collapsed: boolean;
	openingId: string | null;
	pins: readonly string[];
	onToggle: (id: SectionId) => void;
	onOpen: (host: HostInfo) => void;
	onTogglePin: (sessionId: string) => void;
}): ReactNode {
	const { id, rows, collapsed } = props;
	if (rows.length === 0) return null;
	return (
		<section className="ag-sec" aria-label={SECTION_TITLE[id]}>
			<button
				type="button"
				className={`ag-sec-head${id === "attention" ? " ag-sec-head--attention" : ""}`}
				aria-expanded={!collapsed}
				onClick={() => props.onToggle(id)}
			>
				<ChevronDown size={14} className={`ag-sec-chevron${collapsed ? " ag-sec-chevron--closed" : ""}`} />
				<span className="ag-sec-title">{SECTION_TITLE[id]}</span>
				<span className="ag-sec-count">{rows.length}</span>
			</button>
			{!collapsed && (
				<div className="ag-sec-body">
					{rows.map(row => (
						<AgentCard
							key={row.host.instanceId}
							row={row}
							opening={row.host.instanceId === props.openingId}
							pinned={props.pins.includes(row.host.sessionId)}
							onOpen={props.onOpen}
							onTogglePin={props.onTogglePin}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function parentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	if (idx <= 0) return "/";
	return path.slice(0, idx);
}

/** Сегментированные крошки пикера — тот же паттерн, что fs-crumbs в FilesScreen:
 * корень «/», промежуточные сегменты сжаты в «…», последний показан целиком. */
function PickerBreadcrumbs(props: { path: string; onJump: (path: string) => void }): ReactNode {
	const { path, onJump } = props;
	const parts = path.split("/").filter(p => p.length > 0);
	const current = parts[parts.length - 1] ?? "";
	const rootCurrent = parts.length === 0;
	return (
		<div className="ag-crumbs" role="navigation" aria-label="Путь">
			<button type="button" className={`ag-crumb${rootCurrent ? " ag-crumb--current" : ""}`} onClick={() => onJump("/")} aria-label="Корень">
				/
			</button>
			{parts.length > 1 && (
				<button type="button" className="ag-crumb" onClick={() => onJump(parentPath(path))} aria-label="На уровень выше">
					…
				</button>
			)}
			{!rootCurrent && (
				<>
					<span className="ag-crumb-sep">/</span>
					<span className="ag-crumb ag-crumb--current" aria-current="location">
						{current}
					</span>
				</>
			)}
		</div>
	);
}

/** Шит-пикер папок для формы «Новый агент»: листает каталоги через существующий
 * listProjectFiles (type=dir), крошки + «на уровень вверх», подтверждение —
 * «Выбрать эту папку» → onPick(path), валидация и ошибка — в форме. */
function FolderPickerSheet(props: {
	initialPath: string;
	suggestions: readonly string[];
	onPick: (path: string) => void;
	onClose: () => void;
}): ReactNode {
	const { initialPath, suggestions, onPick, onClose } = props;
	const [path, setPath] = useState(initialPath);
	const [dirs, setDirs] = useState<ProjectFileEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sheetRef = useRef<HTMLDivElement | null>(null);

	const load = useCallback(async (dir: string) => {
		setError(null);
		setDirs(null);
		try {
			const data = await listProjectFiles(dir);
			// Папка существует ⇔ она листится без ошибки; оставляем только dir.
			setDirs(data.entries.filter(e => e.type === "dir").sort((a, b) => a.name.localeCompare(b.name, "ru")));
			setPath(dir);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load(initialPath);
	}, [load, initialPath]);

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

	const join = (name: string): string => `${path === "/" ? "" : path}/${name}`;

	return (
		<>
			<div className="pk-sheet-backdrop" onClick={onClose} />
			<div className="pk-sheet ag-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="fp-title" ref={sheetRef} tabIndex={-1}>
				<div className="pk-sheet-handle" />
				<div className="pk-sheet-title" id="fp-title">
					Выбрать папку
				</div>
				<PickerBreadcrumbs path={path} onJump={target => void load(target)} />
				{error != null && <div className="pk-form-error" role="alert">{error}</div>}
				<div className="ag-picker-list">
					{dirs === null && error == null && (
						<div className="ag-picker-state">
							<span className="pk-spinner" aria-label="Загрузка…" />
						</div>
					)}
					{dirs !== null && path !== "/" && (
						<button type="button" className="ag-picker-row" onClick={() => void load(parentPath(path))}>
							<ArrowLeft size={16} className="ag-picker-icon ag-picker-icon--up" />
							<span className="ag-picker-name">…</span>
						</button>
					)}
					{dirs !== null &&
						dirs.map(d => {
							const full = join(d.name);
							const known = suggestions.includes(full);
							return (
								<button key={d.name} type="button" className="ag-picker-row" onClick={() => void load(full)}>
									<Folder size={16} className="ag-picker-icon ag-picker-icon--dir" />
									<span className="ag-picker-name">{d.name}</span>
									{known && <span className="ag-picker-badge">агент</span>}
								</button>
							);
						})}
					{dirs !== null && dirs.length === 0 && path === "/" && (
						<div className="ag-picker-state">Папок нет</div>
					)}
				</div>
				<button type="button" className="pk-sheet-submit" onClick={() => onPick(path)}>
					Выбрать эту папку
				</button>
			</div>
		</>
	);
}

const MODEL_KEY = "ompPocket.lastModel";

/** Последняя выбранная модель — как дефолт для следующего «Нового агента». */
function storedModel(): string {
	try {
		return window.localStorage.getItem(MODEL_KEY) ?? "";
	} catch {
		return "";
	}
}

function rememberModel(selector: string): void {
	try {
		if (selector === "") window.localStorage.removeItem(MODEL_KEY);
		else window.localStorage.setItem(MODEL_KEY, selector);
	} catch {
		// приватный режим — выбор живёт только в этой сессии
	}
}

function NewAgentSheet(props: {
	suggestions: readonly string[];
	onClose: () => void;
	onCreated: () => void;
	onToast: (text: string) => void;
}): ReactNode {
	const { suggestions, onClose, onCreated, onToast } = props;
	const [cwd, setCwd] = useState(suggestions[0] ?? "");
	const [model, setModel] = useState(storedModel);
	const [models, setModels] = useState<readonly ModelOption[] | null>(null);
	const [label, setLabel] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const sheetRef = useRef<HTMLDivElement | null>(null);

	// Каталог моделей грузим один раз на открытие шита: без него кнопка ведёт
	// в пустой лист, но создать агента с моделью по умолчанию можно и так.
	useEffect(() => {
		let alive = true;
		fetchModels()
			.then(list => {
				if (alive) setModels(list);
			})
			.catch(() => {
				if (alive) setModels([]);
			});
		return () => {
			alive = false;
		};
	}, []);

	// Подтверждение пикера: папка существует ⇔ листится без ошибки.
	const pickFolder = useCallback(
		async (path: string) => {
			setError(null);
			try {
				await listProjectFiles(path);
				setCwd(path);
				setPickerOpen(false);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setPickerOpen(false);
			}
		},
		[],
	);

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
					<div className="ag-cwd-row">
						<input
							id="na-cwd"
							className="pk-field-input"
							value={cwd}
							placeholder="/home/user/project"
							spellCheck={false}
							onChange={e => setCwd(e.target.value)}
						/>
						<button type="button" className="ag-pick-btn" onClick={() => setPickerOpen(true)}>
							<Folder size={16} />
							Выбрать папку
						</button>
					</div>
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
					<div className="pk-field-label" id="na-model-label">
						Модель
					</div>
					<button
						type="button"
						className="ag-pick-btn ag-model-btn"
						aria-labelledby="na-model-label"
						aria-haspopup="dialog"
						onClick={() => setModelPickerOpen(true)}
					>
						{model === "" ? "По умолчанию (настройки omp)" : model}
					</button>
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
			{pickerOpen && (
				<FolderPickerSheet
					initialPath={cwd.trim() || suggestions[0] || "/"}
					suggestions={suggestions}
					onPick={path => void pickFolder(path)}
					onClose={() => setPickerOpen(false)}
				/>
			)}
			<ModelPickerSheet
				open={modelPickerOpen}
				title="Модель агента"
				models={models ?? []}
				current={model === "" ? null : model}
				allowDefault
				defaultLabel="По умолчанию (настройки omp)"
				note={models === null ? "Загружаю каталог моделей…" : models.length === 0 ? "Каталог моделей недоступен — агент стартует на модели по умолчанию." : null}
				onPick={selector => {
					const next = selector ?? "";
					setModel(next);
					rememberModel(next);
					setModelPickerOpen(false);
				}}
				onClose={() => setModelPickerOpen(false)}
			/>
		</>
	);
}

/** Шит мёртвой сессии: join невозможен, предлагаем resume через шлюз. */
function DeadSessionSheet(props: {
	host: HostInfo;
	onClose: () => void;
	onResumed: () => void;
}): ReactNode {
	const { host, onClose, onResumed } = props;
	const [resuming, setResuming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sheetRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		sheetRef.current?.focus();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape" && !resuming) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			prev?.focus();
		};
	}, [onClose, resuming]);

	const resume = useCallback(async () => {
		if (resuming) return;
		if (host.sessionFile == null) {
			setError("Файл сессии не найден — возобновление невозможно.");
			return;
		}
		setResuming(true);
		setError(null);
		const result = await resumeAgentHost(host.cwd, host.sessionFile);
		if (result.ok) {
			onResumed();
		} else {
			setError(result.error);
			setResuming(false);
		}
	}, [host.cwd, host.sessionFile, onResumed, resuming]);

	return (
		<>
			<div className="pk-sheet-backdrop" onClick={resuming ? undefined : onClose} />
			<div className="pk-sheet ag-dead-sheet" role="dialog" aria-modal="true" aria-labelledby="ds-title" ref={sheetRef} tabIndex={-1}>
				<div className="pk-sheet-handle" />
				<div className="pk-sheet-title" id="ds-title">
					Сессия завершена
				</div>
				<div className="ag-dead-text">Агент этой сессии не запущен.</div>
				{error != null && (
					<div className="pk-form-error ag-dead-error" role="alert">
						{error}
					</div>
				)}
				<div className="ag-dead-actions">
					<button type="button" className="pk-btn pk-btn--primary ag-dead-resume" disabled={resuming} onClick={() => void resume()}>
						{resuming ? <span className="pk-spinner" aria-label="Возобновление…" /> : "Возобновить"}
					</button>
					<button type="button" className="pk-btn pk-btn--ghost ag-dead-close" disabled={resuming} onClick={onClose}>
						Закрыть
					</button>
				</div>
			</div>
		</>
	);
}

export function AgentsScreen(props: {
	hosts: HostInfo[] | null;
	error: string | null;
	filterCwd: string | null;
	/** instanceId карточки, которая сейчас открывается (mintLink + коннект). */
	openingId?: string | null;
	onClearFilter: () => void;
	onOpen: (host: HostInfo) => void;
	onRefresh?: () => void;
}): ReactNode {
	const { hosts, error, filterCwd, openingId = null, onClearFilter, onOpen, onRefresh } = props;
	const [sheetOpen, setSheetOpen] = useState(false);
	const [deadHost, setDeadHost] = useState<HostInfo | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const board = useSuperBoardOnce();
	const [query, setQuery] = useState("");
	const [pins, setPins] = useState<readonly string[]>(() => pinnedSessions());
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => sectionCollapsedPrefs());

	const togglePin = useCallback((sessionId: string) => setPins(togglePinned(sessionId)), []);
	const toggleSection = useCallback((id: SectionId) => {
		const next = !(collapsed[id] ?? SECTION_COLLAPSED_DEFAULT.includes(id));
		setCollapsed(setSectionCollapsed(id, next));
	}, [collapsed]);

	// Мёртвая карточка не открывает чат: вместо join — шит с resume.
	const openHost = useCallback(
		(host: HostInfo) => {
			if (host.alive === false) setDeadHost(host);
			else onOpen(host);
		},
		[onOpen],
	);

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
		const inFilter = filterCwd ? shown.filter(h => h.cwd === filterCwd) : shown;
		const q = query.trim().toLowerCase();
		const opened = openedTimes();
		// Палитра строится по всем агентам, а не по отфильтрованным: фильтр по
		// проекту не должен перекрашивать карточки.
		const hues = projectHues(shown);
		const rows = inFilter.map(h => agentRow(h, board, opened, hues));
		const matched = q === "" ? rows : rows.filter(r => r.haystack.includes(q));

		const bySection = new Map<SectionId, AgentRow[]>();
		for (const id of SECTION_ORDER) bySection.set(id, []);
		// Закреплённый агент показывается один раз — в своей секции наверху,
		// и держит там ручной порядок (последний закреплённый первым).
		bySection.set(
			"pins",
			pins.map(id => matched.find(r => r.host.sessionId === id)).filter((r): r is AgentRow => r !== undefined),
		);
		for (const row of matched) {
			if (pins.includes(row.host.sessionId)) continue;
			bySection.get(sectionOf(row.host))?.push(row);
		}
		for (const [id, list] of bySection) {
			if (id === "pins") continue;
			list.sort((a, b) => b.recency - a.recency);
		}

		const waiting = matched.filter(r => r.host.inputRequired).length;
		const working = matched.filter(r => r.host.busy).length;

		body = (
			<div className="pk-list ag-list">
				{staleBanner}
				<div className="ag-head">
					<div className="ag-search">
						<Search size={16} className="ag-search-icon" aria-hidden="true" />
						<input
							className="ag-search-input"
							type="search"
							value={query}
							placeholder="Имя, проект, модель"
							aria-label="Поиск агентов"
							spellCheck={false}
							onChange={e => setQuery(e.target.value)}
						/>
						{query !== "" && (
							<button type="button" className="ag-search-clear" aria-label="Очистить поиск" onClick={() => setQuery("")}>
								<X size={14} />
							</button>
						)}
					</div>
					<div className="ag-summary">
						{matched.length} {pluralRu(matched.length, "агент", "агента", "агентов")}
						{working > 0 && ` · ${working} ${pluralRu(working, "работает", "работают", "работают")}`}
						{waiting > 0 && ` · ${waiting} ${pluralRu(waiting, "ждёт", "ждут", "ждут")} ответа`}
					</div>
					{filterCwd && (
						<button type="button" className="pk-filter" onClick={onClearFilter}>
							Проект: {shortenPath(filterCwd)}
							<X size={14} />
						</button>
					)}
				</div>
				{matched.length === 0 ? (
					<div className="pk-empty ag-empty-inline">
						<div className="pk-empty-title">{q === "" ? "Агентов нет" : "Ничего не найдено"}</div>
						<div className="pk-empty-text">
							{q === "" ? "Создай агента кнопкой «+» или выполни /collab в сессии OMP." : "Другой запрос или очисти поиск."}
						</div>
					</div>
				) : (
					SECTION_ORDER.map(id => (
						<AgentSection
							key={id}
							id={id}
							rows={bySection.get(id) ?? []}
							// Поиск разворачивает всё: свёрнутая секция с найденным — тупик.
							collapsed={q === "" && (collapsed[id] ?? SECTION_COLLAPSED_DEFAULT.includes(id))}
							openingId={openingId}
							pins={pins}
							onToggle={toggleSection}
							onOpen={openHost}
							onTogglePin={togglePin}
						/>
					))
				)}
			</div>
		);
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
			{deadHost != null && (
				<DeadSessionSheet
					host={deadHost}
					onClose={() => setDeadHost(null)}
					onResumed={() => {
						setDeadHost(null);
						onRefresh?.();
					}}
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
