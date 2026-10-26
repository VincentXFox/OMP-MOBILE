#!/usr/bin/env bun
/**
 * policy — движок полномочий: класс риска → решение allow | confirm | deny.
 *
 * Правила живут в ~/.omp/policy.json (вне проекта, правится владельцем), а не в
 * системном промпте. Исполнитель спрашивает решение у этого модуля, а не «помнит»
 * границы: тогда обойти их формулировкой нельзя.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Decision = "allow" | "confirm" | "deny";

export interface Policy {
	/** Явно запрещённое: не «подтвердить», а именно нельзя. */
	deny: string[];
	/** Обратимое и ограниченное: агент делает сам. */
	allow: string[];
	/** Требует подтверждения владельца/пользователя. */
	confirm: string[];
}

const POLICY_PATH = process.env.OMP_POLICY ?? join(homedir(), ".omp", "policy.json");

const DEFAULTS: Policy = {
	deny: [
		"rm\\s+-rf\\s+/(?:\\s|$)",
		"mkfs\\.",
		"dd\\s+of=/dev/",
		"drop\\s+database",
		"truncate\\s+table",
		"git\\s+push[^\\n]{0,40}(?:--force|-f)\\b",
		":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\}\\s*;:",
	],
	allow: [
		"^(?:git\\s+(?:status|log|diff|show|rev-parse)|ls|cat|head|tail|grep|rg|wc|stat|file)\\b",
		"^(?:bun|npm|yarn)\\s+(?:test|run|install|build|x)\\b",
		"^(?:curl|wget)\\s+-s",
		"^systemctl\\s+(?:--user\\s+)?(?:status|is-active|is-enabled)\\b",
		"^(?:ps|pgrep|ss|df|du|free|uptime|journalctl)\\b",
		"^curl\\s+-s.*(?:127\\.0\\.0\\.1|localhost)",
	],
	confirm: [
		"(?:^|\\s)rm\\s",
		"git\\s+push",
		"git\\s+reset\\s+--hard",
		"systemctl\\s+(?:--user\\s+)?(?:start|stop|restart|reload|enable|disable|mask)\\b",
		"\\bsudo\\b",
		"\\bshutdown\\b|\\breboot\\b|\\bpoweroff\\b",
		"chmod|chown",
		"\\b(?:docker|podman)\\s+(?:rm|stop|run|prune)\\b",
		"\\b(?:psql|mysql|sqlite3)\\b.*(?:-c|drop|delete|update)",
		"\\bkill\\s+-9",
	],
};

export function loadPolicy(): Policy {
	if (!existsSync(POLICY_PATH)) {
		try {
			mkdirSync(join(POLICY_PATH, ".."), { recursive: true });
			writeFileSync(POLICY_PATH, `${JSON.stringify(DEFAULTS, null, "\t")}\n`, { mode: 0o600 });
		} catch {
			// нет прав на домашний каталог — работаем на встроенных правилах
		}
		return DEFAULTS;
	}
	try {
		const parsed = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Partial<Policy>;
		return {
			deny: Array.isArray(parsed.deny) ? parsed.deny : DEFAULTS.deny,
			allow: Array.isArray(parsed.allow) ? parsed.allow : DEFAULTS.allow,
			confirm: Array.isArray(parsed.confirm) ? parsed.confirm : DEFAULTS.confirm,
		};
	} catch {
		return DEFAULTS;
	}
}

function matches(patterns: readonly string[], action: string): string | null {
	for (const pattern of patterns) {
		try {
			if (new RegExp(pattern, "iu").test(action)) return pattern;
		} catch {
			// кривой шаблон владельца не должен ломать исполнение
		}
	}
	return null;
}

/** Похоже ли на исполняемую команду: описание шага политикой не ограничивается. */
function looksLikeCommand(action: string): boolean {
	if (/[|;&$`><]|\.\.\//u.test(action)) return true;
	return /^[\w./-]+\s/u.test(action.trim());
}

/** Решение по действию: deny важнее confirm, confirm важнее allow. */
export function decide(action: string, policy: Policy = loadPolicy()): { decision: Decision; rule: string | null } {
	if (!looksLikeCommand(action)) return { decision: "allow", rule: "описание шага, а не команда" };
	const denied = matches(policy.deny, action);
	if (denied) return { decision: "deny", rule: denied };
	const confirm = matches(policy.confirm, action);
	if (confirm) return { decision: "confirm", rule: confirm };
	const allowed = matches(policy.allow, action);
	if (allowed) return { decision: "allow", rule: allowed };
	// Незнакомое действие не разрешаем молча: подтверждение, а не догадка.
	return { decision: "confirm", rule: null };
}

if (import.meta.main) {
	const action = process.argv.slice(2).join(" ");
	if (!action) {
		console.error("использование: policy \"<действие>\"");
		process.exit(2);
	}
	const verdict = decide(action);
	console.log(`${verdict.decision}${verdict.rule ? ` · правило: ${verdict.rule}` : ""}`);
	process.exit(verdict.decision === "deny" ? 3 : verdict.decision === "confirm" ? 1 : 0);
}

export { POLICY_PATH, DEFAULTS };
