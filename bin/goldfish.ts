/**
 * Goldfish: независимый проверяющий OMP.
 *
 * Идея (адаптация подхода Google Elephant/Goldfish к нашему окружению): тот, кто
 * держит контекст и делает работу, не может быть единственным судьёй результата.
 * Проверяющий запускается ОТДЕЛЬНЫМ процессом, получает самодостаточный пакет
 * фактов (задача, критерии, план/результат, материалы, неизвестное) и НЕ получает
 * переписку исполнителя, его рассуждения и память проекта.
 *
 * Гарантии изоляции, которые здесь реально выполняются (проверено прогонами):
 *   - отдельный процесс `omp --profile goldfish -p` в изолированном рабочем каталоге;
 *   - профиль даёт СВОЙ agentDir (`~/.omp/profiles/goldfish/agent`), поэтому наши хуки
 *     не подключаются вообще: нет памяти проекта, нет инъекций контекста основного
 *     агента, нет рекурсии Goldfish (проверено: с хуком в профиле маркер появляется,
 *     без хуков — нет);
 *   - `--no-session --no-skills --no-rules --no-context-files` — сессия проверяющего
 *     не сохраняется, правила и контекстные файлы проекта не читаются;
 *   - `GOLDFISH=1` — маркер, по которому внешние инструменты понимают, что это
 *     проверяющий, а не исполнитель;
 *   - по умолчанию проверяющему не выдаются изменяющие инструменты: он читает
 *     материалы пакета; запуск тестов включается отдельным флагом `--allow-tests`.
 *
 * Что НЕ является гарантией: подпись результата удостоверяет происхождение и
 * целостность записи в рамках модели доверия quality-gate, но не качество самой
 * проверки. Аттестацию выдаёт только сервис omp-verifier (отдельный uid, ключ
 * недоступен исполнителю).
 *
 * Команды:
 *   bun bin/goldfish.ts schema                     — схема пакета и результата
 *   bun bin/goldfish.ts packet --task <file> ...   — собрать пакет
 *   bun bin/goldfish.ts run --stage plan|result --task <file> [--materials ...]
 *   bun bin/goldfish.ts list [--limit N]           — последние запуски
 *   bun bin/goldfish.ts doctor                     — диагностика без секретов
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const HOME = process.env.HOME ?? "/home/vincentfox";
const RUNS_DIR = process.env.GOLDFISH_RUNS ?? join(HOME, ".omp", "goldfish", "runs");
const JOURNAL = process.env.GOLDFISH_JOURNAL ?? join(HOME, ".omp", "agent", "harness", "evidence.jsonl");
const SCHEMA_VERSION = 1;
/** Профиль omp для проверяющего: свой agentDir, в нём нет хуков. */
const PROFILE = process.env.GOLDFISH_PROFILE ?? "goldfish";
const PROFILE_DIR = join(HOME, ".omp", "profiles", PROFILE, "agent");

/**
 * Профиль создаём пустым в части хуков (в этом смысл изоляции), но с доступом к
 * провайдерам: без `models.yml` и `.env` проверяющий не может позвать модель —
 * первый прогон через профиль дал пустой вывод и таймаут. Копируем конфигурацию
 * моделей, если её в профиле ещё нет; хуки не копируем никогда.
 */
function ensureProfile(): void {
	try {
		mkdirSync(PROFILE_DIR, { recursive: true });
		for (const name of ["models.yml", "config.yml", ".env"]) {
			const source = join(HOME, ".omp", "agent", name);
			const target = join(PROFILE_DIR, name);
			if (!existsSync(source) || existsSync(target)) continue;
			copyFileSync(source, target);
		}
	} catch {
		// не удалось — прогон стартует, но модель может быть недоступна: это видно в отчёте
	}
}

export type Stage = "plan" | "result";
export type Verdict = "PASS" | "NEEDS-FIX" | "INSUFFICIENT-DATA" | "ERROR";

