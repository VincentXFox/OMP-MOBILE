/**
 * Журнал доказательств гейтов. Живёт рядом с хуками, а не в личном репозитории:
 * хуки не должны зависеть от конкретного расположения чужого проекта.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const JOURNAL = process.env.GM_EVIDENCE ?? join(homedir(), ".omp", "agent", "harness", "evidence.jsonl");

export function appendEvidence(entry: Record<string, unknown>, path: string = JOURNAL): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const line = `${JSON.stringify({ schema: 1, ...entry })}\n`;
		const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
		writeFileSync(path, existing + line, "utf8");
	} catch {
		// журнал вспомогательный: его недоступность не должна ломать проверку
	}
}
