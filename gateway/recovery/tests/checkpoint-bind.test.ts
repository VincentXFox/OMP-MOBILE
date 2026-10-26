import { describe, expect, test } from "bun:test";
import { bindSessions, type PaneInfo } from "../checkpoint.ts";
import type { OmpHost } from "../../hosts.ts";
import type { OmpProcessProbe } from "../../update/probes.ts";

function host(patch: Partial<OmpHost> = {}): OmpHost {
	return {
		instanceId: "inst-a",
		generation: 1,
		pid: 1000,
		sessionId: "sess-a",
		sessionName: "agent a",
		cwd: "/work/a",
		model: { provider: "deepseek", id: "deepseek-v4-flash" },
		startedAt: 1,
		participants: 1,
		relayConnected: true,
		inputRequired: false,
		busy: false,
		access: "control",
		alive: true,
		sessionFile: null,
		sessionTitle: null,
		sessionPreview: null,
		...patch,
	} as OmpHost;
}

function pane(patch: Partial<PaneInfo> = {}): PaneInfo {
	return {
		paneId: "pane-1",
		pid: null,
		cmdline: "",
		argv: [],
		sessionFile: null,
		cwd: "/work/a",
		sessionId: null,
		instanceId: null,
		launchArgv: [],
		...patch,
	};
}

function probe(patch: Partial<OmpProcessProbe> = {}): OmpProcessProbe {
	return {
		pid: 1000,
		cmdline: "omp --cwd /work/a",
		argv: ["/home/u/.local/bin/omp", "--cwd", "/work/a", "--allow-home", "--model", "deepseek/x"],
		startTime: null,
		exePath: "/home/u/.local/bin/omp",
		exeDeleted: false,
		exeInode: 1,
		sessionFile: null,
		cwd: "/work/a",
		...patch,
	};
}

describe("bindSessions: связывание хоста с панелью", () => {
	test("точный pid процесса агента — основная связь", () => {
		const sessions = bindSessions([host()], [pane({ paneId: "pane-pid", pid: 1000 })], [probe()]);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.paneId).toBe("pane-pid");
		expect(sessions[0]?.launchArgv).toEqual(["/home/u/.local/bin/omp", "--cwd", "/work/a", "--allow-home", "--model", "deepseek/x"]);
	});

	// Регресс живого апдейта 18.12.6 → 18.13.0: проба процессов панели вернула пусто,
	// панель без pid выпадала из чекпоинта, и сессия оставалась на удалённом образе,
	// хотя панель сама знает свою сессию.
	test("проба процессов пуста — панель находится по sessionId", () => {
		const sessions = bindSessions([host()], [pane({ paneId: "pane-sess", pid: null, sessionId: "sess-a" })], []);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.paneId).toBe("pane-sess");
	});

	test("sessionId нет — панель находится по instanceId", () => {
		const sessions = bindSessions([host()], [pane({ paneId: "pane-inst", instanceId: "inst-a" })], []);
		expect(sessions[0]?.paneId).toBe("pane-inst");
	});

	test("пустой argv процесса — берём launchArgv панели, а не голый omp", () => {
		const launchArgv = ["/home/u/.local/bin/omp", "--cwd", "/work/a", "--allow-home", "--model", "deepseek/x"];
		const sessions = bindSessions([host()], [pane({ sessionId: "sess-a", launchArgv })], []);
		expect(sessions[0]?.launchArgv).toEqual(launchArgv);
	});

	test("одну панель двум хостам не отдаём: первым выигрывает точный pid", () => {
		const first = host({ pid: 1000, sessionId: "sess-a", instanceId: "inst-a" });
		const second = host({ pid: 2000, sessionId: "sess-b", instanceId: "inst-b", cwd: "/work/b" });
		const shared = pane({ paneId: "pane-1", pid: 1000, sessionId: "sess-b", instanceId: "inst-b" });
		const sessions = bindSessions([first, second], [shared], [probe()]);
		expect(sessions[0]?.paneId).toBe("pane-1");
		expect(sessions[1]?.paneId).toBeNull();
	});

	// Контрпример состязательного разбора: панель по pid принадлежит второму хосту,
	// а её sessionId указывает на первый. Исход не должен зависеть от порядка хостов
	// в реестре — иначе одна панель доставалась бы двум сессиям сразу.
	test("рассинхрон панели: pid-владелец побеждает при любом порядке хостов", () => {
		const a = host({ pid: 1000, sessionId: "sess-a", instanceId: "inst-a" });
		const b = host({ pid: 2000, sessionId: "sess-b", instanceId: "inst-b", cwd: "/work/b" });
		const confused = pane({ paneId: "pane-1", pid: 2000, sessionId: "sess-a", instanceId: "inst-a" });
		const forward = bindSessions([a, b], [confused], [probe({ pid: 1000 }), probe({ pid: 2000 })]);
		expect(forward[0]?.paneId).toBeNull();
		expect(forward[1]?.paneId).toBe("pane-1");
		const reversed = bindSessions([b, a], [confused], [probe({ pid: 1000 }), probe({ pid: 2000 })]);
		expect(reversed[0]?.paneId).toBe("pane-1");
		expect(reversed[1]?.paneId).toBeNull();
	});

	// Контрпример состязательного разбора: фолбэк не должен брать панель, где проба
	// видит живой процесс (чужой агент) — иначе перезапуск убьёт его и упрётся в
	// «панель не вернулась к оболочке», а сессия останется мёртвой.
	test("фолбэк не берёт занятую панель с живым процессом", () => {
		const sessions = bindSessions([host()], [pane({ paneId: "pane-busy", pid: 9999, sessionId: "sess-a" })], []);
		expect(sessions[0]?.paneId).toBeNull();
	});

	test("мёртвый хост и фильтр --only не попадают в чекпоинт", () => {
		const dead = host({ pid: 3000, sessionId: "sess-dead", alive: false });
		const other = host({ pid: 4000, sessionId: "sess-other", cwd: "/work/other" });
		const sessions = bindSessions([dead, other], [], [], "sess-a");
		expect(sessions).toHaveLength(0);
		expect(bindSessions([host()], [], [], "sess-a")).toHaveLength(1);
	});
});
