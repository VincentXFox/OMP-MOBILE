import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Folder, Settings, Activity, Brain, Send, UsersRound, Target } from "lucide-react";
import { AgentsScreen } from "./components/agents/AgentsScreen";
import { ActivityScreen } from "./components/activity/ActivityScreen";
import { MemoryScreen } from "./components/memory/MemoryScreen";
import { GoalsScreen } from "./components/goals/GoalsScreen";
import { ProjectsScreen } from "./components/projects/ProjectsScreen";
import { SessionsScreen } from "./components/sessions/SessionsScreen";
import { SettingsScreen } from "./components/settings/SettingsScreen";
import { SessionScreen } from "./components/session/SessionScreen";
import { SuperScreen } from "./components/super/SuperScreen";
import { TelegramScreen } from "./components/telegram/TelegramScreen";
import { UpdatesScreen } from "./components/updates/UpdatesScreen";
import type { ActivityRow, HostInfo } from "./lib/gateway";
import { fetchHosts, GatewayError, getActiveBase, mintLink, remapSession, resumeSession, setToken } from "./lib/gateway";
import { markOpened } from "./lib/agent-prefs";
import { GuestClient } from "./lib/client";
import { rebaseCollabLink } from "./lib/link";
import "./components/shell/pocket.css";
import "./styles/desktop.css";

type Screen = "agents" | "telegram" | "super" | "projects" | "sessions" | "memory" | "activity" | "updates" | "settings" | "goals" | "session";

/* 5 fixed tabs (HIG ≤5, M3 3-5). super/sessions/updates are reachable from
 * screen-level entry points (header «Рой», Projects segment, Settings row). */
const TABS: readonly { id: Screen; label: string }[] = [
	{ id: "agents", label: "Агенты" },
	{ id: "telegram", label: "Телеграм" },
	{ id: "projects", label: "Проекты" },
	{ id: "activity", label: "Активность" },
	{ id: "memory", label: "Память" },
	{ id: "settings", label: "Настройки" },
];

