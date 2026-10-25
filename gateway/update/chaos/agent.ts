#!/usr/bin/env bun
/**
 * Фейковый бинарь для chaos-набора: один скрипт играет роль omp, systemctl и git.
 * Мир (сессии, юниты, HEAD) лежит в world.json рядом, поэтому сценарии управляют
 * поведением без реальных сервисов; рантайм панелей при этом настоящий — этот
 * скрипт только запускает и гасит его демона (см. ./runtime.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runtimeSpecFromEnv, spawnRuntimeDaemon, stopRuntimeDaemon, withFileLock } from "./runtime.ts";
import type { WorldFile as World } from "./world.ts";

/** Форма мира одна на весь набор: она объявлена в `world.ts` — иначе поля тихо
 * расходились бы между драйвером и тестом. */

/** Корень мира: env или выводится из пути бинаря (<root>/bin/omp) — так фейковый
 * omp работает и там, где env не дошёл (например, из шлюза без обёртки). */
function resolveRoot(): string {
  const fromEnv = process.env["OMP_CHAOS_ROOT"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const binDir = dirname(process.execPath);
  const candidate = dirname(binDir);
  if (basename(binDir) === "bin" && existsSync(join(candidate, "world.json"))) return candidate;
  process.stderr.write("OMP_CHAOS_ROOT не задан и не выводится из пути бинаря\n");
  process.exit(9);
}
const root: string = resolveRoot();
const worldPath = join(root, "world.json");

function readWorld(): World {
  return JSON.parse(readFileSync(worldPath, "utf8")) as World;
}

/** Замена файла целиком: читатели не увидят половину записи (rename атомарен). */
function writeWorld(world: World): void {
  const tmp = `${worldPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(world, null, 1));
  renameSync(tmp, worldPath);
}

/** Правка мира под замком: в world.json пишут сразу несколько процессов (драйверы
 * и тест), а запись — read-modify-write целого файла, поэтому без замка часть
 * правок терялась бы. */
function withWorld<T>(mutate: (world: World) => T): T {
  return withFileLock(`${worldPath}.lock`, () => {
    const world = readWorld();
    const result = mutate(world);
    writeWorld(world);
    return result;
  });
}

const argv = Bun.argv;
/** Роль определяется именем, под которым скомпилированный бинарь запущен
 * (hardlink bin/omp, bin/systemctl, …): /proc/exe и execPath сохраняют это имя. */
const role = basename(process.execPath) === "driver.bin" ? basename(argv[1] ?? "") : basename(process.execPath);
const args = argv.slice(2);
/** Сессию поднимают с `--cwd` и селектором восстановления: так фейковый omp
 * отличает себя от `--version` и `collab list`, которые те же шлюз и апдейтер
 * вызывают тем же бинарём. */
const isSession = args.includes("--cwd") && ["--restore", "--resume", "--continue", "-c", "-r"].some((flag) => args.includes(flag));

/** Живой процесс сессии: сам регистрирует в мире свой настоящий pid (по нему
 * collab-реестр считает хост живым, а апдейтер доказывает, что сессия работает на
 * новом бинаре), пишет в лог свою команду и отдаёт промпты, набранные в панель. */
async function runSession(): Promise<void> {
  if (readWorld().breakRestore) process.exit(1);
  const sessionFile = (() => {
    for (const flag of ["--restore", "--resume"]) {
      const idx = args.indexOf(flag);
      if (idx >= 0) return args[idx + 1] ?? null;
    }
    return null;
  })();
  const cwdIdx = args.indexOf("--cwd");
  const cwd = cwdIdx >= 0 ? (args[cwdIdx + 1] ?? null) : null;
  withWorld((world) => {
    const session = world.sessions.find((candidate) => (sessionFile === null ? candidate.cwd === cwd : candidate.sessionFile === sessionFile));
    if (session !== undefined) session.pid = process.pid;
    world.runs.push(args.join(" "));
  });
  // Промпт приходит в панель как bracketed paste (`\x1b[200~…\x1b[201~`), затем
  // Enter. Ловим именно метки вставки, а не перевод строки: в каноническом режиме
  // многострочный промпт драйвер терминала отдаёт по строкам, и Enter приходит
  // как `\n` — по ним промпт распался бы на куски.
  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  let pending = "";
  void (async () => {
    const reader = Bun.stdin.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) return;
      pending += new TextDecoder().decode(value);
      for (;;) {
        const start = pending.indexOf(PASTE_START);
        if (start < 0) {
          // Хвост держим: метка вставки может прийти разрезанной между чтениями.
          pending = pending.slice(-PASTE_START.length);
          break;
        }
        const end = pending.indexOf(PASTE_END, start + PASTE_START.length);
        if (end < 0) {
          pending = pending.slice(start);
          break;
        }
        const text = pending.slice(start + PASTE_START.length, end).trim();
        pending = pending.slice(end + PASTE_END.length);
        if (text !== "") withWorld((world) => world.prompts.push(text));
      }
    }
  })();
  setInterval(() => {}, 1_000);
  await new Promise<never>(() => {});
}

async function handleOmp(): Promise<never> {
  if (isSession) await runSession();
  const world = readWorld();
  if (args[0] === "--version") {
    process.stdout.write(`omp/${process.env.OMP_CHAOS_VERSION ?? world.ompVersion}\n`);
    process.exit(0);
  }
  if (args[0] === "collab" && args[1] === "list") {
    const hosts = world.sessions.map((session) => ({
      instanceId: `i-${session.sessionId}`,
      generation: 1,
      pid: session.pid,
      sessionId: session.sessionId,
      sessionName: `name-${session.sessionId}`,
      cwd: session.cwd,
      model: { provider: session.model.split("/")[0] ?? "fake", id: session.model.split("/")[1] ?? "model" },
      startedAt: 1,
      participants: 1,
      relayConnected: true,
      inputRequired: session.inputRequired,
      busy: session.busy,
      access: "control",
    }));
    process.stdout.write(`${JSON.stringify({ hosts })}\n`);
    process.exit(0);
  }
  if (args[0] === "collab" && args[1] === "link") {
    process.stdout.write(`${JSON.stringify({ url: "http://fake/link" })}\n`);
    process.exit(0);
  }
  process.exit(0);
}

/** `systemctl --user` фейковый: юниты и их pid живут в мире. Рестарт рантайма —
 * единственный случай, когда поднимается НАСТОЯЩИЙ демон: старый гасим, новый
 * стартует с задержкой `runtimeDown` — боевая гонка «демон поднимается не сразу». */
async function handleSystemctl(): Promise<never> {
  const userIdx = args.indexOf("--user");
  const rest = userIdx >= 0 ? args.slice(userIdx + 1) : args;
  const [verb, unit] = rest;
  if (verb === "show" && unit !== undefined) {
    const state = readWorld().units[unit] ?? { active: "active", pid: 5000 };
    // как настоящий systemctl: key=value, порядок свой
    process.stdout.write(`MainPID=${state.pid}\nActiveState=${state.active}\n`);
    process.exit(0);
  }
  if (verb === "restart" && unit !== undefined) {
    const delayMs = withWorld((world) => {
      world.restarts.push(unit);
      world.units[unit] = { active: "active", pid: 6000 + world.restarts.length };
      if (unit === "omp-pocket-gateway") world.gateway = { pid: 7000 + world.restarts.length, buildSha: world.head };
      if (unit === "omp-pocket-runtime") world.runtimeDown = 2_500;
      return world.runtimeDown;
    });
    if (unit === "omp-pocket-runtime") {
      const spec = runtimeSpecFromEnv();
      await stopRuntimeDaemon(readWorld().runtime.pid);
      const pid = spawnRuntimeDaemon(spec, delayMs);
      withWorld((world) => {
        world.runtime.pid = pid;
        world.units[unit] = { active: "active", pid };
      });
    }
    process.exit(0);
  }
  process.exit(0);
}

function handleGit(): never {
  const world = readWorld();
  const [verb, sub] = args;
  const out = (text: string): never => {
    process.stdout.write(`${text}\n`);
    process.exit(0);
  };
  if (verb === "rev-parse" && sub === "HEAD") out(world.head);
  if (verb === "rev-parse" && sub === "--abbrev-ref") out("master");
  if (verb === "remote" && sub === "get-url") out("file:///fake/remote");
  if (verb === "ls-remote") {
    if (args.includes("--heads")) out(`${world.remoteHead}\trefs/heads/master`);
    out(`${world.remoteHead}\tHEAD`);
  }
  if (verb === "status" && sub === "--porcelain") out(world.dirty.join("\n"));
  if (verb === "stash" && sub === "create") {
    process.exit(0);
  }
  if (verb === "cat-file" && sub === "-e") {
    const sha = args[2] ?? "";
    process.exit(sha === world.head || sha === world.remoteHead ? 0 : 1);
  }
  if (verb === "merge-base" && sub === "--is-ancestor") {
    const ancestor = args[2] ?? "";
    process.exit(ancestor === world.head ? 0 : 1);
  }
  if (verb === "rev-list" && sub === "--count") {
    out(world.head === world.remoteHead ? "0" : "1");
  }
  if (verb === "pull") {
    withWorld((world) => {
      world.head = world.remoteHead;
    });
    out("Updating fake..fake");
  }
  if (verb === "reset" && sub === "--hard") {
    withWorld((world) => {
      world.head = args[2] ?? world.head;
    });
    out("HEAD is now at fake");
  }
  process.exit(0);
}

function handleBun(): never {
  const world = readWorld();
  if (args[0] === "install") process.exit(0);
  if (args[0] === "run" && args[1] === "build") {
    // сборка «ломается» только на конкретном коммите: откат к предыдущему должен снова собраться
    const failMarker = join(root, "build-fail-at");
    if (existsSync(failMarker) && readFileSync(failMarker, "utf8").trim() === world.head) {
      process.stderr.write("fake build failed\n");
      process.exit(1);
    }
    const dist = join(root, "repo", "app", "dist");
    mkdirSync(dist, { recursive: true });
    const asset = "app-abc123.js";
    writeFileSync(join(dist, asset), "console.log('fake app');\n");
    writeFileSync(join(dist, "app.css"), ".app{display:flex}\n");
    const html = [
      "<!doctype html><html><head><meta charset=\"utf-8\">",
      `<link rel="stylesheet" href="./app.css">`,
      `<script type="module" src="./${asset}"></script>`,
      "<title>OMP Pocket (fake build)</title></head><body><div id=\"root\"></div>",
      "<noscript>Включите JavaScript, чтобы пользоваться пультом агентов.</noscript></body></html>",
    ].join("\n");
    writeFileSync(join(dist, "index.html"), `${html}\n`);
    process.exit(0);
  }
  process.exit(0);
}

switch (role) {
  case "omp":
    await handleOmp();
  case "systemctl":
    await handleSystemctl();
  case "git":
    handleGit();
  case "bun-fake":
    handleBun();
  default:
    process.stderr.write(`неизвестная роль ${role}\n`);
    process.exit(9);
}
