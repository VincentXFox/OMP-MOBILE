import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateService } from "../service.ts";
import {
  assistantTurn,
  createChaosRoot,
  pathsFor,
  sessionJsonl,
  sigtermExit,
  startFakeGateway,
  killProcessesUnder,
  startReleaseServer,
  toolResult,
  type ChaosRoot,
  type GatewayServer,
  type ReleaseServer,
} from "./world.ts";

const runs: ChaosRoot[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  for (const root of runs.splice(0)) {
    // Демон рантайма настоящий: гасим его первым, иначе он поднимет панели заново
    // уже во время удаления каталога мира.
    await root.stopRuntime();
    killProcessesUnder(root.dir);
    delete process.env["OMP_RUNTIME_SOCKET"];
    // изолированный мир больше не нужен: иначе /tmp копит сотни копий
    rmSync(root.dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const stop of stops.splice(0)) stop();
});

async function makeRoot(options: Parameters<typeof createChaosRoot>[0] = {}): Promise<ChaosRoot> {
  const root = await createChaosRoot(options);
  // Клиент рантайма берёт сокет из env процесса: направляем его на мир этого
  // корня, иначе сервис шлюза в тесте стучался бы в хостовый демон.
  process.env["OMP_RUNTIME_SOCKET"] = root.socket;
  runs.push(root);
  return root;
}

function makeRelease(options: Parameters<typeof startReleaseServer>[0] = {}): ReleaseServer {
  const server = startReleaseServer(options);
  stops.push(() => server.stop());
  return server;
}

function makeGateway(root: ChaosRoot): GatewayServer {
  const server = startFakeGateway(root);
  stops.push(() => server.stop());
  return server;
}

const finishedTranscript = [assistantTurn("stop"), toolResult("c1")];

/** Ожидание реального условия вместо фиксированной паузы: сценарии не должны
 * зависеть от угаданных миллисекунд. */
async function waitFor(condition: () => boolean, timeoutMs = 20_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("условие не наступило за отведённое время");
    await Bun.sleep(intervalMs);
  }
}

describe("chaos: обновление OMP", () => {
  test("1. счастливый путь: проверенный бинарь, перезапуск панели, восстановление сессии", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    const res = await root.runOrchestrator("omp", "job-1", [], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-1");
    expect(res.code).toBe(0);
    expect(job?.phase).toBe("COMPLETED");
    expect(job?.versions).toEqual({ from: "18.12.6", to: "18.13.0" });
    expect(job?.result?.restored).toBe(1);
    const world = root.readWorld();
    expect(world.runs).toHaveLength(1);
    expect(world.runs[0]).toContain("--restore");
    const versionOut = Bun.spawnSync([join(root.binDir, "omp"), "--version"], { env: { ...process.env, ...root.env } });
    expect(versionOut.stdout.toString().trim()).toBe("omp/18.13.0");
  }, 60_000);

  test("2. обновление при занятом агенте: сервис требует подтверждения, затем ставит с чекпоинтом", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript, busy: true }] });
    const service = new UpdateService(pathsFor(root));
    // фейковый omp ищет world.json по этому пути; сам сервис получает явные пути
    const savedRoot = process.env.OMP_CHAOS_ROOT;
    process.env.OMP_CHAOS_ROOT = root.dir;
    const busy = await service.apply("omp", false);
    expect(busy.kind).toBe("busy");
    if (busy.kind === "busy") expect(busy.agents[0]?.cwd).toBe(join(root.dir, "work/app"));

    const accepted = await service.apply("omp", true);
    if (savedRoot === undefined) delete process.env.OMP_CHAOS_ROOT;
    else process.env.OMP_CHAOS_ROOT = savedRoot;
    expect(accepted.kind).toBe("accepted");
    const log = readFileSync(join(root.binDir, "systemd-run.log"), "utf8");
    expect(log).toContain("orchestrator.ts");
    expect(log).toContain("--component omp");
  }, 30_000);

  test("3. длительная задача: турн продолжается промптом, опасная операция перечислена", async () => {
    const transcript = [
      assistantTurn("toolUse", [{ id: "c-1", name: "bash", command: "git push --force origin master" }]),
      sigtermExit("sigterm", [{ toolCallId: "c-1", toolName: "bash", command: "git push --force origin master" }]),
      toolResult("c-1"),
      assistantTurn("aborted"),
    ];
    const root = await makeRoot({
      ompVersion: "18.12.6",
      seeds: [{ sessionId: "s-long", cwd: "/work/long", transcript, busy: true }],
    });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    const res = await root.runOrchestrator("omp", "job-long", [], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-long");
    expect(res.code).toBe(0);
    expect(job?.phase).toBe("COMPLETED");
    expect(job?.result?.resumed).toBe(1);
    const prompts = root.readWorld().prompts;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("git push --force origin master");
    expect(prompts[0]).toContain("проверь её фактический результат");
    expect(prompts[0]).toContain("СТАТУС: BLOCKED");
  }, 60_000);

  test("4. ожидающее подтверждение: сессия не перезапускается и не продолжается автоматически", async () => {
    const root = await makeRoot({
      ompVersion: "18.12.6",
      seeds: [{ sessionId: "s-approve", cwd: "/work/approve", transcript: finishedTranscript, inputRequired: true }],
    });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    await root.runOrchestrator("omp", "job-approve", [], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-approve");
    const world = root.readWorld();
    expect(job?.phase).toBe("COMPLETED");
    expect(job?.result?.blocked.join(" ")).toContain("подтверждения");
    expect(world.runs).toHaveLength(0);
    expect(world.prompts).toHaveLength(0);
  }, 60_000);

  test("5. без телефона прогресс не теряется: состояние и seq журнала durable на диске", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    const release = makeRelease({ version: "18.13.0" });
    gateway: {
      makeGateway(root);
    }
    await root.runOrchestrator("omp", "job-offline", [], { PI_BUILD_URL: release.origin });
    const events = root.readEvents("job-offline");
    expect(events.length).toBeGreaterThan(10);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event.phase === "COMPLETED")).toBe(true);
  }, 60_000);
});

