import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasFreshPass } from "../pre/grandmaster-goldfish.ts";

const RUNS = join(homedir(), ".omp", "goldfish", "runs");
const DIR = join(RUNS, "probe-regression-1");

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function seed(materials: string[]): void {
	mkdirSync(DIR, { recursive: true });
	writeFileSync(join(DIR, "result.json"), JSON.stringify({ stage: "result", verdict: "PASS", finishedAt: new Date().toISOString() }));
	writeFileSync(join(DIR, "packet.json"), JSON.stringify({ materials }));
}

test("чужой проект с тем же именем файла не закрывает проверку", () => {
	seed(["/different-project/app.ts"]);
	expect(hasFreshPass("result", ["/home/vincentfox/OMP/omp/app.ts"])).toBe(false);
});

test("точное совпадение пути проверку закрывает", () => {
	seed(["/home/vincentfox/OMP/omp/app.ts"]);
	expect(hasFreshPass("result", ["/home/vincentfox/OMP/omp/app.ts"])).toBe(true);
});

test("пустой список изменённых путей требует любой свежий PASS", () => {
	seed(["/anywhere/x.ts"]);
	expect(hasFreshPass("result", [])).toBe(true);
});