const SCREEN_TITLE: Record<Screen, string> = {
	agents: "Агенты",
	telegram: "Телеграм",
	super: "Супер-агент",
	projects: "Проекты",
	sessions: "Сессии",
	memory: "Память",
	activity: "Активность",
	updates: "Обновления",
	settings: "Настройки",
	goals: "Цели",
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

function screenFromHash(): { screen: Screen; instanceId: string | null } {
	const hash = window.location.hash.replace(/^#\/?/, "");
	const sessionMatch = /^session\/([A-Za-z0-9_-]+)$/.exec(hash);
	if (sessionMatch) return { screen: "session", instanceId: sessionMatch[1] ?? null };
	if (hash === "telegram" || hash === "super" || hash === "projects" || hash === "sessions" || hash === "memory" || hash === "activity" || hash === "updates" || hash === "settings" || hash === "goals") {
		return { screen: hash, instanceId: null };
	}
	return { screen: "agents", instanceId: null };
}

export function App(): ReactNode {
	const initial = useRef(screenFromHash());
	const [screen, setScreen] = useState<Screen>(initial.current.screen);
	const [pendingInstanceId, setPendingInstanceId] = useState<string | null>(initial.current.instanceId);
	const [hosts, setHosts] = useState<HostInfo[] | null>(null);
	const [hostsError, setHostsError] = useState<string | null>(null);
	const [filterCwd, setFilterCwd] = useState<string | null>(null);
	const [client, setClient] = useState<GuestClient | null>(null);
	const clientRef = useRef<GuestClient | null>(null);
	const [activeInstanceId, setActiveInstanceId] = useState<string | null>(initial.current.instanceId);
	const [opening, setOpening] = useState(false);
	const [openingId, setOpeningId] = useState<string | null>(null);
	// Состояние связи: online = последний /api/hosts успешен, degraded = идут
	// неудачи при живом соединении, offline = браузер сообщил об отсутствии сети.
	const [netState, setNetState] = useState<"online" | "degraded" | "offline">(() =>
		typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online",
	);
	// Немедленный опрос реестра из UI (кнопка «Повторить») — без ожидания 5 с.
	const pollRef = useRef<() => void>(() => {});
	// Screens that must survive tab switches stay mounted (hidden) once visited.
	const [keepAliveVisited, setKeepAliveVisited] = useState<Set<string>>(
		() => new Set(screen === "settings" || screen === "memory" ? [screen] : []),
	);

	// Само-починка индикатора «thinking…»: реестр шлюза (опрос /api/hosts) — источник
	// истины о живости. Два «не работает» подряд гасят локальный индикатор, если
	// событие окончания хода потерялось (сон телефона, обрыв релея).
	useEffect(() => {
		if (client === null) return;
		const host = hosts?.find(h => h.instanceId === activeInstanceId);
		client.syncHostBusy(host === undefined ? null : host.busy === true || host.inputRequired === true);
	}, [client, hosts, activeInstanceId]);

	// hash ⇄ screen sync; back-gesture out of a session closes it.
	useEffect(() => {
		const onHash = (): void => {
			const next = screenFromHash();
			if (next.screen === "session" && next.instanceId) {
				if (clientRef.current == null) setPendingInstanceId(next.instanceId);
				setActiveInstanceId(next.instanceId);
				setScreen("session");
				return;
			}
			setScreen((prev) => {
				if (prev === "session") {
					// Back navigation left the session: tear the client down.
					clientRef.current?.close();
					clientRef.current = null;
					setClient(null);
					setActiveInstanceId(null);
				}
				return next.screen;
			});
		};
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	// F5 inside a session: re-open it from the hash once the registry loads.
	useEffect(() => {
		if (screen !== "session" || pendingInstanceId == null || client != null || opening) return;
		const instanceId = pendingInstanceId;
		setPendingInstanceId(null);
		void (async () => {
			await openInstance(instanceId);
			// Сессия не поднялась (агент исчез, stale generation, сеть): экран
			// сессии без шапки и таб-бара — тупик. Возвращаемся к списку агентов.
			if (clientRef.current === null) {
				setScreen("agents");
				window.location.hash = "#/agents";
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [screen, pendingInstanceId, client, opening]);

	// Mark keep-alive screens as visited on first open.
	useEffect(() => {
		if ((screen === "settings" || screen === "memory") && !keepAliveVisited.has(screen)) {
			setKeepAliveVisited(prev => {
				const next = new Set(prev);
				next.add(screen);
				return next;
			});
		}
	}, [screen, keepAliveVisited]);

	const goto = useCallback((next: Screen): void => {
		setScreen((prev) => {
			if (prev === "session") {
				clientRef.current?.close();
				clientRef.current = null;
				setClient(null);
				setActiveInstanceId(null);
			}
			return next;
		});
		if (next === "session") return; // session hash is set by openHost
		window.location.hash = `#/${next}`;
	}, []);

	// poll hosts every 5s; скрытая вкладка не поллит (телефон в фоне экономит
	// батарею и трафик), возврат в приложение обновляет список сразу.
	// Сеть пропала — бесполезные запросы не шлём; вернулась — опрос сразу.
	useEffect(() => {
		let alive = true;
		let timer: number | null = null;
		let lastActive = getActiveBase();
		const poll = async (): Promise<void> => {
			if (typeof navigator !== "undefined" && navigator.onLine === false) {
				setNetState("offline");
				return;
			}
			try {
				const list = await fetchHosts();
				if (!alive) return;
				setHosts(list);
				setHostsError(null);
				setNetState("online");
				// победил другой кандидат — перечитываем реестр немедленно, не ждём 5 с
				const active = getActiveBase();
				if (active !== lastActive) {
					lastActive = active;
					window.setTimeout(() => {
						if (alive) void poll();
					}, 0);
				}
			} catch (err) {
				if (!alive) return;
				const status = err instanceof GatewayError ? err.status : 0;
				setHostsError(
					status === 401
						? "Шлюз вернул 401 — открой Настройки и введи токен."
						: `Шлюз недоступен: ${err instanceof Error ? err.message : String(err)}`,
				);
				setNetState(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "degraded");
			}
		};
		pollRef.current = (): void => void poll();
		const stop = (): void => {
			if (timer !== null) {
				window.clearInterval(timer);
				timer = null;
			}
		};
		const start = (): void => {
			stop();
			timer = window.setInterval(() => void poll(), 5000);
		};
		const sync = (): void => {
			if (document.visibilityState === "visible") {
				void poll();
				start();
			} else {
				stop();
			}
		};
		const onOffline = (): void => {
			setNetState("offline");
		};
		const onOnline = (): void => {
			setNetState("online");
			void poll();
			clientRef.current?.reconnectNow();
		};
		sync();
		document.addEventListener("visibilitychange", sync);
		window.addEventListener("offline", onOffline);
		window.addEventListener("online", onOnline);
		return () => {
			alive = false;
			pollRef.current = (): void => {};
			stop();
			document.removeEventListener("visibilitychange", sync);
			window.removeEventListener("offline", onOffline);
			window.removeEventListener("online", onOnline);
		};
	}, []);

	// Возврат в приложение / сеть снова есть: немедленное переподключение чата —
	// иначе сокет ждёт backoff до 30 с, а мёртвый без close висит «живым».
	useEffect(() => {
		const wake = (): void => {
			if (document.visibilityState !== "visible") return;
			clientRef.current?.reconnectNow();
		};
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("online", wake);
		window.addEventListener("pageshow", wake);
		return () => {
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("online", wake);
			window.removeEventListener("pageshow", wake);
		};
	}, []);

	const openHost = useCallback(
		async (host: HostInfo): Promise<void> => {
			if (opening) return;
			// «Недавно открытые» — ключ сортировки списка агентов: поднимает сессию
			// наверх сразу, ещё до успешного коннекта.
			markOpened(host.sessionId);
			setOpening(true);
			setOpeningId(host.instanceId);
			try {
				const link = rebaseCollabLink(await mintLink(host.instanceId, false), window.location.origin);
				const next = new GuestClient(link, storedName());
				next.connect();
				clientRef.current?.close();
				clientRef.current = next;
				setClient(next);
				setActiveInstanceId(host.instanceId);
				// Addressable session: back-gesture/popstate → hashchange → leaveSession.
				if (window.location.hash !== `#/session/${host.instanceId}`) {
					window.location.hash = `#/session/${host.instanceId}`;
				} else {
					setScreen("session");
				}
			} catch (err) {
				const status = err instanceof GatewayError ? err.status : 0;
				setHostsError(
					status === 409
						? "Сессия обновилась (stale generation) — попробуй ещё раз."
						: !window.isSecureContext
							? "Страница открыта по http — браузер отключил шифрование, чаты не работают. Открой приложение по https-адресу (см. сообщение сверху)."
							: `Не удалось открыть сессию: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				setOpening(false);
				setOpeningId(null);
			}
		},
		[goto, opening],
	);

	const leaveSession = useCallback((): void => {
		clientRef.current?.close();
		clientRef.current = null;
		setClient(null);
		setActiveInstanceId(null);
		// Route back: hashchange listener performs the actual screen switch.
		if (window.location.hash.startsWith("#/session/")) {
			history.back();
			// Fallback (session opened as the first history entry): force agents.
			window.setTimeout(() => {
				if (window.location.hash.startsWith("#/session/")) window.location.hash = "#/agents";
			}, 0);
		} else {
			setScreen("agents");
			window.location.hash = "#/agents";
		}
	}, []);

	const refreshHosts = useCallback((): void => {
		void (async () => {
			try {
				setHosts(await fetchHosts());
				setHostsError(null);
			} catch (err) {
				// «Повторить» и создание агента не должны молча ничего не делать.
				setHostsError(err instanceof Error ? err.message : String(err));
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
				let target = fresh.find(h => h.instanceId === instanceId) ?? null;
				if (target === null) {
					// Экземпляр переродился (сбой питания, апдейт omp): шлюз хранит
					// соответствие старый→новый по стабильному sessionId.
					const remapped = await remapSession(instanceId);
					if (remapped !== null) target = fresh.find(h => h.instanceId === remapped) ?? null;
				}
				if (target !== null) {
					await openHost(target);
					return;
				}
				setHostsError("Сессия поднялась, но агент не появился в collab-реестре.");
			} catch (err) {
				setHostsError(err instanceof Error ? err.message : String(err));
			}
		},
		[openHost],
	);

	// Строка ленты активности: живой агент открывается сразу, архивная сессия
	// сначала поднимается через resume — иначе тап по истории ничего не делает.
	const openActivityRow = useCallback(
		async (row: ActivityRow): Promise<void> => {
			const live = hosts?.find(h => h.sessionId === row.sessionId);
			if (live !== undefined) {
				await openHost(live);
				return;
			}
			if (row.cwd === null) {
				setHostsError("У сессии нет рабочего каталога — открыть нельзя.");
				return;
			}
			const resumed = await resumeSession(row.cwd, row.sessionPath, { mode: "resume" });
			if (!resumed.ok || resumed.instanceId === undefined) {
				setHostsError(resumed.error ?? "не удалось возобновить сессию");
				return;
			}
			await openInstance(resumed.instanceId);
		},
		[hosts, openHost, openInstance],
	);

	const activeHost = useMemo(
		() => hosts?.find(h => h.instanceId === activeInstanceId),
		[hosts, activeInstanceId],
	);

	const agentsScreen = (key: string): ReactNode => (
		<AgentsScreen
			key={key}
			hosts={hosts}
			error={hostsError}
			filterCwd={filterCwd}
			openingId={openingId}
			onClearFilter={() => setFilterCwd(null)}
			onOpen={h => void openHost(h)}
			onRefresh={refreshHosts}
		/>
	);

	// Keep-alive screens stay mounted (hidden) so their state survives tab switches.
	const keepAlive = (id: "memory" | "settings", node: ReactNode): ReactNode =>
		keepAliveVisited.has(id) ? (
			<div hidden={screen !== id} className="pk-keepalive">
				{node}
			</div>
		) : null;

	const body = useMemo<ReactNode>(() => {
		switch (screen) {
			case "session":
				if (client) return <SessionScreen client={client} onLeave={leaveSession} host={activeHost} onReopen={id => void openInstance(id)} />;
				return agentsScreen("agents-fallback");
			case "telegram":
				return <TelegramScreen />;
			case "super":
				return <SuperScreen onOpenSession={openSuperSession} />;
			case "sessions":
				return <SessionsScreen onOpenInstance={id => void openInstance(id)} />;
			case "goals":
				return <GoalsScreen />;
			case "projects":
				return (
					<ProjectsScreen
						hosts={hosts}
						error={hostsError}
						onOpenInstance={id => void openInstance(id)}
						onOpen={cwd => {
							setFilterCwd(cwd);
							goto("agents");
						}}
					/>
				);
			case "activity":
				return (
					<ActivityScreen
						client={client}
						onOpenSession={() => {
							// Маршрут обязан смениться: иначе F5/«назад» уводят из чата.
							if (activeInstanceId !== null) window.location.hash = `#/session/${activeInstanceId}`;
							else goto("session");
						}}
						onOpenRow={row => void openActivityRow(row)}
						hosts={hosts}
						error={hostsError}
						onRetry={refreshHosts}
					/>
				);
			case "updates":
				return <UpdatesScreen />;
			case "memory":
			case "settings":
				// Rendered via keepAlive() below so they stay mounted across tabs.
				return null;
			default:
				return agentsScreen("agents");
		}
		// keep-alive screens are rendered separately below
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [screen, client, hosts, hostsError, filterCwd, openHost, openInstance, leaveSession, goto, activeHost, refreshHosts, keepAliveVisited]);

	// «Повторить»: немедленный опрос реестра + переподключение чата.
	const retryNow = useCallback((): void => {
		pollRef.current();
		clientRef.current?.reconnectNow();
	}, []);

	const netHint =
		netState === "offline"
			? "Нет сети — проверь подключение к интернету"
			: netState === "degraded"
				? "Нет связи со шлюзом — идёт переподключение"
				: "Связь со шлюзом в порядке";

	const navIcon: Record<Screen, ReactNode> = {
		agents: <Bot size={22} />,
		telegram: <Send size={22} />,
		projects: <Folder size={22} />,
		activity: <Activity size={22} />,
		memory: <Brain size={22} />,
		settings: <Settings size={22} />,
		goals: <Target size={22} />,
		super: <UsersRound size={22} />,
		sessions: <Folder size={22} />,
		updates: <Settings size={22} />,
		session: <Bot size={22} />,
	};

	return (
		<div className={`pk-app${screen === "session" ? " pk-app--session" : ""}`}>
			{typeof window !== "undefined" && !window.isSecureContext && (
				<div className="pk-insecure-banner" role="alert">
					⚠ Открыто по http — браузер отключил шифрование: чаты и вложения работать не будут. Открой приложение по https-адресу (см. актуальную ссылку).
				</div>
			)}
			{screen !== "session" && (
				<header className="pk-header">
					<span className="pk-header-title">{SCREEN_TITLE[screen]}</span>
					<span className={`pk-net pk-net--${netState}`} title={netHint}>
						<span className="pk-net-dot" aria-hidden="true" />
						{netState !== "online" && (
							<span className="pk-net-label">
								{netState === "offline" ? "Нет сети" : "Нет связи со шлюзом — переподключение…"}
							</span>
						)}
					</span>
					{netState !== "online" && (
						<button type="button" className="pk-net-retry" onClick={retryNow}>
							Повторить
						</button>
					)}
					{screen === "agents" && (
						<button type="button" className="pk-icon-btn" aria-label="Рой" title="Рой" onClick={() => goto("super")}>
							{navIcon.super}
						</button>
					)}
				</header>
			)}
			<main className="pk-main">
				<div className="pk-content">
					{body}
					{keepAlive("memory", <MemoryScreen />)}
					{keepAlive("settings", <SettingsScreen onOpenUpdates={() => goto("updates")} onOpenGoals={() => goto("goals")} />)}
				</div>
			</main>
			<nav
				className={`pk-nav${screen === "session" ? " pk-nav--hidden-mobile" : ""}`}
				aria-label="Основная навигация"
			>
				{TABS.map(s => (
					<button
						key={s.id}
						type="button"
						className={`pk-nav-item${screen === s.id ? " pk-nav-item--on" : ""}`}
						aria-current={screen === s.id ? "page" : undefined}
						onClick={() => goto(s.id)}
					>
						{navIcon[s.id]}
						<span className="pk-nav-label">{s.label}</span>
					</button>
				))}
			</nav>

		</div>
	);
}
