import { FolderGit2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { basename, pluralRu } from "../../lib/format";
import { WorkflowsSection } from "./WorkflowsSection";
import type { HostInfo } from "../../lib/gateway";
import { hostStatus } from "../agents/AgentsScreen";
import { SessionsScreen } from "../sessions/SessionsScreen";
import "./projects.css";

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
	return Array.from(map.entries()).map(([cwd, groupHosts]) => ({ cwd, hosts: groupHosts }));
}

/** Агрегат живости проекта: работает → на связи → нет связи. */
function projectLiveness(hosts: HostInfo[]): { tone: "accent" | "success" | "muted"; label: string; pulse: boolean } {
	if (hosts.some(h => h.busy && h.relayConnected)) return { tone: "accent", label: "работает", pulse: true };
	if (hosts.some(h => h.relayConnected)) return { tone: "success", label: "на связи", pulse: false };
	return { tone: "muted", label: "нет связи", pulse: false };
}

function ProjectCard(props: { group: ProjectGroup; onOpen: (cwd: string) => void }): ReactNode {
	const { group, onOpen } = props;
	const live = projectLiveness(group.hosts);
	return (
		<button key={group.cwd} type="button" className="pj-card" onClick={() => onOpen(group.cwd)}>
			<div className="pj-card-head">
				<span className="pj-card-icon">
					<FolderGit2 size={16} />
				</span>
				<span className="pj-card-title">{basename(group.cwd)}</span>
				<span className="pj-live">
					<span className={`pj-dot pj-dot--${live.tone}${live.pulse ? " pj-dot--pulse" : ""}`} />
					{live.label}
				</span>
			</div>
			<div className="pj-card-path">{group.cwd}</div>
			<div className="pj-card-count">
				{group.hosts.length} {pluralRu(group.hosts.length, "агент", "агента", "агентов")}
			</div>
		</button>
	);
}

function ProjectsSkeleton(): ReactNode {
	return (
		<div className="pj-grid" aria-hidden="true">
			{[0, 1, 2].map(i => (
				<div key={i} className="pj-card pj-card--ghost">
					<span className="pk-skeleton pj-sk pj-sk--row" />
					<span className="pk-skeleton pj-sk pj-sk--path" />
					<span className="pk-skeleton pj-sk pj-sk--row" />
				</div>
			))}
		</div>
	);
}

export function ProjectsScreen(props: {
	hosts: HostInfo[] | null;
	error: string | null;
	onOpen: (cwd: string) => void;
	onOpenInstance: (instanceId: string) => void;
}): ReactNode {
	const { hosts, error, onOpen, onOpenInstance } = props;
	const [tab, setTab] = useState<"projects" | "sessions">("projects");
	const groups = useMemo(() => (hosts ? groupByCwd(hosts) : []), [hosts]);

	const tabs = (
		<div className="pk-segmented pj-tabs" role="tablist" aria-label="Проекты и сессии">
			<button
				type="button"
				role="tab"
				aria-selected={tab === "projects"}
				className={`pk-segment${tab === "projects" ? " pk-segment--on" : ""}`}
				onClick={() => setTab("projects")}
			>
				Проекты
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={tab === "sessions"}
				className={`pk-segment${tab === "sessions" ? " pk-segment--on" : ""}`}
				onClick={() => setTab("sessions")}
			>
				Сессии
			</button>
		</div>
	);

	if (tab === "sessions") {
		return (
			<div className="pj-screen">
				{tabs}
				<SessionsScreen onOpenInstance={onOpenInstance} />
			</div>
		);
	}

	if (error != null) {
		return (
			<div className="pj-screen">
				{tabs}
				<div className="pk-empty">
					<div className="pk-empty-title">Не удалось получить список</div>
					<div className="pk-empty-text">{error}</div>
				</div>
			</div>
		);
	}
	if (hosts == null) {
		return (
			<div className="pj-screen">
				{tabs}
				<ProjectsSkeleton />
			</div>
		);
	}
	if (groups.length === 0) {
		return (
			<div className="pj-screen">
				{tabs}
				<div className="pk-empty">
					<div className="pk-empty-title">Проектов нет</div>
					<div className="pk-empty-text">Открой агента с collab — его рабочая папка появится здесь.</div>
				</div>
			</div>
		);
	}
	return (
		<div className="pj-screen">
			{tabs}
			<WorkflowsSection />
			<div className="pj-grid">
				{groups.map(g => (
					<ProjectCard key={g.cwd} group={g} onOpen={onOpen} />
				))}
			</div>
		</div>
	);
}
