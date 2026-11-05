/**
 * Регрессия межпроцессного замка: два процесса под одним замком не теряют счётчики.
 * Замок общий для хука и раннера наблюдателя, поэтому потеря счётчиков ломает
 * и порог шагов, и очередь заметок.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Интерпретатор берётся из process.execPath: в PATH мини-ПК bun не установлен,
// и жёсткая строка "bun" роняла тест ENOENT вместо проверки замка.
const LOCK = join(import.meta.dir, "..", "lib", "lock.ts");

const ROOT = join(tmpdir(), `ysn-lock-${process.pid}`);
const WORKER = join(ROOT, "worker.ts");
const COUNTER = join(ROOT, "counter.txt");
const ITER = 60;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("два процесса не теряют счётчики", async () => {
	mkdirSync(ROOT, { recursive: true });
	writeFileSync(
		WORKER,
		`import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { withFileLock } from ${JSON.stringify(LOCK)};
const file = process.argv[2];
for (let i = 0; i < ${ITER}; i += 1) {
	await withFileLock(file + ".lock", () => {
		const value = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
		writeFileSync(file, String(value + 1));
	});
}
`,
	);
	const run = () => Bun.spawn([process.execPath, WORKER, COUNTER], { stdout: "ignore", stderr: "ignore" }).exited;
	await Promise.all([run(), run()]);
	expect(Number(readFileSync(COUNTER, "utf8"))).toBe(ITER * 2);
}, 60_000);