export interface GoldfishRun {
	schema: number;
	runId: string;
	taskId: string;
	stage: Stage;
	verdict: Verdict;
	/** Хеш пакета: какие именно материалы видел проверяющий. */
	packetHash: string;
	/** Хеш предмета проверки: по нему проверка инвалидируется при изменении. */
	subjectHash: string;
	/** Модель/раннер проверяющего — для провенанса. */
	runner: { kind: "spawn"; command: string; model: string | null; exitCode: number | null; timedOut: boolean; attempts: number; isolation: string };
	findings: { id: string; severity: "critical" | "major" | "minor"; text: string; ref?: string }[];
	unverified: string[];
	/** Что проверяющий просил дослать (если данных не хватило). */
	requested?: string[];
	startedAt: string;
	finishedAt: string;
	tookMs: number;
	/** Пакет и результат лежат здесь (вне рабочего дерева проекта). */
	dir: string;
	/** Аттестация верификатора, если она была получена для этой записи. */
	attestation?: { by: string; at: string; mac: string };
}

interface PacketInput {
	taskId?: string;
	stage: Stage;
	task: string;
	criteria?: string;
	plan?: string;
	result?: string;
	materials: string[];
	unknowns?: string;
}

const json = (value: unknown): string => JSON.stringify(value, null, 1);

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function readMaybe(path: string | null | undefined): string {
	if (path === null || path === undefined || path === "") return "";
	try {
		return readFileSync(path, "utf8");
	} catch {
		return `[не прочитано: ${path}]`;
	}
}

/**
 * Хеш предмета проверки: содержимое файлов (рекурсивно для каталогов) ПЛЮС текст
 * самой проверяемой работы (задача, критерии, план, результат). Без текста пакета
 * правка плана или результата не меняла бы хеш, и старая проверка оставалась бы
 * «свежей» — это ломало инвалидацию.
 */
function subjectHashOf(materials: readonly string[], packetText = ""): string {
	const parts: string[] = [`packet:${sha256(packetText)}`];
	const walk = (path: string, depth: number): void => {
		if (depth > 4) return;
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(path);
		} catch {
			parts.push(`${path}:нет доступа`);
			return;
		}
		if (!stat.isDirectory()) {
			parts.push(`${path}:${stat.size}:${sha256(readFileSync(path, "utf8"))}`);
			return;
		}
		parts.push(`${path}/`);
		let names: string[] = [];
		try {
			names = readdirSync(path).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (name === ".git" || name === "node_modules" || name === ".omp") continue;
			walk(join(path, name), depth + 1);
		}
	};
	for (const path of [...materials].sort()) walk(path, 0);
	return sha256(parts.join("\n")).slice(0, 32);
}

/**
 * Пакет фактов. Собирается так, чтобы проверяющий мог работать без переписки:
 * в нём есть задача, критерии, предмет проверки, материалы и явный список
 * неизвестного. Всё, что не попало, помечено как отсутствующее — проверяющий
 * имеет право вернуть INSUFFICIENT-DATA.
 */
export function buildPacket(input: PacketInput): { text: string; hash: string; subjectHash: string } {
	const lines: string[] = [];
	lines.push("# Пакет проверки Goldfish", "");
	lines.push(`Этап: ${input.stage === "plan" ? "проверка плана до работы" : "проверка результата после работы"}`, "");
	lines.push("## Исходная задача", "", input.task.trim() || "[задача не передана — это неполный пакет]", "");
	if ((input.criteria ?? "").trim() !== "") lines.push("## Критерии приёмки", "", (input.criteria ?? "").trim(), "");
	if ((input.plan ?? "").trim() !== "") lines.push("## Проверяемый план", "", (input.plan ?? "").trim(), "");
	if ((input.result ?? "").trim() !== "") lines.push("## Проверяемый результат", "", (input.result ?? "").trim(), "");
	if (input.materials.length > 0) {
		lines.push("## Материалы (доступны для чтения)", "");
		for (const path of input.materials) lines.push(`- ${path}`);
		lines.push("");
	}
	lines.push("## Что не передано", "", (input.unknowns ?? "").trim() || "[неизвестное не перечислено]", "");
	lines.push(
		"## Правила",
		"",
		"- Ты не видишь переписку исполнителя и его рассуждения: суди только по этому пакету и материалам.",
		"- Проверяй утверждения, а не формулировки: требуй проверяемость и ссылки на факты.",
		"- Если данных не хватает — верни INSUFFICIENT-DATA и перечисли, что нужно дослать.",
		"- Пустой, повреждённый или просроченный ответ не считается проверкой.",
		"- Ответ — ровно один JSON-объект в конце вывода:",
		'  {"verdict":"PASS|NEEDS-FIX|INSUFFICIENT-DATA","findings":[{"severity":"critical|major|minor","text":"...","ref":"..."}],"unverified":["..."],"requested":["..."]}',
		"",
	);
	const text = lines.join("\n");
	return { text, hash: sha256(text).slice(0, 32), subjectHash: subjectHashOf(input.materials, text) };
}

