/**
 * GRANDMASTER · Deployment Guard — запрет прямой выкладки на production.
 *
 * Роли разделены: IMPLEMENTER/BROWSER RUNNER/REVIEWER/VERIFIER не имеют права
 * писать на production. Единственный санкционированный путь — `bin/deploy.ts`,
 * который требует разрешения владельца, подписанного верификатором.
 *
 * Хук ловит попытки обойти гейт: `ssh/scp/rsync/sshfs/sftp` к production-хостам,
 * запись в `/srv/lamplife`, docker exec на прод-стеке. Пропускает только при
 * `OMP_DEPLOY_AUTH=<release>` и подтверждённом (не погашенном) разрешении от
 * верификатора — то есть при выкладке, которую запустил DEPLOYER через гейт.
 *
 * Контракт:
 * - только bash-вызовы; read-only команды (curl GET, ssh с одной читающей
 *   командой) НЕ блокируются — иначе нельзя проверить живой сайт;
 * - блокируется всё, что меняет состояние прода: scp/rsync в прод, запись по
 *   ssh, docker exec/restart, bench build на прод-хосте;
 * - ошибки хука — fail-open только для чтения; для записи — fail-closed
 *   (неизвестная команда к прод-хосту считается опасной).
 */

const PROD_HOSTS = ["194.58.95.216", "lamplife.ru", "lamplife-demo"];
const PROD_PATHS = ["/srv/lamplife"];
/**
 * Мутация прода: любой способ изменить состояние на чужой машине. Список
 * намеренно широкий — состязательный разбор показал, что узкий чёрный список
 * обходится `docker-compose`, `tee`, `dd`, `sed -i`, `cp`, `curl -X POST`.
 */
const MUTATING_RE = new RegExp(
	[
		"\\bscp\\b", "\\brsync\\b", "\\bsftp\\b", "\\bsshfs\\b",
		"docker(?:-compose)?\\s+(?:exec|restart|compose|stop|start|rm|down|up|kill)",
		"\\bbench\\s+(?:build|restart|migrate|clear-cache)",
		"\\bsystemctl\\s+(?:restart|stop|start|disable|enable)",
		"\\b(?:tee|dd|install|truncate)\\b", "\\bsed\\s+-i\\b", "\\bcp\\s",
		"\\bcurl\\b[^\n]*-X\\s*(?:POST|PUT|PATCH|DELETE)",
		"\\b(?:ansible|ansible-playbook)\\b", "\\b(?:python3?|node|perl|ruby)\\s+-e\\b",
		"(?:^|\\s)>{1,2}\\s*(?:\\S*\\/srv\\/lamplife|\\S*lamplife)",
		"\\brm\\s+-rf?\\s+\\S*lamplife", "\\bmkdir\\s+\\S*lamplife",
	].join("|"),
	"u",
);

/**
 * Явно читающие формы: пропускаем, даже если назван прод-хост. У каждой
 * альтернативы обязательная граница справа — иначе `ssh …` совпадает с `ss`,
 * и любая команда к проду проходит как «чтение» (найдено 27.10).
 */
