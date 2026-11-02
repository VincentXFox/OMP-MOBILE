/**
 * Goldfish: политика соразмерности проверок.
 *
 * Зачем: проверка должна покрывать весь OMP, но не превращаться в консилиум на
 * каждое «спасибо». Уровень риска определяется по задаче, инструментам и путям,
 * а не по словам в финальном ответе.
 *
 * Уровни:
 *   none      — простое общение и тривиальные ответы: проверка не требуется;
 *   light     — исследование, документы, заметки: проверка результата по необходимости;
 *   standard  — изменения кода и конфигурации: план (если задача многошаговая) и результат;
 *   enhanced  — прод, миграции, доступы, сеть: план и результат, усиленная приёмка
 *               (аттестация верификатора, а не только вердикт ревьюера).
 */

export type Tier = "none" | "light" | "standard" | "enhanced";

export interface RiskInput {
	/** Исходная задача пользователя (последний запрос хода). */
	prompt: string;
	/** Инструменты, которые сессия уже вызывала (edit/write/systemctl/ssh/...). */
	tools: readonly string[];
	/** Пути, которых касались правки. */
	paths: readonly string[];
	/** Сколько шагов (вызовов инструментов) сделала сессия. */
	steps: number;
}

export interface Policy {
	tier: Tier;
	reasons: string[];
	/** Нужна ли проверка плана до изменений. */
	planReview: boolean;
	/** Нужна ли проверка результата. */
	resultReview: boolean;
	/** Сколько независимых проверяющих достаточно. */
	reviewers: number;
	/** Требуется ли аттестация верификатора (а не только вердикт ревьюера). */
	attestation: boolean;
}

/** Тривиальные запросы: проверка не нужна. */
const TRIVIAL_RES: readonly RegExp[] = [
	/^(?:привет|спасибо|ок|окей|понял|да|нет|ага|угу)(?=\s|$|[!,.]{1,3})/iu,
	/^(?:что|кто|где|когда|сколько|какой|какая|какие|почему|зачем)(?=\s|$|[?,:;!])/iu,
	/^(?:покажи|выведи|скажи|ответь|напомни|переведи|объясни\s+одним)(?=\s|$)[^.\n]{0,80}$/iu,
	/(?:одной\s+строкой|одним\s+(?:словом|предложением)|без\s+пояснений|кратко\s+ответь)/iu,
];

/** Прод, доступы, сеть, миграции — усиленный уровень. */
const ENHANCED_RES: readonly RegExp[] = [
	/\b(?:prod|прод|production|миграц|migrat|деплой|deploy|выкат|release)\w*/iu,
	/\b(?:vpn|wireguard|wg-|openvpn|firewall|ufw|iptables|nftables|маршрут|routing)\b/iu,
	/\b(?:srv78|de5|thor1|mikrotik|роутер|router|nginx|caddy|dns|nameserver)\b/iu,
	/\b(?:lamplife|блог|магазин|shop|сайт|site)\b/iu,
	/\b(?:ssh|sudo|systemctl|docker|kubectl|terraform|ansible)\b/iu,
	/\b(?:пароль|password|ключ|key|токен|token|доступ|access|права|permission)\w*/iu,
];

/** Изменения кода и конфигурации — стандартный уровень. */
const STANDARD_RES: readonly RegExp[] = [
	/\b(?:код|code|баг|bug|фикс|fix|рефактор|refactor|тест|test|сборк|build|сборка)\w*/iu,
	/\b(?:конфиг|config|настройк|settings|скрипт|script|сервис|service)\w*/iu,
	/\.(?:ts|tsx|js|jsx|py|sh|css|json|ya?ml|toml|service|conf)\b/iu,
];

/** Изменяющие инструменты: по ним видно, что работа идёт с файлами и системами. */
const MUTATING: Record<string, true> = { edit: true, write: true, bash: true, systemctl: true, ssh: true };

export function classify(input: RiskInput): Policy {
	const prompt = input.prompt.trim();
	const reasons: string[] = [];

	if (prompt !== "" && TRIVIAL_RES.some(re => re.test(prompt)) && input.steps <= 2) {
		return { tier: "none", reasons: ["тривиальный запрос, изменений не было"], planReview: false, resultReview: false, reviewers: 0, attestation: false };
	}

	const touched = input.tools.filter(tool => MUTATING[tool] === true);
	const text = `${prompt}\n${input.paths.join("\n")}`;
	const enhanced = ENHANCED_RES.some(re => re.test(text)) || input.paths.some(p => /\/(?:etc|srv|opt)\//.test(p));
	const standard = STANDARD_RES.some(re => re.test(text)) || touched.some(tool => tool === "edit" || tool === "write");

	if (enhanced) {
		reasons.push("задача касается прода, доступов, сети или миграции");
		return { tier: "enhanced", reasons, planReview: true, resultReview: true, reviewers: 2, attestation: true };
	}
	if (standard) {
		reasons.push(touched.length > 0 ? "работа с файлами кода или конфигурации" : "задача про код или конфигурацию");
		return { tier: "standard", reasons, planReview: input.steps >= 8, resultReview: true, reviewers: 1, attestation: false };
	}
	reasons.push("исследование или документ без правок кода");
	return { tier: "light", reasons, planReview: false, resultReview: false, reviewers: 1, attestation: false };
}

/** Нужна ли обязательная проверка на этом уровне (иначе — по желанию). */
export function mandatory(policy: Policy): boolean {
	return policy.tier === "standard" || policy.tier === "enhanced";
}
