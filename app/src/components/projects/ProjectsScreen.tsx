import { useMemo, type ReactNode } from "react";
import { basename } from "../../lib/format";
import type { HostInfo } from "../../lib/gateway";
import { hostStatus } from "../agents/AgentsScreen";

export interface ProjectGroup {
	cwd: string;
	hosts: HostInfo[];
}

export function groupByCwd(hosts: HostInfo[]): ProjectGroup[] {
	const map = new Map<string, HostInfo[]>();
	for (const host of hosts) {
		const list = map.get(host.cwd);
		if (list) list.push(host);
		else map.set(host.cwd, [host]);
	}
	return [...map.entries()].map(([cwd, groupHosts]) => ({ cwd, hosts: groupHosts }));
}

export function ProjectsScreen(props: {
	hosts: HostInfo[] | null;
	error: string | null;
	onOpen: (cwd: string) => void;
}): ReactNode {
	const { hosts, error, onOpen } = props;
	const groups = useMemo(() => (hosts ? groupByCwd(hosts) : []), [hosts]);

	if (error != null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить список</div>
				<div className="pk-empty-text">{error}</div>
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
	if (groups.length === 0) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Проектов нет</div>
				<div className="pk-empty-text">Открой агента с collab — его рабочая папка появится здесь.</div>
			</div>
		);
	}
	return (
		<div className="pk-list">
			{groups.map(g => (
				<button key={g.cwd} className="pk-card pk-project" onClick={() => onOpen(g.cwd)}>
					<div className="pk-host-head">
						<span className="pk-host-title">{basename(g.cwd)}</span>
						<span className="pk-pill">{g.hosts.length} агент{g.hosts.length === 1 ? "" : "ов"}</span>
					</div>
					<div className="pk-chips">
						{g.hosts.map(h => {
							const status = hostStatus(h);
							return (
								<span key={h.instanceId} className="pk-chip">
									<span className={`pk-dot pk-dot--${status.tone}${status.pulse ? " pk-dot--pulse" : ""}`} />
									{h.sessionName || h.pid}
								</span>
							);
						})}
					</div>
				</button>
			))}
		</div>
	);
}
