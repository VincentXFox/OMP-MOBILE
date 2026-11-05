/**
 * Доверенная проверка приёмки.
 *
 * Локальный JSON, слово «профиль» в isolation и строка нужной длины в MAC ничего
 * не удостоверяют: подпись аттестата знает только демон `omp-verifier` (отдельный
 * uid, ключ недоступен исполнителю). Здесь два независимых условия:
 *
 *  1) демон подтверждает сертификат проекта (операция `check`, конечный таймаут);
 *  2) предмет проверки не изменился: хеш содержимого материалов совпадает с тем,
 *     что был при подтверждении. Любая правка исходников, плана или результата
 *     меняет хеш и снимает одобрение.
 *
 * Недоступность демона, таймаут и ошибка протокола означают «не подтверждено».
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

const RUNS_DIR = join(homedir(), ".omp", "goldfish", "runs");
const VERIFIER_SOCKET = process.env.OMP_VERIFIER_SOCKET ?? "/run/omp-verifier/verify.sock";
const TIMEOUT_MS = 2000;

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export interface ManifestEntry {
	path: string;
	kind: "file" | "dir" | "missing" | "unreadable" | "symlink";
	size: number;
	sha256: string | null;
}

export interface Manifest {
	entries: ManifestEntry[];
	/** Файл обязателен, но не прочитан: проверка неполная. */
	problems: string[];
	/** Хеш манифеста: пути + размеры + содержимое. */
	digest: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".omp"]);

/**
 * Манифест материалов проверки. Глубина не ограничена: раньше обход молча
 * обрывался на четвёртом уровне и правка глубокого файла не меняла хеш.
 * Хешируется содержимое как байты, поэтому переименование, добавление и
 * удаление файлов тоже меняют digest.
 */
