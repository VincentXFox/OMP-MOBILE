import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
	Archive,
	ArrowRight,
	CheckCircle2,
	CircleAlert,
	Cpu,
	Download,
	LoaderCircle,
	MonitorSmartphone,
	RefreshCw,
	RotateCcw,
	Server,
	X,
	XCircle,
} from "lucide-react";
import {
	applyUpdate,
	createUpdateBackup,
	fetchUpdateJob,
	fetchUpdateStatus,
	isComponentId,
	GatewayError,
	rollbackUpdate,
	UpdateBusyError,
	type BusyAgent,
	type UpdateComponent,
	type UpdateComponentId,
	type UpdateJob,
	type UpdateStatus,
} from "../../lib/gateway";
import { basename, shortenPath } from "../../lib/format";
import { ConfirmSheet } from "../shell/ConfirmSheet";
import "./updates.css";

const CHANGELOG_URL = "https://github.com/can1357/oh-my-pi/releases";

const COMPONENT_ICONS: Record<UpdateComponentId, ReactNode> = {
	omp: <Cpu size={20} />,
	gateway: <Server size={20} />,
	frontend: <MonitorSmartphone size={20} />,
};

const COMPONENT_TITLES: Record<UpdateComponentId, string> = {
	omp: "OMP",
	gateway: "Gateway",
	frontend: "Frontend",
};