describe("chaos: сбои и восстановление", () => {
  for (const fault of ["after-checking", "after-preparing", "after-checkpointing", "after-installing", "after-restarting", "after-verifying", "after-restoring"]) {
    test(`6/${fault}. убийство оркестратора в фазе ${fault}: повторный запуск доводит задачу`, async () => {
      const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
      const release = makeRelease({ version: "18.13.0" });
      makeGateway(root);
      const first = await root.runOrchestrator("omp", "job-resume", [], { PI_BUILD_URL: release.origin, OMP_UPDATE_FAULT: fault });
      expect(first.code).toBe(137);
      const second = await root.runOrchestrator("omp", "job-resume", [], { PI_BUILD_URL: release.origin });
      const job = root.readJob("job-resume");
      expect(second.code).toBe(0);
      expect(job?.phase).toBe("COMPLETED");
      expect(job?.attempt).toBe(2);
      expect(root.readEvents("job-resume").some((event) => event.kind === "resume")).toBe(true);
    }, 90_000);
  }

  test("7. подмена релиза (неверный SHA-256): установка отклонена, бинарь не тронут", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [] });
    const release = makeRelease({ version: "18.13.0", declaredSha: "0".repeat(64) });
    makeGateway(root);
    const res = await root.runOrchestrator("omp", "job-bad-sha", [], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-bad-sha");
    expect(res.code).toBe(2);
    expect(job?.phase).toBe("FAILED");
    expect(job?.error?.message).toContain("SHA-256");
    const versionOut = Bun.spawnSync([join(root.binDir, "omp"), "--version"], { env: { ...process.env, ...root.env } });
    expect(versionOut.stdout.toString().trim()).toBe("omp/18.12.6");
  }, 60_000);

  test("8. источник обновлений недоступен: задача падает на проверке, установка не начинается", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [] });
    const release = makeRelease({ fail: true });
    makeGateway(root);
    const res = await root.runOrchestrator("omp", "job-no-source", [], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-no-source");
    expect(res.code).toBe(2);
    expect(job?.phase).toBe("FAILED");
    expect(job?.steps.some((step) => step.id.startsWith("install."))).toBe(false);
  }, 60_000);

  test("9. нехватка места: preflight останавливает апдейт до установки", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [] });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    const res = await root.runOrchestrator("omp", "job-disk", [], { PI_BUILD_URL: release.origin, OMP_UPDATE_MIN_FREE_BYTES: String(1024 ** 5) });
    const job = root.readJob("job-disk");
    expect(res.code).toBe(2);
    expect(job?.phase).toBe("FAILED");
    expect(job?.error?.message).toContain("Свободное место");
  }, 60_000);

  test("10. несовместимый протокол фиксируется предупреждением, а не глушится", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    writeFileSync(join(root.repoDir, "app", "package.json"), JSON.stringify({ name: "app", version: "0.1.0", dependencies: { "@oh-my-pi/pi-wire": "17.9.0" } }));
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    await root.runOrchestrator("omp", "job-compat", [], { PI_BUILD_URL: release.origin });
    const events = root.readEvents("job-compat");
    const compat = events.find((event) => event.kind === "compat");
    expect(compat?.data?.["ok"]).toBe(false);
    expect(root.readJob("job-compat")?.phase).toBe("COMPLETED");
  }, 60_000);

  test("12. два одновременных обновления: второй оркестратор получает lock-busy", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    const first = root.runOrchestrator("omp", "job-a", [], { PI_BUILD_URL: release.origin });
    await waitFor(() => existsSync(join(root.stateDir, "update.lock")));
    const second = await root.runOrchestrator("omp", "job-b", [], { PI_BUILD_URL: release.origin });
    await first;
    expect(second.code).toBe(3);
    expect(second.stderr).toContain("уже выполняется");
  }, 60_000);

  test("13. повторное нажатие при активной задаче: сервис отвечает job_running", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [] });
    const service = new UpdateService(pathsFor(root));
    const first = await service.apply("omp", true);
    expect(first.kind).toBe("accepted");
    const second = await service.apply("omp", true);
    expect(second.kind).toBe("job_running");
  }, 30_000);

  test("15. повреждённый чекпоинт: восстановление блокируется, панели не трогаются вслепую", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    const res = await root.runOrchestrator("omp", "job-corrupt", [], { PI_BUILD_URL: release.origin, OMP_UPDATE_FAULT: "corrupt-checkpoint" });
    const job = root.readJob("job-corrupt");
    expect(res.code).toBe(4);
    expect(job?.phase).toBe("BLOCKED");
    expect(job?.error?.message).toContain("чекпоинт");
  }, 60_000);

  test("17. несколько сессий: восстанавливаются все, кроме ждущей подтверждения", async () => {
    const root = await makeRoot({
      ompVersion: "18.12.6",
      seeds: [
        { sessionId: "s-a", cwd: "/work/a", transcript: finishedTranscript },
        { sessionId: "s-b", cwd: "/work/b", transcript: finishedTranscript },
        { sessionId: "s-c", cwd: "/work/c", transcript: finishedTranscript, inputRequired: true },
      ],
    });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    await root.runOrchestrator("omp", "job-many", [], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-many");
    expect(job?.result?.restored).toBe(2);
    expect(job?.result?.blocked).toHaveLength(1);
    expect(root.readWorld().runs).toHaveLength(2);
  }, 90_000);

  test("18/19. провал проверки после установки: автоматический откат возвращает предыдущий бинарь", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    // Процессы сессий не поднимаются вовсе: сессия не регистрируется, поэтому
    // восстановление проваливается и задача уходит в автоматический откат.
    root.withWorld((world) => {
      world.breakRestore = true;
    });
    const res = await root.runOrchestrator("omp", "job-rollback", [], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-rollback");
    expect(res.code).toBe(2);
    expect(job?.phase).toBe("ROLLED_BACK");
    const versionOut = Bun.spawnSync([join(root.binDir, "omp"), "--version"], { env: { ...process.env, ...root.env } });
    expect(versionOut.stdout.toString().trim()).toBe("omp/18.12.6");
  }, 90_000);

  test("20. повторный запуск после неудачи доводит задачу до COMPLETED", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    const broken = makeRelease({ version: "18.13.0", declaredSha: "1".repeat(64) });
    makeGateway(root);
    const failed = await root.runOrchestrator("omp", "job-retry", [], { PI_BUILD_URL: broken.origin });
    expect(failed.code).toBe(2);
    const fixed = makeRelease({ version: "18.13.0" });
    const retried = await root.runOrchestrator("omp", "job-retry-2", [], { PI_BUILD_URL: fixed.origin });
    expect(retried.code).toBe(0);
    expect(root.readJob("job-retry-2")?.phase).toBe("COMPLETED");
  }, 90_000);
});