export function materialsManifest(paths: readonly string[]): Manifest {
	const entries: ManifestEntry[] = [];
	const problems: string[] = [];
	const walk = (path: string, viaSymlink: boolean): void => {
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch {
			entries.push({ path, kind: "missing", size: 0, sha256: null });
			problems.push(`${path}: отсутствует`);
			return;
		}
		if (stat.isSymbolicLink()) {
			// Симлинк не раскрываем: иначе предмет подменяется по ссылке незаметно.
			let target = "";
			try {
				target = realpathSync(path);
			} catch {
				target = "?";
			}
			entries.push({ path, kind: "symlink", size: stat.size, sha256: sha256(target) });
			if (!viaSymlink) problems.push(`${path}: символическая ссылка → ${target}`);
			return;
		}
		if (stat.isDirectory()) {
			entries.push({ path, kind: "dir", size: 0, sha256: null });
			let names: string[] = [];
			try {
				names = readdirSync(path).sort();
			} catch {
				problems.push(`${path}: каталог не читается`);
				return;
			}
			for (const name of names) {
				if (SKIP_DIRS.has(name)) continue;
				walk(join(path, name), false);
			}
			return;
		}
		try {
			const bytes = readFileSync(path);
			entries.push({ path, kind: "file", size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
		} catch {
			entries.push({ path, kind: "unreadable", size: stat.size, sha256: null });
			problems.push(`${path}: не читается`);
		}
	};
	for (const path of [...paths].sort()) walk(path.startsWith("/") ? normalize(path) : resolve(path), false);
	const digest = sha256(entries.map((e) => `${e.path}|${e.kind}|${e.size}|${e.sha256 ?? "-"}`).join("\n")).slice(0, 32);
	return { entries, problems, digest };
}

/** Совместимость: прежний вызов возвращает digest манифеста. */
export function materialsDigest(paths: readonly string[]): string {
	return materialsManifest(paths).digest;
}

/** Прогоны Goldfish: PASS по нужной стадии, материалы которых лежат внутри проекта. */
function runsForProject(project: string, stage: "plan" | "result"): Array<{ runId: string; materials: string[]; task: string }> {
	const out: Array<{ runId: string; materials: string[]; task: string }> = [];
	let names: string[] = [];
	try {
		names = readdirSync(RUNS_DIR).sort().reverse().slice(0, 200);
	} catch {
		return out;
	}
	const root = normalize(project);
	const inside = (path: string): boolean => {
		const abs = normalize(isAbsolute(path) ? path : join(root, path));
		return abs === root || abs.startsWith(`${root}/`);
	};
	for (const name of names) {
		try {
			const result = JSON.parse(readFileSync(join(RUNS_DIR, name, "result.json"), "utf8")) as { stage?: string; verdict?: string };
			if (result.stage !== stage || result.verdict !== "PASS") continue;
			const packet = JSON.parse(readFileSync(join(RUNS_DIR, name, "packet.json"), "utf8")) as { materials?: unknown; task?: unknown };
			const materials = Array.isArray(packet.materials) ? packet.materials.filter((m): m is string => typeof m === "string") : [];
			const task = typeof packet.task === "string" ? packet.task : "";
			// Чужой прогон не закрывает проверку: все материалы должны быть внутри проекта.
			if (materials.length === 0 || !materials.every(inside)) continue;
			out.push({ runId: name, materials, task });
		} catch {
			continue;
		}
	}
	return out;
}

/** Сертификат проекта: каталог приёмки с подписанным сертификатом. */
export function projectSlugs(project: string): string[] {
	try {
		return readdirSync(join(project, ".omp", "gate"))
			.filter((name) => existsSync(join(project, ".omp", "gate", name, "certificate.json")))
			.map((name) => name);
	} catch {
		return [];
	}
}

async function askVerifier(project: string, slug: string): Promise<{ ok: boolean; detail: string }> {
	try {
		const response = await fetch("http://verifier/", {
			method: "POST",
			body: JSON.stringify({ action: "check", project, slug }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
			...(typeof Bun !== "undefined" ? { unix: VERIFIER_SOCKET } : {}),
		} as RequestInit & { unix?: string });
		if (!response.ok) return { ok: false, detail: `верификатор ответил ${response.status}` };
		const body = (await response.json()) as { ok?: boolean; detail?: string };
		return { ok: body.ok === true, detail: body.detail ?? "нет пояснения" };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { ok: false, detail: `верификатор недоступен: ${text.slice(0, 120)}` };
	}
}

export interface VerificationResult {
	ok: boolean;
	reason: string;
	slug: string | null;
	runId: string | null;
	subjectHash: string | null;
}

/** Полная проверка: прогон по проекту + подпись демона + неизменность предмета. */
export async function verifyAcceptance(
	project: string,
	stage: "plan" | "result",
	materials: readonly string[],
): Promise<VerificationResult> {
	const runs = runsForProject(project, stage);
	if (runs.length === 0) return { ok: false, reason: "нет PASS-прогона Goldfish по материалам этого проекта", slug: null, runId: null, subjectHash: null };
	const slugs = projectSlugs(project);
	if (slugs.length === 0) return { ok: false, reason: "в проекте нет сертификата приёмки", slug: null, runId: null, subjectHash: null };
	const current = materialsDigest(materials);
	let lastDetail = "ни один сертификат не подтверждён";
	for (const slug of slugs) {
		const checked = await askVerifier(project, slug);
		if (!checked.ok) {
			lastDetail = checked.detail;
			continue;
		}
		const run = runs[0];
		return { ok: true, reason: `подтверждено демоном (${checked.detail}), прогон ${run.runId}`, slug, runId: run.runId, subjectHash: current };
	}
	return { ok: false, reason: lastDetail, slug: slugs[0] ?? null, runId: null, subjectHash: null };
}

/** Проверка уже выданного одобрения: предмет не должен измениться. */
export function stillValid(state: { subjectHash: string | null; stage: "plan" | "result"; project: string; slug: string }, materials: readonly string[]): { ok: boolean; reason: string } {
	if (state.subjectHash === null) return { ok: false, reason: "одобрение без привязки к предмету" };
	const current = materialsDigest(materials);
	if (current !== state.subjectHash) return { ok: false, reason: "материалы изменились после проверки" };
	return { ok: true, reason: "предмет не менялся" };
}


/** Метка подлинности: объект, созданный ТОЛЬКО этой функцией. Локальный JSON её не воспроизводит. */
const PROOF = Symbol("acceptance-proof");

export interface AcceptanceProof {
	readonly [PROOF]: true;
	project: string;
	stage: "plan" | "result";
	runId: string;
	subjectHash: string;
	/** Хеш задачи, к которой относится свидетельство. */
	taskHash: string | null;
	at: string;
}

/** Настоящее свидетельство может создать только verifyAcceptance в этом процессе. */
export function isAcceptanceProof(value: unknown): value is AcceptanceProof {
	return typeof value === "object" && value !== null && (value as { [PROOF]?: true })[PROOF] === true;
}

/**
 * Приёмка для гейтов. Возвращает свидетельство только при выполнении всех условий:
 * прогон PASS по материалам проекта, живой ответ демона и совпадение манифеста
 * с текущим содержимым. Локальный acceptance.json доказательством не считается.
 */
export async function proofForProject(
	project: string,
	stage: "plan" | "result",
	taskText?: string,
): Promise<{ proof: AcceptanceProof | null; reason: string }> {
	const runs = runsForProject(project, stage);
	if (runs.length === 0) return { proof: null, reason: "нет PASS-прогона Goldfish по материалам этого проекта" };
	const slugs = projectSlugs(project);
	if (slugs.length === 0) return { proof: null, reason: "в проекте нет сертификата приёмки" };
	// Свидетельство должно относиться к ЭТОЙ задаче: чужой прогон не закрывает работу,
	// даже если сертификат проекта действителен.
	const wanted = typeof taskText === "string" && taskText.trim() !== "" ? sha256(taskText.trim()) : null;
	const run = wanted === null ? runs[0] : runs.find((candidate) => sha256(candidate.task.trim()) === wanted) ?? null;
	if (run === null) {
		return { proof: null, reason: "нет PASS-прогона именно по этой задаче (свидетельство относится к другой)" };
	}
	const manifest = materialsManifest(run.materials);
	// Сверка с манифестом ПРОВЕРЕННОЙ версии: если файл изменился после ревью,
	// одобрение снимается, а не переиздаётся по текущему состоянию.
	try {
		const recorded = JSON.parse(readFileSync(join(RUNS_DIR, run.runId, "materials.json"), "utf8")) as {
			files?: Array<{ path?: unknown; size?: unknown; sha256?: unknown }>;
		};
		const files = Array.isArray(recorded.files) ? recorded.files : [];
		if (files.length === 0) return { proof: null, reason: "в прогоне нет манифеста проверенной версии" };
		// Сверяем пофайлово: формулы сводного хеша у прогона и у проверки разные,
		// а набор «путь | размер | sha256» — общий язык.
		const now = new Map(manifest.entries.filter((e) => e.kind === "file").map((e) => [e.path, `${e.size}|${e.sha256}`]));
		for (const file of files) {
			const path = String(file.path ?? "");
			const expected = `${file.size}|${file.sha256}`;
			const current = now.get(path);
			if (current === undefined) return { proof: null, reason: `материал ${path} больше не читается — проверка неполна` };
			if (current !== expected) return { proof: null, reason: `материал ${path} изменился после проверки — нужно новое ревью` };
		}
	} catch {
		return { proof: null, reason: "манифест проверенной версии недоступен" };
	}
	if (manifest.problems.length > 0) {
		return { proof: null, reason: `материалы проверки неполны: ${manifest.problems.slice(0, 3).join("; ")}` };
	}
	let lastReason = "сертификат не подтверждён";
	for (const slug of slugs) {
		const checked = await askVerifier(project, slug);
		if (!checked.ok) {
			lastReason = checked.detail;
			continue;
		}
		return {
			proof: {
			[PROOF]: true,
			project,
			stage,
			runId: run.runId,
			subjectHash: manifest.digest,
			taskHash: wanted,
			at: new Date().toISOString(),
		},
			reason: `подтверждено демоном (${checked.detail}), прогон ${run.runId}, манифест ${manifest.digest}`,
		};
	}
	return { proof: null, reason: lastReason };
}
