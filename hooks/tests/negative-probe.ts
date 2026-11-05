/** Негативные проверки на реальных компонентах приёмки (без моков). */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { materialsManifest, proofForProject } from "/home/vincentfox/.omp/agent/hooks/lib/trusted-verification.ts";

const RUNS = join(homedir(), ".omp", "goldfish", "runs");
const P = "/tmp/neg-probe-project";
const RUN = "neg-probe-1";
const results: string[] = [];

const seed = (task: string): void => {
	rmSync(P, { recursive: true, force: true });
	rmSync(join(RUNS, RUN), { recursive: true, force: true });
	mkdirSync(join(P, ".omp", "gate", "probe"), { recursive: true });
	mkdirSync(P, { recursive: true });
	writeFileSync(join(P, "a.ts"), "v1");
	writeFileSync(join(P, ".omp", "gate", "probe", "certificate.json"), JSON.stringify({ schema: 1, verdict: "PASS" }));
	mkdirSync(join(RUNS, RUN), { recursive: true });
	writeFileSync(join(RUNS, RUN, "result.json"), JSON.stringify({ stage: "result", verdict: "PASS", finishedAt: new Date().toISOString() }));
	writeFileSync(join(RUNS, RUN, "packet.json"), JSON.stringify({ materials: [join(P, "a.ts")], task }));
};

// 1. Поддельный сертификат: демон не подписывал — отказать.
seed("задача А");
results.push(`поддельный сертификат: ${(await proofForProject(P, "result", "задача А")).proof === null ? "отказ (ок)" : "ПРОПУСК"}`);

// 2. Чужая задача при живом сертификате проекта.
results.push(`чужая задача: ${(await proofForProject(P, "result", "задача Б")).proof === null ? "отказ (ок)" : "ПРОПУСК"}`);

// 3. Изменение файла после ревью меняет манифест.
const before = materialsManifest([join(P, "a.ts")]).digest;
writeFileSync(join(P, "a.ts"), "v2");
const after = materialsManifest([join(P, "a.ts")]).digest;
results.push(`правка после ревью меняет манифест: ${before !== after ? "да (ок)" : "НЕТ"}`);

// 4. Удаление обязательного файла — неполная проверка.
rmSync(join(P, "a.ts"));
const missing = materialsManifest([join(P, "a.ts")]);
results.push(`удаление файла: ${missing.problems.length > 0 ? "неполная проверка (ок)" : "НЕ ЗАМЕЧЕНО"}`);

// 5. Недоступный верификатор — «не подтверждено», без перехода к локальному PASS.
seed("задача А");
process.env.OMP_VERIFIER_SOCKET = "/run/нет-такого-сокета.sock";
const dead = await proofForProject(P, "result", "задача А");
results.push(`недоступный верификатор: ${dead.proof === null ? "отказ (ок)" : "ПРОПУСК"}`);
delete process.env.OMP_VERIFIER_SOCKET;

// 6. Симлинк на предмет не подменяет проверку незаметно.
mkdirSync(P, { recursive: true });
writeFileSync(join(P, "real.ts"), "x");
try {
	const { symlinkSync } = await import("node:fs");
	symlinkSync(join(P, "real.ts"), join(P, "link.ts"));
	const m = materialsManifest([join(P, "link.ts")]);
	results.push(`симлинк помечен: ${m.entries[0]?.kind === "symlink" && m.problems.length > 0 ? "да (ок)" : "НЕТ"}`);
} catch {
	results.push("симлинк: не удалось создать в этой среде");
}

rmSync(P, { recursive: true, force: true });
rmSync(join(RUNS, RUN), { recursive: true, force: true });
console.log(results.join("\n"));
