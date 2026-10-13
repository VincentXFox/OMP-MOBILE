import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Folder, Settings, Activity } from "lucide-react";
import { AgentsScreen } from "./components/agents/AgentsScreen";
import { ActivityScreen } from "./components/activity/ActivityScreen";
import { ProjectsScreen } from "./components/projects/ProjectsScreen";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SessionScreen } from "./components/session/SessionScreen";
import type { HostInfo } from "./lib/gateway";
import { fetchHosts, GatewayError, mintLink } from "./lib/gateway";
import { GuestClient } from "./lib/client";
import "./components/shell/pocket.css";

type Screen = "agents" | "projects" | "activity" | "settings" | "session";

const SCREENS: readonly { id: Exclude<Screen, "session">; label: string }[] = [
	{ id: "agents", label: "Агенты" },
	{ id: "projects", label: "Проекты" },
	{ id: "activity", label: "Активность" },
	{ id: "settings", label: "Настройки" },
];

const SCREEN_TITLE: Record<Screen, string> = {
	agents: "Агенты",
	projects: "Проекты",
	activity: "Активность",
	settings: "Настройки",
	session: "Сессия",
};

function storedName(): string {
	try {
		return localStorage.getItem("ompPocket.name") || "guest";
	} catch {
		return "guest";
	}
}

function screenFromHash(): Screen {
	const hash = window.location.hash.replace(/^#\/?/, "");
	return hash === "projects" || hash === "activity" || hash === "settings" ? hash : "agents";
}

export function App(): ReactNode {
	const [screen, setScreen] = useState<Screen>(screenFromHash);
	const [hosts, setHosts] = useState<HostInfo[] | null>(null);
	const [hostsError, setHostsError] = useState<string | null>(null);
	const [filterCwd, setFilterCwd] = useState<string | null>(null);
	const [client, setClient] = useState<GuestClient | null>(null);
	const clientRef = useRef<GuestClient | null>(null);
	const [opening, setOpening] = useState(false);

	// hash ⇄ screen sync
	useEffect(() => {
		const onHash = (): void => setScreen(screenFromHash());
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	const goto = useCallback((next: Screen): void => {
		setScreen(next);
		if (next === "session") return; // session is transient, not addressable
		window.location.hash = `#/${next}`;
	}, []);

	// poll hosts every 5s
	useEffect(() => {
		let alive = true;
		const poll = async (): Promise<void> => {
			try {
				const list = await fetchHosts();
				if (!alive) return;
				setHosts(list);
				setHostsError(null);
			} catch (err) {
				if (!alive) return;
				const status = err instanceof GatewayError ? err.status : 0;
				setHostsError(
					status === 401
						? "Шлюз вернул 401 — открой Настройки и введи токен."
						: `Шлюз недоступен: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 5000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, []);

	const openHost = useCallback(
		async (host: HostInfo): Promise<void> => {
			if (opening) return;
			setOpening(true);
			try {
				const link = await mintLink(host.instanceId, false);
				const next = new GuestClient(link, storedName());
				next.connect();
				clientRef.current?.close();
				clientRef.current = next;
				setClient(next);
				goto("session");
			} catch (err) {
				const status = err instanceof GatewayError ? err.status : 0;
				setHostsError(
					status === 409
						? "Сессия обновилась (stale generation) — попробуй ещё раз."
						: `Не удалось открыть сессию: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				setOpening(false);
			}
		},
		[goto, opening],
	);

	const leaveSession = useCallback((): void => {
		clientRef.current?.close();
		clientRef.current = null;
		setClient(null);
		goto("agents");
	}, [goto]);

	const body = useMemo<ReactNode>(() => {
		switch (screen) {
			case "session":
				if (client) return <SessionScreen client={client} onLeave={leaveSession} />;
				return <AgentsScreen hosts={hosts} error={hostsError} filterCwd={filterCwd} onClearFilter={() => setFilterCwd(null)} onOpen={h => void openHost(h)} />;
			case "projects":
				return (
					<ProjectsScreen
						hosts={hosts}
						error={hostsError}
						onOpen={cwd => {
							setFilterCwd(cwd);
							goto("agents");
						}}
					/>
				);
			case "activity":
				return <ActivityScreen client={client} onOpenSession={() => goto("session")} hosts={hosts} />;
			case "settings":
				return <SettingsScreen />;
			default:
				return <AgentsScreen hosts={hosts} error={hostsError} filterCwd={filterCwd} onClearFilter={() => setFilterCwd(null)} onOpen={h => void openHost(h)} />;
		}
	}, [screen, client, hosts, hostsError, filterCwd, openHost, leaveSession, goto]);

	const navIcon: Record<Exclude<Screen, "session">, ReactNode> = {
		agents: <Bot size={22} />,
		projects: <Folder size={22} />,
		activity: <Activity size={22} />,
		settings: <Settings size={22} />,
	};

	return (
		<div className="pk-app">
			{screen !== "session" && (
				<header className="pk-header">
					<span className="pk-header-title">{SCREEN_TITLE[screen]}</span>
				</header>
			)}
			<main className="pk-main">{body}</main>
			{screen !== "session" && (
				<nav className="pk-nav">
					{SCREENS.map(s => (
						<button
							key={s.id}
							className={`pk-nav-item${screen === s.id ? " pk-nav-item--on" : ""}`}
							onClick={() => goto(s.id)}
						>
							{navIcon[s.id]}
							{s.label}
						</button>
					))}
				</nav>
			)}
		</div>
	);
}
