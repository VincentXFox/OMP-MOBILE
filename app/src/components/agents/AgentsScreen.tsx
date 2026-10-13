import type { ReactNode } from "react";
import { basename } from "../../lib/format";
import type { HostInfo } from "../../lib/gateway";

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

export function HostCard(props: { host: HostInfo; onOpen: (host: HostInfo) => void }): ReactNode {
	const { host, onOpen } = props;
	const status = hostStatus(host);
	const dim = !host.relayConnected;
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
				{host.access === "view" && <span className="pk-lock">🔒 только просмотр</span>}
			</div>
		</button>
	);
}

export function AgentsScreen(props: {
	hosts: HostInfo[] | null;
	error: string | null;
	filterCwd: string | null;
	onClearFilter: () => void;
	onOpen: (host: HostInfo) => void;
}): ReactNode {
	const { hosts, error, filterCwd, onClearFilter, onOpen } = props;

	if (error != null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить список</div>
				<div className="pk-empty-text">{error}</div>
				<div className="pk-empty-text">Проверьте адрес шлюза и токен в Настройках.</div>
			</div>
		);
	}
	if (hosts == null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-text">Загрузка…</div>
			</div>
		);
	}
	const filtered = filterCwd ? hosts.filter(h => h.cwd === filterCwd) : hosts;
	if (filtered.length === 0) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Агентов нет</div>
				<div className="pk-empty-text">
					Включи collab.autoStart или выполни /collab в сессии OMP — агент появится здесь.
				</div>
			</div>
		);
	}
	return (
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