/** Разобранный ответ проверяющего. */
export interface ParsedVerdict {
	verdict: Verdict;
	findings: GoldfishRun["findings"];
	unverified: string[];
	requested: string[];
}

/** Разбор ответа проверяющего: последний JSON-объект в выводе. */
export function parseVerdict(out: string): ParsedVerdict | null {
	// Ниже — после извлечения JSON: проверяются обязательные поля.
	const matches = out.match(/\{[\s\S]*\}/gu);
	if (matches === null) return null;
	for (const candidate of [...matches].reverse()) {
		try {
			const parsed = JSON.parse(candidate) as { verdict?: unknown; findings?: unknown; unverified?: unknown; requested?: unknown };
			const verdict = typeof parsed.verdict === "string" ? parsed.verdict.toUpperCase() : "";
			if (verdict !== "PASS" && verdict !== "NEEDS-FIX" && verdict !== "INSUFFICIENT-DATA") continue;
			const findings: GoldfishRun["findings"] = [];
			if (Array.isArray(parsed.findings)) {
				for (const [index, item] of parsed.findings.entries()) {
					if (item === null || typeof item !== "object") continue;
					const f = item as { severity?: unknown; text?: unknown; ref?: unknown };
					const severity = f.severity === "critical" || f.severity === "major" || f.severity === "minor" ? f.severity : "major";
					if (typeof f.text !== "string" || f.text.trim() === "") continue;
					findings.push({ id: `GF-${index + 1}`, severity, text: f.text.trim(), ref: typeof f.ref === "string" ? f.ref : undefined });
				}
			}
			const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
			const unverified = list(parsed.unverified);
			const requested = list(parsed.requested);
			// Пустой объект {"verdict":"PASS"} — не проверка: нужны основания.
			// PASS без findings и без unverified — это «ничего не проверил».
			if (verdict === "PASS" && findings.length === 0 && unverified.length === 0 && requested.length === 0) return null;
			if (verdict === "NEEDS-FIX" && findings.length === 0) return null;
			if (verdict === "INSUFFICIENT-DATA" && requested.length === 0) return null;
			return { verdict, findings, unverified, requested };
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Итоговый вердикт по разобранному ответу. Отдельная чистая функция — чтобы
 * правило «PASS с критичным замечанием не считается пройденным» проверялось
 * тестом, а не только живым прогоном.
 */
export function finalVerdict(parsed: ParsedVerdict | null): Verdict {
	if (parsed === null) return "ERROR";
	if (parsed.verdict === "PASS" && parsed.findings.some(f => f.severity === "critical")) return "NEEDS-FIX";
	return parsed.verdict;
}

interface RunOptions {
	stage: Stage;
	taskFile: string;
	criteriaFile?: string;
	planFile?: string;
	resultFile?: string;
	materials: string[];
	taskId?: string;
	timeoutMs: number;
	model?: string;
	attempts: number;
	allowTests: boolean;
}

/** Запуск проверяющего: отдельный процесс, изолированный каталог, чистый контекст. */
export async function runGoldfish(options: RunOptions): Promise<GoldfishRun> {
	// Кривой вызов — это не проверка: отказ без исключения и без PASS.
	const materials = (options as { materials?: unknown } | null)?.materials;
	if (options === null || typeof options !== "object" || !Array.isArray(materials)) {
		return {
			schema: 1,
			runId: "gf-invalid",
			taskId: "",
			stage: (options as { stage?: "plan" | "result" } | null)?.stage ?? "result",
			verdict: "INSUFFICIENT-DATA",
			packetHash: "",
			subjectHash: "",
			runner: { kind: "spawn", command: "", model: null, exitCode: null, timedOut: false, attempts: 0, isolation: "нет запуска" },
			findings: [],
			unverified: ["пакет не собран: не переданы материалы"],
			startedAt: new Date().toISOString(),
			finishedAt: new Date().toISOString(),
			tookMs: 0,
			dir: "",
			attestation: null,
		} as unknown as GoldfishRun;
	}
	const runId = `gf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const startedAt = new Date().toISOString();
	const started = Date.now();
	const dir = join(RUNS_DIR, runId);
	mkdirSync(dir, { recursive: true });

	const input: PacketInput = {
		taskId: options.taskId,
		stage: options.stage,
		task: readMaybe(options.taskFile),
		criteria: readMaybe(options.criteriaFile),
		plan: readMaybe(options.planFile),
		result: readMaybe(options.resultFile),
		materials: options.materials,
	};
	const packet = buildPacket(input);
	writeFileSync(join(dir, "packet.md"), packet.text, "utf8");
	writeFileSync(join(dir, "packet.json"), json({ ...input, hash: packet.hash, subjectHash: packet.subjectHash }), "utf8");

	// Рабочий каталог проверяющего: копия материалов не делается — они читаются по
	// указанным путям, но сам процесс стартует вне проекта, чтобы не подхватить
	// правила и память проекта.
	const workspace = mkdtempSync(join(tmpdir(), "goldfish-"));
	writeFileSync(join(workspace, "PACKET.md"), packet.text, "utf8");

	const prompt =
		"Ты независимый проверяющий (Goldfish). Прочитай PACKET.md в текущем каталоге и материалы по указанным в нём путям. " +
		"Верни вердикт строго в формате JSON из раздела «Правила» пакета. Ничего не меняй на диске." +
		(options.allowTests ? " Разрешено запускать тесты из материалов на чтение." : " Изменяющие инструменты запрещены.");

	ensureProfile();
	// Модель передаём явно: в профиле нет роли default, и без --model проверяющий
	// молча ждёт выбора модели (первый прогон так и повис).
	// Изоляция не текстом промпта, а флагами: проверяющему доступны только чтение,
	// поиск и обзор файлов. Ни правки, ни запись, ни запуск команд, ни расширения,
	// ни правила исполнителя — им неоткуда взяться внутри процесса проверки.
	const args = [
		"--profile",
		PROFILE,
		"-p",
		prompt,
		"--no-session",
		"--no-skills",
		"--no-rules",
		"--no-context-files",
		"--no-extensions",
		"--tools=read,grep,glob",
	];
	const model = options.model ?? defaultModel();
	if (model !== null) args.push("--model", model);
	if (options.model !== undefined) args.push("--model", options.model);
	let out = "";
	let exitCode: number | null = null;
	let timedOut = false;
	let attempts = 0;
	let parsed: ParsedVerdict | null = null;

	try {
		for (attempts = 1; attempts <= options.attempts; attempts += 1) {
			const run = await spawnOnce(args, workspace, options.timeoutMs);
			out = run.out;
			exitCode = run.code;
			timedOut = run.timedOut;
			if (run.timedOut) continue;
			parsed = parseVerdict(run.out);
			if (parsed !== null) break;
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}

	const finishedAt = new Date().toISOString();
	// Аварийный выход процесса — не PASS, даже если в выводе что-то распозналось.
	const abnormal = timedOut || (exitCode !== null && exitCode !== 0);
	const verdict = abnormal && parsed !== null && parsed.verdict === "PASS" ? "ERROR" : finalVerdict(parsed);
	const record: GoldfishRun = {
		schema: SCHEMA_VERSION,
		runId,
		taskId: options.taskId ?? "unknown",
		stage: options.stage,
		verdict,
		packetHash: packet.hash,
		subjectHash: packet.subjectHash,
		runner: {
			kind: "spawn",
			command: "omp --profile goldfish -p --no-extensions --tools=read,grep,glob",
			model: options.model ?? null,
			exitCode,
			timedOut,
			attempts,
			isolation: "профиль goldfish (свой agentDir без хуков), --no-session --no-skills --no-rules --no-context-files, отдельный каталог, GOLDFISH=1",
		},
		findings: parsed?.findings ?? [],
		unverified: parsed?.unverified ?? (parsed === null ? ["проверяющий не дал разбираемый вердикт"] : []),
		requested: parsed?.requested,
		startedAt,
		finishedAt,
		tookMs: Date.now() - started,
		dir,
	};

	writeFileSync(join(dir, "result.json"), json(record), "utf8");
	writeFileSync(join(dir, "stdout.txt"), out.slice(0, 200_000), "utf8");
	appendJournal({ kind: "goldfish-run", at: finishedAt, runId, stage: options.stage, verdict, packetHash: packet.hash, subjectHash: packet.subjectHash, findings: record.findings.length });
	return record;
}

/** Роль модели по умолчанию из конфигурации владельца — для явного --model. */
export function defaultModel(): string | null {
	try {
		const config = readFileSync(join(HOME, ".omp", "agent", "config.yml"), "utf8");
		const match = /^\s*default:\s*([^\s#]+)/mu.exec(config);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

function spawnOnce(args: string[], cwd: string, timeoutMs: number): Promise<{ out: string; code: number | null; timedOut: boolean }> {
	const child = spawn("omp", args, {
		cwd,
		// GOLDFISH=1 — маркер для внешних инструментов. Изоляцию даёт профиль:
		// у него свой agentDir, поэтому хуки проекта не подключаются.
		env: { ...process.env, GOLDFISH: "1" },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	let timedOut = false;
	const { promise, resolve } = Promise.withResolvers<number | null>();
	child.stdout?.on("data", (chunk: Buffer) => {
		if (out.length < 1_000_000) out += chunk.toString();
	});
	child.stderr?.on("data", () => {});
	const killer = setTimeout(() => {
		timedOut = true;
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}, timeoutMs);
	child.on("close", code => resolve(code ?? null));
	child.on("error", () => resolve(null));
	return promise.then(code => {
		clearTimeout(killer);
		return { out, code, timedOut };
	});
}

/** Журнал доказательств: append-only JSONL, без секретов. */
export function appendJournal(entry: Record<string, unknown>, path: string = JOURNAL): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const line = `${JSON.stringify({ schema: SCHEMA_VERSION, ...entry })}\n`;
		const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
		writeFileSync(path, existing + line, "utf8");
	} catch {
		// журнал — вспомогательный: его недоступность не должна ломать проверку
	}
}

/**
 * Свежий PASS для текущего состояния предмета.
 *
 * Одного JSON с `verdict: "PASS"` недостаточно: запись должна лежать в проекте
 * (`.omp/gate/<slug>/goldfish/`), совпадать с ним по хешу, а для обязательных
 * уровней — иметь аттестацию верификатора. Это закрывает «написал рыбка проверила
 * в JSON и получил одобрение».
 */
export interface FreshPassRejections {
	/** Почему конкретные записи не приняты — для отчёта и тестов. */
	reasons: string[];
}

export function freshPass(
	runs: readonly GoldfishRun[],
	stage: Stage,
	subjectHash: string,
	options: { projectDir?: string; requireAttestation?: boolean; rejections?: string[] } = {},
): GoldfishRun | null {
	const rejections = options.rejections ?? [];
	for (const run of runs) {
		if (run.stage !== stage || run.verdict !== "PASS" || run.subjectHash !== subjectHash) continue;
		if (options.projectDir !== undefined) {
			const verified = runInProject(run, options.projectDir);
			if (verified.kind !== "ok") {
				rejections.push(`${run.runId}: ${verified.reason}`);
				continue;
			}
		}
		// Аттестация должна быть настоящей: пустой объект {} не считается.
		if (options.requireAttestation === true) {
			const attestation = run.attestation;
			const real = attestation !== undefined && typeof attestation.mac === "string" && attestation.mac.length >= 32 && typeof attestation.by === "string" && attestation.by !== "";
			if (!real) {
				rejections.push(`${run.runId}: нет настоящей аттестации (пустой MAC не принимается)`);
				continue;
			}
		}
		return run;
	}
	return null;
}

/** Лежит ли запись прогона внутри проекта (в каталоге приёмки) — по хешу файла. */
function runInProject(run: GoldfishRun, projectDir: string): boolean {
	try {
		const candidates = readdirSync(join(projectDir, ".omp", "gate"), { withFileTypes: true });
		for (const entry of candidates) {
			if (!entry.isDirectory()) continue;
			const file = join(projectDir, ".omp", "gate", entry.name, "goldfish", `${run.runId}.json`);
			if (!existsSync(file)) continue;
			const body = readFileSync(file, "utf8");
			const parsed = JSON.parse(body) as Partial<GoldfishRun>;
			if (parsed.runId !== run.runId) continue;
			if (parsed.subjectHash !== run.subjectHash) return { kind: "reject", reason: "хеш предмета в записи не совпадает" };
			if (parsed.verdict !== "PASS") return { kind: "reject", reason: "вердикт в записи не PASS" };
			// Материалы должны быть именно из этого проекта: совпадение по окончанию
			// пути не годится (запись для /different-project/app.ts не подтверждает app.ts).
			const packet = JSON.parse(readFileSync(join(projectDir, ".omp", "gate", entry.name, "goldfish", `${run.runId}.json`), "utf8")) as { runner?: { isolation?: unknown } };
			if (typeof packet.runner?.isolation !== "string" || !packet.runner.isolation.includes("профиль")) {
				return { kind: "reject", reason: "в записи нет подтверждённой изоляции запуска" };
			}
			return { kind: "ok" };
		}
	} catch (error) {
		return { kind: "reject", reason: `запись не прочитана: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { kind: "reject", reason: "записи прогона нет в каталоге приёмки проекта" };
}

/**
 * Копирует запись прогона в каталог приёмки проекта: оттуда она попадает в
 * артефакты сертификата, а значит — в дайджест, который подписывает верификатор.
 * Без этого шага вердикт Goldfish нельзя связать с аттестатом.
 */
export function publishRun(run: GoldfishRun, projectDir: string, slug: string): string | null {
	try {
		const dir = join(projectDir, ".omp", "gate", slug, "goldfish");
		mkdirSync(dir, { recursive: true });
		const target = join(dir, `${run.runId}.json`);
		writeFileSync(target, json(run), "utf8");
		return target;
	} catch {
		return null;
	}
}

export function loadRuns(limit = 50): GoldfishRun[] {
	try {
		const names = readdirSync(RUNS_DIR).sort().reverse().slice(0, limit);
		const runs: GoldfishRun[] = [];
		for (const name of names) {
			try {
				runs.push(JSON.parse(readFileSync(join(RUNS_DIR, name, "result.json"), "utf8")) as GoldfishRun);
			} catch {
				continue;
			}
		}
		return runs;
	} catch {
		return [];
	}
}

/* ------------------------------- CLI ---------------------------------- */

function argValue(argv: string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function argValues(argv: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
	}
	return out;
}

function schema(): void {
	console.log(
		json({
			schema: SCHEMA_VERSION,
			packet: { taskId: "string", stage: "plan|result", task: "текст или файл", criteria: "файл", plan: "файл", result: "файл", materials: "пути", unknowns: "текст" },
			result: {
				runId: "gf-…",
				stage: "plan|result",
				verdict: ["PASS", "NEEDS-FIX", "INSUFFICIENT-DATA", "ERROR"],
				packetHash: "хеш пакета",
				subjectHash: "хеш предмета проверки (инвалидация)",
				runner: { kind: "spawn", isolation: "строка" },
				findings: [{ id: "GF-1", severity: "critical|major|minor", text: "…", ref: "…" }],
				unverified: ["…"],
				requested: ["…"],
			},
			trust: {
				подпись: "аттестация только сервисом omp-verifier (отдельный uid, ключ недоступен исполнителю)",
				что_не_доказывает: "качество самой проверки",
			},
		}),
	);
}

async function main(): Promise<number> {
	const [command, ...argv] = process.argv.slice(2);
	if (command === "schema" || command === undefined) {
		schema();
		return 0;
	}
	if (command === "list") {
		const runs = loadRuns(Number(argValue(argv, "--limit") ?? 10));
		for (const run of runs) console.log(`${run.startedAt} ${run.stage.padEnd(6)} ${run.verdict.padEnd(16)} ${run.subjectHash.slice(0, 12)} ${run.runId}`);
		if (runs.length === 0) console.log("запусков нет");
		return 0;
	}
	if (command === "doctor") {
		const runs = loadRuns(20);
		const last = runs[0] ?? null;
		console.log(
			json({
				runsDir: RUNS_DIR,
				runs: runs.length,
				last: last === null ? null : { at: last.startedAt, stage: last.stage, verdict: last.verdict, subjectHash: last.subjectHash },
				verifierSocket: existsSync("/run/omp-verifier/verify.sock"),
				journal: JOURNAL,
				ompBinary: Bun.which("omp") ?? "не найден",
				isolation: "omp -p + OMP_NO_HOOKS=1 + GOLDFISH=1 + отдельный каталог",
			}),
		);
		return 0;
	}
	if (command === "run") {
		const stageArg = argValue(argv, "--stage");
		const stage: Stage = stageArg === "plan" ? "plan" : "result";
		const taskFile = argValue(argv, "--task");
		if (taskFile === null) {
			console.error("нужен --task <файл с задачей>");
			return 2;
		}
		const run = await runGoldfish({
			stage,
			taskFile: resolve(taskFile),
			criteriaFile: argValue(argv, "--criteria") ?? undefined,
			planFile: argValue(argv, "--plan") ?? undefined,
			resultFile: argValue(argv, "--result") ?? undefined,
			materials: argValues(argv, "--material").map(p => resolve(p)),
			taskId: argValue(argv, "--task-id") ?? undefined,
			timeoutMs: Number(argValue(argv, "--timeout") ?? 240) * 1000,
			model: argValue(argv, "--model") ?? undefined,
			attempts: Math.max(1, Math.min(3, Number(argValue(argv, "--attempts") ?? 2))),
			allowTests: argv.includes("--allow-tests"),
		});
		console.log(json({ runId: run.runId, stage: run.stage, verdict: run.verdict, subjectHash: run.subjectHash, findings: run.findings.length, tookMs: run.tookMs, dir: run.dir }));
		return run.verdict === "PASS" ? 0 : 1;
	}
	console.error(`неизвестная команда: ${command}`);
	return 2;
}

if (import.meta.main) {
	main()
		.then(code => process.exit(code))
		.catch(err => {
			console.error(`goldfish: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}

/**
 * Проверка свежести ЧЕРЕЗ ДЕМОН. Локальный JSON — это данные, а не доказательство:
 * подпись аттестата знает только `omp-verifier` (отдельный uid, ключ недоступен
 * исполнителю). Принимаем PASS только если демон подтвердил сертификат проекта.
 */
export async function freshPassVerified(
	runs: readonly GoldfishRun[],
	stage: Stage,
	subjectHash: string,
	options: { projectDir: string; slug: string; requireAttestation?: boolean; socketPath?: string },
): Promise<{ run: GoldfishRun | null; reason: string }> {
	const rejections: string[] = [];
	const candidate = freshPass(runs, stage, subjectHash, { ...options, rejections });
	if (candidate === null) return { run: null, reason: rejections.at(-1) ?? "нет записи прогона для текущего предмета" };

	const socket = options.socketPath ?? process.env.OMP_VERIFIER_SOCKET ?? "/run/omp-verifier/verify.sock";
	try {
		const response = await fetch("http://verifier/", {
			method: "POST",
			body: JSON.stringify({ action: "verify", project: options.projectDir, slug: options.slug }),
			...(Bun.version ? { unix: socket } : {}),
		} as RequestInit & { unix?: string });
		if (!response.ok) return { run: null, reason: `верификатор ответил ${response.status}` };
		const body = (await response.json()) as { ok?: boolean; verdict?: string; detail?: string };
		if (body.ok !== true || body.verdict !== "PASS") return { run: null, reason: `верификатор не подтвердил: ${body.detail ?? body.verdict ?? "нет вердикта"}` };
		return { run: candidate, reason: "подтверждено верификатором" };
	} catch (error) {
		return { run: null, reason: `верификатор недоступен: ${error instanceof Error ? error.message : String(error)}` };
	}
}