const READ_ONLY_RE =
	/^\s*(?:curl\s+-s|wget\s+-q|grep|rg|cat|head|tail|ls|stat|find|file|du|df|ss|ps|journalctl|systemctl\s+(?:status|is-active|show)|docker\s+(?:ps|logs|inspect)|git\s+(?:log|show|status|diff)|ssh\s+\S+\s+['"]?(?:cat|grep|ls|head|tail|stat|find|docker\s+ps|systemctl\s+status))(?=\s|$|['"|;&])/u;

/** Скачивание С прода (источник — прод-хост, приёмник — локальный путь). */
function isPull(command: string): boolean {
	return /\b(?:scp|rsync|sftp)\b[^\n]*\S+@?(?:194\.58\.95\.216|lamplife\.ru):\S+\s+(?:\.|\/|~)/u.test(command);
}

interface HookContext {
	cwd?: unknown;
	sessionManager?: { getSessionId?: () => unknown };
}

interface ToolCallEvent {
	toolName?: unknown;
	input?: unknown;
}

interface PiApi {
	on(event: string, handler: (event: ToolCallEvent, ctx: HookContext) => unknown): void;
}

function commandOf(event: ToolCallEvent): string {
	const input = event.input;
	if (input === null || typeof input !== "object") return "";
	const command = (input as Record<string, unknown>)["command"];
	return typeof command === "string" ? command : "";
}

/** Запрос к верификатору: подтверждено ли разрешение на эту выкладку. */
async function approvalIsValid(release: string, socket: string): Promise<boolean> {
	try {
		const response = await fetch("http://verifier/", {
			method: "POST",
			unix: socket,
			body: JSON.stringify({ action: "check-approval", release, approval: null, consume: false }),
			signal: AbortSignal.timeout(5_000),
		});
		const answer = (await response.json()) as { ok?: unknown; detail?: unknown };
		// Проверка без самого разрешения ничего не подтверждает: нужен файл.
		return answer.ok === true && !String(answer.detail ?? "").includes("не передано");
	} catch {
		return false;
	}
}

async function approvalFileIsValid(release: string, socket: string): Promise<boolean> {
	try {
		const dir = process.env["OMP_DEPLOY_APPROVALS"] ?? `${process.env["HOME"] ?? ""}/.omp/deploy-approvals`;
		const file = Bun.file(`${dir}/${release}.json`);
		if (!(await file.exists())) return false;
		const approval = JSON.parse(await file.text()) as Record<string, unknown>;
		const response = await fetch("http://verifier/", {
			method: "POST",
			unix: socket,
			body: JSON.stringify({ action: "check-approval", release, approval, consume: false }),
			signal: AbortSignal.timeout(5_000),
		});
		const answer = (await response.json()) as { ok?: unknown };
		return answer.ok === true;
	} catch {
		return false;
	}
}

export default function deployGuard(pi: PiApi): void {
	pi.on("tool_call", async (event, _ctx) => {
		try {
			if (event.toolName !== "bash") return undefined;
			const command = commandOf(event);
			if (command === "") return undefined;
			const touchesProd = PROD_HOSTS.some((host) => command.includes(host)) || PROD_PATHS.some((path) => command.includes(path));
			if (!touchesProd) return undefined;
			// Чтение прода не блокируем; скачивание с прода — тоже чтение.
			if (READ_ONLY_RE.test(command)) return undefined;
			if (isPull(command)) return undefined;
			if (!MUTATING_RE.test(command)) {
				// Команда называет прод, но не попала ни в чтение, ни в мутации:
				// считаем неизвестное опасным (fail-closed).
				const release = process.env["OMP_DEPLOY_AUTH"] ?? "";
				if (release !== "") return undefined;
				return {
					block: true,
					reason:
						"ГРАНДМАСТЕР · deployment guard: команда обращается к production, но её эффект не распознан как чтение. " +
						"Выкладка идёт только через `bun bin/deploy.ts` с разрешением владельца (bin/deploy-gate.ts).",
				};
			}

			const release = process.env["OMP_DEPLOY_AUTH"] ?? "";
			const socket = process.env["OMP_VERIFIER_SOCKET"] ?? "/run/omp-verifier/verify.sock";
			const authorized = release !== "" && ((await approvalFileIsValid(release, socket)) || (await approvalIsValid(release, socket)));
			if (authorized) return undefined;

			return {
				block: true,
				reason:
					"ГРАНДМАСТЕР · deployment guard: прямая запись на production запрещена. " +
					"Выкладка идёт только через `bun bin/deploy.ts` с разрешением владельца, подписанным верификатором " +
					"(`bin/deploy-gate.ts request|approve`), и только на commit, прошедший приёмку. " +
					"Если это чтение — переформулируй команду без изменения состояния прода.",
			};
		} catch {
			// Ошибка хука при записи в прод трактуется как запрет: лучше остановить, чем испортить.
			return {
				block: true,
				reason: "ГРАНДМАСТЕР · deployment guard: не удалось проверить разрешение на выкладку — действие отклонено (fail-closed).",
			};
		}
	});
}