interface BusyDialog {
	agents: BusyAgent[];
	/** Components still to apply once the user confirms, starting with the blocked one. */
	resume: UpdateComponentId[];
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

const TIME_FMT = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const DATE_FMT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

/** Relative «Проверено: …» label; `null` — not shown at all. */
function lastCheckText(ts: number | null): string | null {
	if (ts === null || !Number.isFinite(ts)) return null;
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return null;
	const diff = Date.now() - date.getTime();
	if (diff < 60_000) return "только что";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
	const now = new Date();
	const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const time = TIME_FMT.format(date);
	if (day === startToday) return `${Math.floor(diff / 3_600_000)} ч назад`;
	if (day === startToday - 86_400_000) return `вчера, ${time}`;
	if (date.getFullYear() === now.getFullYear()) return `${DATE_FMT.format(date)}, ${time}`;
	return `${DATE_FMT.format(date)} ${date.getFullYear()}, ${time}`;
}

function CompatChip(props: { component: UpdateComponent }): ReactNode {
	const { component } = props;
	const { status, detail } = component.compatibility;
	if (status === "ok") return <span className="upd-chip upd-chip--ok">совместимо</span>;
	if (status === "warn") return <span className="upd-chip upd-chip--warn">{detail}</span>;
	return <span className="upd-chip">{detail.trim().length > 0 ? detail : "неизвестно"}</span>;
}

function ComponentCard(props: {
	component: UpdateComponent;
	frozen: boolean;
	rollingBack: boolean;
	onApply: (id: UpdateComponentId) => void;
	onRollback: (id: UpdateComponentId) => void;
}): ReactNode {
	const { component, frozen, rollingBack, onApply, onRollback } = props;
	return (
		<div className="pk-card upd-card">
			<div className="upd-card-head">
				<span className="upd-card-icon">{COMPONENT_ICONS[component.id]}</span>
				<span className="upd-card-title">{component.title}</span>
				<CompatChip component={component} />
			</div>
			<div className={`upd-version${component.updateAvailable ? " upd-version--update" : ""}`}>
				<span>{component.current}</span>
				<ArrowRight size={14} />
				<span className="upd-version-next">{component.updateAvailable ? component.latest : "актуально"}</span>
			</div>
			<div className="upd-method">{component.installMethod}</div>
			{component.notes.length > 0 && (
				<ul className="upd-notes">
					{component.notes.map((note, i) => (
						<li key={`${i}-${note}`}>{note}</li>
					))}
				</ul>
			)}
			<div className="upd-card-actions">
				<button className="pk-btn" disabled={frozen} onClick={() => onApply(component.id)}>
					Обновить
				</button>
				<button
					className="pk-btn upd-btn--secondary"
					disabled={frozen || rollingBack}
					onClick={() => onRollback(component.id)}
				>
					<RotateCcw size={14} />
					Откатить
				</button>
				{component.id === "omp" && (
					<a className="upd-link" href={CHANGELOG_URL} target="_blank" rel="noopener noreferrer">
						Изменения
					</a>
				)}
			</div>
		</div>
	);
}

function JobCard(props: { job: UpdateJob; rollingBack: boolean; onRollback: (id: UpdateComponentId) => void }): ReactNode {
	const { job, rollingBack, onRollback } = props;
	const failed = job.error != null;
	const rollbackId = isComponentId(job.id) ? job.id : null;
	const title = isComponentId(job.id) ? COMPONENT_TITLES[job.id] : "Обновление";
	return (
		<div className="pk-card upd-job">
			<div className="upd-job-head">
				<span className="upd-job-title">{title}</span>
				{job.running ? (
					<span className="upd-job-status upd-job-status--run">
						<LoaderCircle size={14} className="upd-spin" />
						Выполняется…
					</span>
				) : failed ? (
					<span className="upd-job-status upd-job-status--fail">
						<XCircle size={14} />
						Ошибка
					</span>
				) : (
					<span className="upd-job-status upd-job-status--ok">
						<CheckCircle2 size={14} />
						Готово
					</span>
				)}
			</div>
			{job.steps.length > 0 && (
				<ul className="upd-steps">
					{job.steps.map((step, i) => (
						<li key={`${i}-${step.label}`} className={`upd-step upd-step--${step.status}`}>
							<span className="upd-step-icon">
								{step.status === "run" && <LoaderCircle size={14} className="upd-spin" />}
								{step.status === "ok" && <CheckCircle2 size={14} />}
								{step.status === "fail" && <XCircle size={14} />}
							</span>
							<span className="upd-step-body">
								<span className="upd-step-label">{step.label}</span>
								{step.detail != null && step.detail.length > 0 && (
									<span className="upd-step-detail">{step.detail}</span>
								)}
							</span>
						</li>
					))}
				</ul>
			)}
			{failed && rollbackId != null && (
				<div className="upd-error">
					<span className="upd-error-text">
						<CircleAlert size={16} />
						{job.error}
					</span>
					<button className="pk-btn upd-btn--secondary" disabled={rollingBack} onClick={() => onRollback(rollbackId)}>
						<RotateCcw size={14} />
						Откатить
					</button>
				</div>
			)}
		</div>
	);
}

export function UpdatesScreen(): ReactNode {
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [job, setJob] = useState<UpdateJob | null>(null);
	const [busyDialog, setBusyDialog] = useState<BusyDialog | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [backupDir, setBackupDir] = useState<string | null>(null);
	const [rollingBack, setRollingBack] = useState(false);
	const [confirm, setConfirm] = useState<
		| { kind: "apply"; ids: UpdateComponentId[] }
		| { kind: "rollback"; id: UpdateComponentId }
		| null
	>(null);

	const aliveRef = useRef(true);
	const toastTimer = useRef<number | null>(null);

	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
			if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
		};
	}, []);

	const showToast = useCallback((message: string): void => {
		setToast(message);
		if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
		toastTimer.current = window.setTimeout(() => setToast(null), 5000);
	}, []);

	const refreshStatus = useCallback(async (): Promise<void> => {
		setChecking(true);
		try {
			const next = await fetchUpdateStatus();
			if (!aliveRef.current) return;
			setStatus(next);
			setStatusError(null);
		} catch (err) {
			if (!aliveRef.current) return;
			const status = err instanceof GatewayError ? err.status : 0;
			setStatusError(
				status === 401
					? "Шлюз вернул 401 — открой Настройки и введи токен."
					: `Gateway недоступен: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			if (aliveRef.current) setChecking(false);
		}
	}, []);

	/** Polls /api/update/job until the active job finishes, then refreshes the status. */
	const trackJob = useCallback(async (): Promise<void> => {
		for (;;) {
			if (!aliveRef.current) return;
			let next: UpdateJob;
			try {
				next = await fetchUpdateJob();
			} catch {
				await sleep(1500); // the gateway may restart mid-apply — keep tracking
				continue;
			}
			if (!aliveRef.current) return;
			setJob(next);
			if (!next.running) break;
			await sleep(1500);
		}
		void refreshStatus();
	}, [refreshStatus]);

	// auto-load on mount + pick up a job that is already running (e.g. started before reload)
	useEffect(() => {
		void refreshStatus();
		void (async () => {
			try {
				const current = await fetchUpdateJob();
				if (!aliveRef.current || !current.running) return;
				setJob(current);
				await trackJob();
			} catch {
				// gateway offline — surfaced by the status card
			}
		})();
	}, [refreshStatus, trackJob]);

	const runQueue = useCallback(
		async (ids: UpdateComponentId[], confirmBusy: boolean): Promise<void> => {
			for (let index = 0; index < ids.length; index += 1) {
				const id = ids[index];
				if (id === undefined) continue;
				// a single job may be active — wait for the previous one to finish
				try {
					const current = await fetchUpdateJob();
					if (current.running) {
						setJob(current);
						await trackJob();
					}
				} catch {
					// job status unavailable — the server will reject a second apply anyway
				}
				// backup right before each apply; without it — no update
				let dir: string;
				try {
					dir = await createUpdateBackup();
				} catch (err) {
					showToast(`Бэкап не удался — «${COMPONENT_TITLES[id]}» не обновлено: ${err instanceof Error ? err.message : String(err)}`);
					return;
				}
				if (!aliveRef.current) return;
				setBackupDir(dir);
				try {
					await applyUpdate(id, confirmBusy);
				} catch (err) {
					if (!aliveRef.current) return;
					if (err instanceof UpdateBusyError) {
						setBusyDialog({ agents: err.agents, resume: ids.slice(index) });
						return;
					}
					showToast(
						`Не удалось запустить обновление «${COMPONENT_TITLES[id]}»: ${err instanceof Error ? err.message : String(err)}`,
					);
					return;
				}
				setJob({ running: true, id, steps: [], error: null, startedAt: Date.now() });
				await trackJob();
			}
			void refreshStatus();
		},
		[refreshStatus, showToast, trackJob],
	);

	const applyOne = useCallback(
		(id: UpdateComponentId): void => {
			setConfirm({ kind: "apply", ids: [id] });
		},
		[],
	);

	const availableCount = useMemo(() => {
		if (!status) return 0;
		return status.components.filter(c => c.updateAvailable).length;
	}, [status]);

	const updateAll = useCallback((): void => {
		if (!status || availableCount === 0) return;
		const targets = status.components.filter(c => c.updateAvailable).map(c => c.id);
		setConfirm({ kind: "apply", ids: targets });
	}, [status, availableCount]);

	const manualBackup = useCallback(async (): Promise<void> => {
		try {
			const dir = await createUpdateBackup();
			if (!aliveRef.current) return;
			setBackupDir(dir);
			showToast("Резервная копия создана");
		} catch (err) {
			if (!aliveRef.current) return;
			showToast(`Бэкап не удался: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, [showToast]);

	const rollback = useCallback(
		async (id: UpdateComponentId): Promise<void> => {
			setRollingBack(true);
			try {
				await rollbackUpdate(id);
				if (!aliveRef.current) return;
				showToast(`Откат «${COMPONENT_TITLES[id]}» запущен`);
				try {
					const current = await fetchUpdateJob();
					if (!aliveRef.current) return;
					setJob(current);
					if (current.running) {
						await trackJob();
						return;
					}
				} catch {
					// no job data — fall through to a plain status refresh
				}
				void refreshStatus();
			} catch (err) {
				if (!aliveRef.current) return;
				if (err instanceof GatewayError && err.status === 404) showToast("Нет предыдущей версии — откатить некуда");
				else showToast(`Откат не удался: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				if (aliveRef.current) setRollingBack(false);
			}
		},
		[refreshStatus, showToast, trackJob],
	);

	const frozen = job?.running === true || rollingBack;

	if (statusError != null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Gateway недоступен</div>
				<div className="pk-empty-text">{statusError}</div>
				<div className="pk-empty-text">Проверьте адрес шлюза и токен в Настройках.</div>
				<button className="pk-btn" disabled={checking} onClick={() => void refreshStatus()}>
					{checking ? "Проверяю…" : "Проверить"}
				</button>
			</div>
		);
	}
	if (status == null) {
		return (
			<div className="pk-list upd-list" aria-busy="true">
				{[0, 1, 2].map(i => (
					<div key={i} className="pk-card upd-card upd-skel" aria-hidden="true">
						<span className="pk-skeleton upd-skel-row" />
						<span className="pk-skeleton upd-skel-line" />
						<span className="pk-skeleton upd-skel-row upd-skel-row--short" />
					</div>
				))}
			</div>
		);
	}

	const showJob = job != null && (job.running || job.error != null || job.steps.length > 0);
	const lastCheck = lastCheckText(status.lastCheck);

	return (
		<div className="upd-wrap">
			<div className="upd-toolbar">
				<button className="pk-btn" disabled={frozen || checking || availableCount === 0} onClick={updateAll}>
					<Download size={14} />
					Обновить всё{availableCount > 0 ? ` (${availableCount})` : ""}
				</button>
				<button className="pk-btn upd-btn--secondary" disabled={frozen || checking} onClick={() => void refreshStatus()}>
					<RefreshCw size={14} className={checking ? "upd-spin" : undefined} />
					{checking ? "Проверяю…" : "Проверить"}
				</button>
				<button className="pk-btn upd-btn--secondary" disabled={frozen} onClick={() => void manualBackup()}>
					<Archive size={14} />
					Резервная копия
				</button>
			</div>
			{(lastCheck != null || !status.remoteConfigured) && (
				<div className="upd-meta">
					{lastCheck != null && <span>Проверено: {lastCheck}</span>}
					{!status.remoteConfigured && <span className="upd-meta-warn">git remote не настроен — Gateway/Frontend не обновить</span>}
				</div>
			)}
			{backupDir != null && <div className="upd-backup">бэкап: ок · {shortenPath(backupDir)}</div>}
			{showJob && job != null && <JobCard job={job} rollingBack={rollingBack} onRollback={id => setConfirm({ kind: "rollback", id })} />}
			<div className="pk-list upd-list">
				{status.components.map(component => (
					<ComponentCard
						key={component.id}
						component={component}
						frozen={frozen}
						rollingBack={rollingBack}
						onApply={applyOne}
						onRollback={id => setConfirm({ kind: "rollback", id })}
					/>
				))}
				{status.components.length === 0 && (
					<div className="pk-empty">
						<div className="pk-empty-text">Компоненты не найдены — обнови Gateway до версии с центром обновлений.</div>
					</div>
				)}
			</div>
			{confirm?.kind === "apply" && (
				<ConfirmSheet
					open
					title={confirm.ids.length > 1 ? "Обновить всё?" : `Обновить «${COMPONENT_TITLES[confirm.ids[0]]}»?`}
					body="Сначала будет создана резервная копия, затем компонент обновится. Работающие агенты могут быть прерваны."
					command={confirm.ids.map(id => `omp update ${id}`).join("\n")}
					confirmLabel="Обновить"
					danger
					onConfirm={() => {
						const ids = confirm.ids;
						setConfirm(null);
						void runQueue(ids, false);
					}}
					onCancel={() => setConfirm(null)}
				/>
			)}
			{confirm?.kind === "rollback" && (
				<ConfirmSheet
					open
					title={`Откатить «${COMPONENT_TITLES[confirm.id]}»?`}
					body="Компонент вернётся к предыдущей версии. Текущая установка будет заменена."
					command={`omp rollback ${confirm.id}`}
					confirmLabel="Откатить"
					danger
					onConfirm={() => {
						const id = confirm.id;
						setConfirm(null);
						void rollback(id);
					}}
					onCancel={() => setConfirm(null)}
				/>
			)}
			{busyDialog && (
				<div className="upd-overlay" role="dialog" aria-modal="true" aria-label="Работают агенты">
					<div className="upd-sheet">
						<div className="upd-sheet-title">Работают агенты</div>
						{busyDialog.agents.length > 0 ? (
							<ul className="upd-agents">
								{busyDialog.agents.map((agent, i) => (
									<li key={`${i}-${agent.cwd}`} className="upd-agent">
										<span className="upd-agent-name">{agent.sessionName || basename(agent.cwd)}</span>
										<span className="upd-agent-cwd">{shortenPath(agent.cwd)}</span>
									</li>
								))}
							</ul>
						) : (
							<div className="upd-sheet-text">Агенты заняты — обновление может их прервать.</div>
						)}
						<div className="upd-sheet-question">Остановить и обновить?</div>
						<div className="upd-sheet-actions">
							<button className="pk-btn upd-btn--secondary" onClick={() => setBusyDialog(null)}>
								Нет
							</button>
							<button
								className="pk-btn pk-btn--danger"
								onClick={() => {
									const resume = busyDialog.resume;
									setBusyDialog(null);
									void runQueue(resume, true);
								}}
							>
								Обновить всё равно
							</button>
						</div>
					</div>
				</div>
			)}
			{toast != null && (
				<div className="pk-toast" role="status">
					<span>{toast}</span>
					<button type="button" className="pk-toast-x" aria-label="Скрыть" onClick={() => setToast(null)}>
						<X size={16} />
					</button>
				</div>
			)}
		</div>
	);
}
