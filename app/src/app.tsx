import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Folder, Settings, Activity, RefreshCw, Brain, History, Crown } from "lucide-react";
import { AgentsScreen } from "./components/agents/AgentsScreen";
import { ActivityScreen } from "./components/activity/ActivityScreen";
import { MemoryScreen } from "./components/memory/MemoryScreen";
import { ProjectsScreen } from "./components/projects/ProjectsScreen";
import { SessionsScreen } from "./components/sessions/SessionsScreen";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SessionScreen } from "./components/session/SessionScreen";
import { SuperScreen } from "./components/super/SuperScreen";
import { UpdatesScreen } from "./components/updates/UpdatesScreen";
import type { HostInfo } from "./lib/gateway";
import { fetchHosts, GatewayError, mintLink, setToken } from "./lib/gateway";
import { GuestClient } from "./lib/client";
import "./components/shell/pocket.css";

type Screen = "agents" | "super" | "projects" | "sessions" | "memory" | "activity" | "updates" | "settings" | "session";

const SCREENS: readonly { id: Exclude<Screen, "session">; label: string }[] = [
	{ id: "super", label: "Супер" },
	{ id: "agents", label: "Агенты" },
	{ id: "projects", label: "Проекты" },
	{ id: "sessions", label: "Сессии" },
	{ id: "memory", label: "Память" },
	{ id: "activity", label: "Активность" },
	{ id: "updates", label: "Обновления" },
	{ id: "settings", label: "Настройки" },
];

const SCREEN_TITLE: Record<Screen, string> = {
	agents: "Агенты",
	super: "Супер-агент",
	projects: "Проекты",
	sessions: "Сессии",
	memory: "Память",
	activity: "Активность",
	updates: "Обновления",
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

// Deep link "#token=..." provisions auth on first open (the fragment is never sent to the server),
// then routing takes over from "#/..." as usual.
function provisionTokenFromHash(): void {
	const hash = window.location.hash.replace(/^#/, "");
	if (!hash.startsWith("token=")) return;
	const token = new URLSearchParams(hash).get("token");
	if (token) {
		setToken(token);
		history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/agents`);
	}
}
provisionTokenFromHash();

function screenFromHash(): Screen {
	const hash = window.location.hash.replace(/^#\/?/, "");
	return hash === "super" || hash === "projects" || hash === "sessions" || hash === "memory" || hash === "activity" || hash === "updates" || hash === "settings" ? hash : "agents";
}

export function App(): ReactNode {
	const [screen, setScreen] = useState<Screen>(screenFromHash);
	const [hosts, setHosts] = useState<HostInfo[] | null>(null);
	const [hostsError, setHostsError] = useState<string | null>(null);
	const [filterCwd, setFilterCwd] = useState<string | null>(null);
	const [client, setClient] = useState<GuestClient | null>(null);
	const clientRef = useRef<GuestClient | null>(null);
	const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
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
				setActiveInstanceId(host.instanceId);
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
		setActiveInstanceId(null);
		goto("agents");
	}, [goto]);

	const refreshHosts = useCallback((): void => {
		void (async () => {
			try {
				setHosts(await fetchHosts());
				setHostsError(null);
			} catch {
				// polling effect reports errors; silent here
			}
		})();
	}, []);

	const openSuperSession = useCallback(
		(instanceId: string): void => {
			const host = hosts?.find(h => h.instanceId === instanceId);
			if (host) void openHost(host);
			else setHostsError("Сессия недоступна — агент не отвечает в collab-реестре.");
		},
		[hosts, openHost],
	);

	// Resume flow: fetch a fresh registry snapshot — the 5s poll state may be stale.
	const openInstance = useCallback(
		async (instanceId: string): Promise<void> => {
			try {
				const fresh = await fetchHosts();
				const host = fresh.find(h => h.instanceId === instanceId);
				if (host) {
					await openHost(host);
					return;
				}
				setHostsError("Сессия поднялась, но агент не появился в collab-реестре.");
			} catch (err) {
				setHostsError(err instanceof Error ? err.message : String(err));
			}
		},
		[openHost],
	);

	const activeHost = useMemo(
		() => hosts?.find(h => h.instanceId === activeInstanceId),
		[hosts, activeInstanceId],
	);

	const body = useMemo<ReactNode>(() => {
		switch (screen) {
			case "session":
				if (client) return <SessionScreen client={client} onLeave={leaveSession} host={activeHost} />;
				return <AgentsScreen hosts={hosts} error={hostsError} filterCwd={filterCwd} onClearFilter={() => setFilterCwd(null)} onOpen={h => void openHost(h)} onRefresh={refreshHosts} />;
			case "super":
				return <SuperScreen onOpenSession={openSuperSession} />;
			case "sessions":
				return <SessionsScreen onOpenInstance={id => void openInstance(id)} />;
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
			case "memory":
				return <MemoryScreen />;
			case "activity":
				return <ActivityScreen client={client} onOpenSession={() => goto("session")} hosts={hosts} />;
			case "updates":
				return <UpdatesScreen />;
			case "settings":
				return <SettingsScreen />;
			default:
				return <AgentsScreen hosts={hosts} error={hostsError} filterCwd={filterCwd} onClearFilter={() => setFilterCwd(null)} onOpen={h => void openHost(h)} onRefresh={refreshHosts} />;
		}
	}, [screen, client, hosts, hostsError, filterCwd, openHost, openInstance, leaveSession, goto, activeHost, refreshHosts]);

	const navIcon: Record<Exclude<Screen, "session">, ReactNode> = {
		super: <Crown size={22} />,
		agents: <Bot size={22} />,
		projects: <Folder size={22} />,
		sessions: <History size={22} />,
		memory: <Brain size={22} />,
		activity: <Activity size={22} />,
		updates: <RefreshCw size={22} />,
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
							<span className="pk-nav-label">{s.label}</span>
						</button>
					))}
				</nav>
			)}
		</div>
	);
}
