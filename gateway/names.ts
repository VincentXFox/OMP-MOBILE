import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * User-facing agent/chat display names keyed by omp sessionId.
 * instanceId is volatile (new process ⇒ new id); sessionId survives resume and
 * gateway restarts, so it is the only stable key for «человек назвал кириллицей».
 * Здесь хранится пользовательская строка для UI, независимо от имени панели.
 */
const NAMES_FILE = join(new URL(".", import.meta.url).pathname, "agent-names.json");

interface NameRecord {
	name: string;
	cwd: string | null;
	updatedAt: number;
}

const MAX_NAME_CHARS = 64;
let loaded = false;
const names = new Map<string, NameRecord>();

function load(): void {
	if (loaded) return;
	loaded = true;
	try {
		const parsed: unknown = JSON.parse(readFileSync(NAMES_FILE, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
		for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
			// Формат файла — объекты {name, cwd, updatedAt}; старый — голые строки.
			// Раньше читались только строки, и все имена терялись при каждом
			// рестарте шлюза (сессии снова показывались под авто-тайтлом omp).
			if (typeof value === "string") {
				const legacy = cleanName(value);
				if (legacy !== null) names.set(sessionId, { name: legacy, cwd: null, updatedAt: 0 });
				continue;
			}
			if (value === null || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") continue;
			const name = cleanName(value.name);
			if (name === null) continue;
			const cwd = "cwd" in value && typeof value.cwd === "string" ? value.cwd : null;
			const updatedAt = "updatedAt" in value && typeof value.updatedAt === "number" ? value.updatedAt : 0;
			names.set(sessionId, { name, cwd, updatedAt });
		}
	} catch {
		// no file yet — fresh store
	}
}

function persist(): void {
	try {
		mkdirSync(dirname(NAMES_FILE), { recursive: true });
		const out: Record<string, NameRecord> = {};
		for (const [sessionId, rec] of names) out[sessionId] = rec;
		const tmp = `${NAMES_FILE}.tmp`;
		writeFileSync(tmp, JSON.stringify(out, null, "\t"));
		renameSync(tmp, NAMES_FILE);
	} catch {
		// best-effort: display names survive only until next successful save
	}
}

function cleanName(raw: string): string | null {
	const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
	return name.length > 0 ? name : null;
}

/** Explicit user-set display name for a session, or null when never renamed. */
export function displayName(sessionId: string): string | null {
	if (typeof sessionId !== "string" || sessionId.length === 0) return null;
	load();
	return names.get(sessionId)?.name ?? null;
}

/** Store a user rename; null name removes the override (back to omp title). */
export function setDisplayName(sessionId: string, rawName: string, cwd: string | null): void {
	if (typeof sessionId !== "string" || sessionId.length === 0) return;
	load();
	const name = rawName === null ? null : cleanName(rawName);
	if (name === null) {
		if (names.delete(sessionId)) persist();
		return;
	}
	names.set(sessionId, { name, cwd, updatedAt: Date.now() });
	persist();
}