describe("chaos: обновление кода (gateway)", () => {
  test("21. грязное рабочее дерево: обновление блокируется, правки не теряются", async () => {
    const root = await makeRoot({ head: "a".repeat(40), remoteHead: "b".repeat(40), dirty: ["M gateway/main.ts"] });
    makeGateway(root);
    const res = await root.runOrchestrator("gateway", "job-dirty", [], {});
    const job = root.readJob("job-dirty");
    expect(res.code).toBe(4);
    expect(job?.phase).toBe("BLOCKED");
    expect(job?.error?.message).toContain("рабочее дерево изменено");
    expect(readFileSync(join(root.stateDir, "jobs", "job-dirty", "dirty-worktree.txt"), "utf8")).toContain("gateway/main.ts");
  }, 60_000);

  test("22. обновление кода: pull, сборка, рестарт и проверка нового pid и сборки", async () => {
    const root = await makeRoot({ head: "a".repeat(40), remoteHead: "b".repeat(40) });
    makeGateway(root);
    const res = await root.runOrchestrator("gateway", "job-code", [], {});
    const job = root.readJob("job-code");
    if (job?.phase !== "COMPLETED") {
      console.log(res.stderr, root.readEvents("job-code").map((event) => `${event.seq} ${event.phase} ${event.kind} ${event.message ?? ""}`).join("\n"));
    }
    expect(res.code).toBe(0);
    expect(job?.phase).toBe("COMPLETED");
    const world = root.readWorld();
    expect(world.restarts).toContain("omp-pocket-gateway");
    expect(world.head).toBe("b".repeat(40));
    expect(job?.result?.verifiedVersions["gateway"]).toContain("b".repeat(7));
  }, 90_000);

  test("23. провал сборки: автооткат к предыдущему коммиту и рабочему dist", async () => {
    const root = await makeRoot({ head: "a".repeat(40), remoteHead: "b".repeat(40) });
    writeFileSync(join(root.dir, "build-fail-at"), "b".repeat(40));
    makeGateway(root);
    const res = await root.runOrchestrator("gateway", "job-build-fail", [], {});
    const job = root.readJob("job-build-fail");
    expect(res.code).toBe(2);
    expect(job?.phase).toBe("ROLLED_BACK");
    expect(root.readWorld().head).toBe("a".repeat(40));
  }, 90_000);
});

describe("chaos: события и переподключение", () => {
  test("16. лента событий: полный replay и продолжение с since без дублей", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    await root.runOrchestrator("omp", "job-events", [], { PI_BUILD_URL: release.origin });
    const service = new UpdateService(pathsFor(root));
    const all = service.jobEvents("job-events", 0);
    expect(all.length).toBeGreaterThan(10);
    const half = Math.floor(all.length / 2);
    const since = all[half - 1]?.seq ?? 0;
    const tail = service.jobEvents("job-events", since);
    expect(tail.map((event) => event.seq)).toEqual(all.slice(half).map((event) => event.seq));
    expect(new Set(all.map((event) => event.seq)).size).toBe(all.length);
  }, 60_000);

  test("26. статус показывает реально работающие версии, а не файлы на диске", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", head: "c".repeat(40), seeds: [{ sessionId: "s-1", cwd: "/work/app", transcript: finishedTranscript }] });
    makeGateway(root);
    const service = new UpdateService(pathsFor(root));
    const status = await service.status();
    const omp = status.components.find((component) => component.id === "omp");
    const gateway = status.components.find((component) => component.id === "gateway");
    expect(omp?.current).toContain("18.12.6");
    expect(omp?.current).toContain("сессий: 1");
    expect(gateway?.current).toContain("ccccccc");
    expect(gateway?.updateAvailable).toBe(false);
  }, 60_000);
});

describe("chaos: задачи, не трогающие сессии", () => {
  test("28. рестарт релея не перезапускает и не продолжает сессии", async () => {
    const root = await makeRoot({
      ompVersion: "18.12.6",
      seeds: [
        { sessionId: "s-idle", cwd: "/work/idle", transcript: finishedTranscript },
        {
          sessionId: "s-busy",
          cwd: "/work/busy",
          transcript: [assistantTurn("toolUse", [{ id: "c-1", name: "bash", command: "sleep 90" }]), sigtermExit("sigterm", [{ toolCallId: "c-1", toolName: "bash", command: "sleep 90" }]), toolResult("c-1"), assistantTurn("aborted")],
          busy: true,
        },
      ],
    });
    makeGateway(root);
    const res = await root.runOrchestrator("relay", "job-relay", [], {});
    const job = root.readJob("job-relay");
    expect(res.code).toBe(0);
    expect(job?.phase).toBe("COMPLETED");
    expect(job?.result?.restored ?? 0).toBe(0);
    expect(job?.result?.resumed ?? 0).toBe(0);
    const world = root.readWorld();
    expect(world.runs).toHaveLength(0);
    expect(world.prompts).toHaveLength(0);
    expect(world.restarts).toContain("omp-local-relay");
  }, 60_000);
});

describe("chaos: частичный перезапуск", () => {
  test("27. --only перезапускает только выбранную сессию", async () => {
    const root = await makeRoot({
      ompVersion: "18.12.6",
      seeds: [
        { sessionId: "s-target", cwd: "/work/target", transcript: finishedTranscript },
        { sessionId: "s-other", cwd: "/work/other", transcript: finishedTranscript },
      ],
    });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    const res = await root.runOrchestrator("omp", "job-only", ["--only", "/work/target"], { PI_BUILD_URL: release.origin });
    const job = root.readJob("job-only");
    expect(res.code).toBe(0);
    expect(job?.phase).toBe("COMPLETED");
    const world = root.readWorld();
    expect(world.runs).toHaveLength(1);
    expect(world.runs[0]).toContain("s-target");
  }, 60_000);
});

describe("chaos: устойчивость инфраструктуры", () => {
  test("24. рестарт шлюза во время задачи не убивает оркестратор", async () => {
    const root = await makeRoot({ ompVersion: "18.12.6", seeds: [] });
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    const run = root.runOrchestrator("omp", "job-watchdog", [], { PI_BUILD_URL: release.origin });
    // ждём реальный переход фазы, затем «рестартим шлюз» посреди работы
    await waitFor(() => {
      const job = root.readJob("job-watchdog");
      return job !== null && job.phase !== "IDLE";
    });
    Bun.spawnSync([join(root.binDir, "systemctl"), "--user", "restart", "omp-pocket-gateway"], { env: { ...process.env, ...root.env } });
    const res = await run;
    expect(res.code).toBe(0);
    expect(root.readJob("job-watchdog")?.phase).toBe("COMPLETED");
  }, 90_000);

  test("25. чекпоинт содержит состояние турна и ожидающие подтверждения", async () => {
    const transcript = [
      assistantTurn("toolUse", [{ id: "c-9", name: "write", path: "/work/app/a.ts" }]),
      sessionJsonl([]),
    ];
    const root = await makeRoot({
      ompVersion: "18.12.6",
      seeds: [
        {
          sessionId: "s-cp",
          cwd: "/work/cp",
          transcript: [assistantTurn("toolUse", [{ id: "c-9", name: "write", path: "/work/app/a.ts" }])],
          inputRequired: true,
        },
      ],
    });
    void transcript;
    const release = makeRelease({ version: "18.13.0" });
    makeGateway(root);
    await root.runOrchestrator("omp", "job-cp", [], { PI_BUILD_URL: release.origin });
    const checkpoint = JSON.parse(readFileSync(join(root.stateDir, "jobs", "job-cp", "checkpoint.json"), "utf8")) as {
      sessions: Array<{ turn: { status: string; unresolved: Array<{ toolName: string }> } | null; awaitingApproval: boolean }>;
    };
    expect(checkpoint.sessions).toHaveLength(1);
    expect(checkpoint.sessions[0]?.awaitingApproval).toBe(true);
    expect(checkpoint.sessions[0]?.turn?.status).toBe("in_flight");
    expect(checkpoint.sessions[0]?.turn?.unresolved[0]?.toolName).toBe("write");
  }, 60_000);

  test("29. рестарт рантайма поднимает панели заново: сессии не теряются", async () => {
    const root = await makeRoot({
      ompVersion: "18.12.6",
      seeds: [
        { sessionId: "s-r1", cwd: "/work/r1", transcript: finishedTranscript },
        { sessionId: "s-r2", cwd: "/work/r2", transcript: finishedTranscript },
      ],
    });
    // Демон отвечает не сразу после `systemctl restart` — та самая гонка, что
    // валила задачу: проверка обязана её переждать, а не рухнуть.
    const res = await root.runOrchestrator("runtime", "job-runtime", [], {});
    const job = root.readJob("job-runtime");
    expect(res.code).toBe(0);
    expect(job?.phase).toBe("COMPLETED");
    const world = root.readWorld();
    expect(world.restarts).toContain("omp-pocket-runtime");
    // Обе панели подняты заново через --restore, а не оставлены мёртвыми.
    expect(world.runs).toHaveLength(2);
    expect(world.runs.every((run) => run.includes("--restore"))).toBe(true);
    expect(job?.result?.restored).toBe(2);
  }, 120_000);
});
