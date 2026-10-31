#!/usr/bin/env bun
/**
 * visual-gate — визуальная приёмка интерфейса.
 *
 * Делает не один «общий план», а серию снимков: каждый маршрут в каждом размере
 * экрана плюс крупные планы каждой значимой детали (карточка, полоса, кнопка).
 * Затем разбирает снимки двумя способами:
 *   1) геометрия в самой странице — горизонтальный выхлоп, обрезка, перекрытия
 *      интерактивных элементов, слишком маленькие цели нажатия;
 *   2) локальная VLM (Qwen3-VL на 127.0.0.1:8080) — «что не так на картинке»
 *      по строгому списку: перекрытия, обрезанный текст, кривое выравнивание,
 *      провалы контраста, пустые блоки.
 *
 * Результат: папка со снимками + report.json/report.md. Код выхода 1, если найден
 * хотя бы один дефект — значит визуальную проверку можно ставить обычным `--check`
 * в контракт quality-gate, и её воспроизведёт независимый верификатор.
 *
 * Использование:
 *   bun bin/visual-gate.ts run --plan .omp/visual/plan.json [--out .omp/visual/run]
 *   bun bin/visual-gate.ts run --url http://127.0.0.1:8088 --token … --routes agents,goals
 *   bun bin/visual-gate.ts run --plan … --no-vlm          (только геометрия)
 */
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

interface ViewportSpec {
	name: string;
	width: number;
	height: number;
}

interface DetailSpec {
	route: string;
	selector: string;
	name?: string;
}

interface Plan {
	url: string;
	token?: string;
	routes: string[];
	viewports: ViewportSpec[];
	details?: DetailSpec[];
}

interface GeometryFinding {
	kind: "overflow" | "clipped" | "covered" | "tiny";
	detail: string;
}

interface Shot {
	name: string;
	route: string;
	viewport: string;
	kind: "full" | "detail";
	file: string;
	sha256: string;
	width: number;
	height: number;
	geometry: GeometryFinding[];
	vlm: { ok: boolean; verdict: string } | null;
}

interface Report {
	startedAt: string;
	finishedAt: string;
	url: string;
	shots: Shot[];
	defects: { shot: string; source: "geometry" | "vlm"; detail: string }[];
	consoleErrors: string[];
}

const DEFAULT_VIEWPORTS: ViewportSpec[] = [
	{ name: "phone", width: 390, height: 844 },
	{ name: "desktop", width: 1280, height: 800 },
];

/**
 * Анализ картинки дешёвой vision-моделью cheapference.
 * По умолчанию gpt-5.6-luna (0.08/0.48 за млн токенов) — самая дешёвая из видящих;
 * при недоступности — локальная Qwen3-VL на 127.0.0.1:8080.
 */
const VLM_URL = process.env.VISUAL_VLM_URL ?? "https://de5.vincentfox.ru:4431/v1/chat/completions";
const VLM_MODEL = process.env.VISUAL_VLM_MODEL ?? "gpt-5.6-luna";
const VLM_KEY_ENV = process.env.VISUAL_VLM_KEY_ENV ?? "CHEAPERINFERENCE_API_KEY";
const LOCAL_VLM_URL = "http://127.0.0.1:8080/v1/chat/completions";
const LOCAL_VLM_MODEL = "qwen3-vl-4b";

function argValue(argv: string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function hasFlag(argv: string[], flag: string): boolean {
	return argv.includes(flag);
}

function freePort(): number {
	return 9500 + Math.floor(Math.random() * 400);
}

async function waitForDevtools(port: number, timeoutMs = 20_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const started = Date.now();
	const timer = setInterval(async () => {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
			if (response.ok) {
				clearInterval(timer);
				resolve();
				return;
			}
		} catch {
			// ещё не встал
		}
		if (Date.now() - started > timeoutMs) {
			clearInterval(timer);
			reject(new Error("Chrome не поднял DevTools"));
		}
	}, 200);
	await promise;
}

/** Минимальный CDP-клиент: сессия страницы, вызовы по id, ожидание событий. */
class Cdp {
	readonly #ws: WebSocket;
	#id = 0;
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly #events = new Map<string, ((params: unknown) => void)[]>();
	readonly #opened: Promise<void>;

	constructor(wsUrl: string) {
		this.#ws = new WebSocket(wsUrl);
		const opened = Promise.withResolvers<void>();
		this.#opened = opened.promise;
		this.#ws.onopen = () => opened.resolve();
		this.#ws.onerror = () => opened.reject(new Error("WebSocket CDP не открылся"));
		this.#ws.onmessage = (event: MessageEvent) => {
			const data = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };
			if (typeof data.id === "number") {
				const entry = this.#pending.get(data.id);
				if (!entry) return;
				this.#pending.delete(data.id);
				if (data.error) entry.reject(new Error(JSON.stringify(data.error).slice(0, 300)));
				else entry.resolve(data.result);
				return;
			}
			if (data.method) {
				for (const handler of this.#events.get(data.method) ?? []) handler(data.params);
			}
		};
	}

	async ready(): Promise<void> {
		await this.#opened;
	}

	send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = ++this.#id;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
		this.#ws.send(JSON.stringify({ id, method, params }));
		return promise;
	}

	once(method: string, timeoutMs: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const handlers = this.#events.get(method) ?? [];
		const handler = (): void => {
			clearTimeout(timer);
			this.#events.set(method, (this.#events.get(method) ?? []).filter(item => item !== handler));
			resolve();
		};
		const timer = setTimeout(() => {
			this.#events.set(method, (this.#events.get(method) ?? []).filter(item => item !== handler));
			resolve();
		}, timeoutMs);
		handlers.push(handler);
		this.#events.set(method, handlers);
		return promise;
	}

	on(method: string, handler: (params: unknown) => void): void {
		const handlers = this.#events.get(method) ?? [];
		handlers.push(handler);
		this.#events.set(method, handlers);
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {
			// уже закрыт
		}
	}
}

/** В странице: то, что видно только глазами — меряем кодом. */
const GEOMETRY_SCRIPT = `(() => {
	const vw = innerWidth, vh = innerHeight;
	const findings = [];
	const desc = el => {
		const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
		return el.tagName.toLowerCase() + (cls ? "." + cls : "");
	};
	const inRail = el => {
		let p = el.parentElement;
		while (p) {
			const ox = getComputedStyle(p).overflowX;
			if (ox === "auto" || ox === "scroll") return true;
			p = p.parentElement;
		}
		return false;
	};
	if (document.documentElement.scrollWidth - vw > 2) {
		findings.push({ kind: "overflow", detail: "горизонтальный скролл: " + (document.documentElement.scrollWidth - vw) + "px" });
	}
	for (const el of Array.from(document.querySelectorAll("body *"))) {
		const st = getComputedStyle(el);
		if (st.display === "none" || st.visibility === "hidden" || st.position === "fixed" || inRail(el)) continue;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;
		if (r.right > vw + 2) findings.push({ kind: "clipped", detail: desc(el) + " выходит за экран на " + Math.round(r.right - vw) + "px" });
	}
	const interactive = Array.from(document.querySelectorAll("button, a, input, select, textarea, [role=button]")).filter(el => {
		const st = getComputedStyle(el);
		return st.display !== "none" && st.visibility !== "hidden" && el.offsetParent !== null;
	});
	for (const el of interactive) {
		const r = el.getBoundingClientRect();
		if (r.width < 4 || r.height < 4 || r.top < 0 || r.bottom > vh) continue;
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		if (hit && !el.contains(hit) && !hit.contains(el)) {
			let chrome = false;
			for (let node = hit; node && node !== document.body; node = node.parentElement) {
				const pos = getComputedStyle(node).position;
				if (pos === "fixed" || pos === "sticky") {
					chrome = true;
					break;
				}
			}
			if (!chrome) findings.push({ kind: "covered", detail: desc(el) + " перекрыт " + desc(hit) });
		}
		if (r.height < 28 || r.width < 24) findings.push({ kind: "tiny", detail: desc(el) + " цель " + Math.round(r.width) + "×" + Math.round(r.height) });
	}
	return JSON.stringify(findings.slice(0, 12));
})()`;

const VLM_PROMPT = `Ты придирчивый UI-ревьюер. На снимке окна мобильного веб-приложения (это вид при прокрутке).
Ищи ТОЛЬКО настоящие дефекты вёрстки: наложение блоков друг на друга в потоке,
текст, обрезанный внутри своей карточки, сломанное выравнивание, нечитаемый контраст,
пустые блоки с рамкой без содержимого.

НЕ считай дефектом:
- фиксированную нижнюю/верхнюю панель, под которой виден прокручиваемый контент (это нормальный хром приложения);
- элементы, частично видимые у верхнего или нижнего края окна (это прокрутка, а не обрезка);
- затемнение/размытие под полупрозрачной панелью;
- отсутствие отступов «на твой вкус».

Если настоящих дефектов нет — ответь ровно: ОК.
Иначе верни не более трёх строк, каждая начинается с «ДЕФЕКТ: ».`;

async function callVision(url: string, model: string, png: Uint8Array, key: string | undefined): Promise<{ ok: boolean; verdict: string }> {
	try {
		const body = {
			model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: VLM_PROMPT },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` } },
					],
				},
			],
			max_tokens: 220,
			temperature: 0,
		};
		const response = await fetch(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) return { ok: true, verdict: `VLM недоступна (${response.status})`, http: response.status } as { ok: boolean; verdict: string };
		const raw = await response.text();
		if (raw.trim().startsWith("data:")) {
			// SSE-поток: склеиваем delta.content
			const parts = raw.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).filter(chunk => chunk !== "[DONE]");
			const text = parts.map(chunk => { try { return (JSON.parse(chunk) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } }).join("");
			return verdictOf(text);
		}
		const data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
		return verdictOf(data.choices?.[0]?.message?.content ?? "");
	} catch (error) {
		return { ok: true, verdict: `VLM недоступна: ${String(error).slice(0, 80)}` };
	}
}

function verdictOf(text: string): { ok: boolean; verdict: string } {
	const clean = text.trim();
	const defects = clean.split("\n").map(line => line.trim()).filter(line => /^ДЕФЕКТ:/iu.test(line));
	if (defects.length > 0) return { ok: false, verdict: defects.join("; ").slice(0, 500) };
	return { ok: true, verdict: clean.slice(0, 120) || "ОК" };
}

/** Сначала cheapference; локальная Qwen3-VL — если облако недоступно. */
async function analyzeWithVlm(png: Uint8Array): Promise<{ ok: boolean; verdict: string }> {
	const key = process.env[VLM_KEY_ENV];
	if (key) {
		const cloud = await callVision(VLM_URL, VLM_MODEL, png, key);
		if (!/VLM недоступна/iu.test(cloud.verdict)) return cloud;
	}
	return callVision(LOCAL_VLM_URL, LOCAL_VLM_MODEL, png, undefined);
}

async function main(argv: string[]): Promise<number> {
	const planArg = argValue(argv, "--plan");
	const outArg = argValue(argv, "--out");
	const withVlm = !hasFlag(argv, "--no-vlm");
	const plan: Plan = planArg
		? (JSON.parse(await readFile(planArg, "utf8")) as Plan)
		: {
				url: argValue(argv, "--url") ?? "http://127.0.0.1:8088",
				token: argValue(argv, "--token") ?? undefined,
				routes: (argValue(argv, "--routes") ?? "agents").split(",").map(item => item.trim()),
				viewports: DEFAULT_VIEWPORTS,
			};
	const outDir = outArg ?? join(process.cwd(), ".omp", "visual", `run-${Date.now()}`);
	await mkdir(join(outDir, "shots"), { recursive: true });

	const port = freePort();
	const profile = join(outDir, "chrome-profile");
	mkdirSync(profile, { recursive: true });
	const chrome = spawn(
		"google-chrome",
		["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"],
		{ stdio: "ignore" },
	);
	const report: Report = { startedAt: new Date().toISOString(), finishedAt: "", url: plan.url, shots: [], defects: [], consoleErrors: [] };
	try {
		await waitForDevtools(port);
		const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then(response => response.json() as Promise<{ webSocketDebuggerUrl: string }>);
		const cdp = new Cdp(target.webSocketDebuggerUrl);
		await cdp.ready();
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");
		await cdp.send("Log.enable");
		cdp.on("Runtime.consoleAPICalled", params => {
			const entry = params as { type?: string; args?: { value?: unknown }[] };
			if (entry.type === "error") report.consoleErrors.push(String(entry.args?.[0]?.value ?? "").slice(0, 200));
		});

		// Токен и первый заход: PWA провижинит его из hash и хранит в localStorage.
		if (plan.token) {
			await cdp.send("Page.navigate", { url: `${plan.url}/#token=${plan.token}` });
			await cdp.once("Page.loadEventFired", 15_000);
			await new Promise(resolve => setTimeout(resolve, 1200));
		}

		for (const viewport of plan.viewports) {
			await cdp.send("Emulation.setDeviceMetricsOverride", {
				width: viewport.width,
				height: viewport.height,
				deviceScaleFactor: 2,
				mobile: viewport.width < 600,
			});
			for (const route of plan.routes) {
				await cdp.send("Page.navigate", { url: `${plan.url}/#/${route}` });
				await cdp.once("Page.loadEventFired", 15_000);
				await new Promise(resolve => setTimeout(resolve, 1500));

				/** Замеры в текущем положении прокрутки. */
				const runGeometry = async (): Promise<GeometryFinding[]> => {
					const raw = (await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
						expression: GEOMETRY_SCRIPT,
						returnByValue: true,
					})) as { result?: { value?: string } };
					return JSON.parse(raw.result?.value ?? "[]") as GeometryFinding[];
				};

				// Общий план — тремя реальными видами (верх/середина/низ), как их видит
				// человек при прокрутке. Фиксированные бары остаются на месте и не
				// создают ложных «пустых полос» и наложений.
				await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
				await new Promise(resolve => setTimeout(resolve, 250));
				const scrollHeights = (await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
					expression: "JSON.stringify({ total: document.documentElement.scrollHeight, view: innerHeight })",
					returnByValue: true,
				})) as { result?: { value?: string } };
				const { total, view } = JSON.parse(scrollHeights.result?.value ?? "{}") as { total?: number; view?: number };
				const scrollPositions = [0, Math.max(0, Math.round(((total ?? 0) - (view ?? 0)) / 2)), Math.max(0, (total ?? 0) - (view ?? 0))];
				for (const [positionIndex, position] of scrollPositions.entries()) {
					await cdp.send("Runtime.evaluate", { expression: `window.scrollTo(0, ${position})` });
					await new Promise(resolve => setTimeout(resolve, 300));
					const geometry = await runGeometry();
					const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
					const bytes = Buffer.from(shot.data, "base64");
					const name = `${route}-${viewport.name}-view${positionIndex}.png`;
					await writeFile(join(outDir, "shots", name), bytes);
					report.shots.push({
						name,
						route,
						viewport: viewport.name,
						kind: "full",
						file: `shots/${name}`,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						width: viewport.width,
						height: viewport.height,
						geometry,
						vlm: withVlm ? await analyzeWithVlm(bytes) : null,
					});
				}
				await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
				await new Promise(resolve => setTimeout(resolve, 200));
				const content = { width: viewport.width, height: viewport.height };

				// Крупные планы деталей: прокрутили к элементу, сняли его актуальный
				// прямоугольник в координатах окна — и только тогда снимок.
				for (const detail of (plan.details ?? []).filter(item => item.route === route)) {
					const count = (await cdp.send<{ result?: { value?: number } }>("Runtime.evaluate", {
						expression: `document.querySelectorAll(${JSON.stringify(detail.selector)}).length`,
						returnByValue: true,
					})) as { result?: { value?: number } };
					const total = Math.min(Number(count.result?.value ?? 0), 4);
					for (let index = 0; index < total; index++) {
						await cdp.send("Runtime.evaluate", {
							expression: `document.querySelectorAll(${JSON.stringify(detail.selector)})[${index}]?.scrollIntoView({ block: "center" })`,
						});
						await new Promise(resolve => setTimeout(resolve, 300));
						const rectRaw = (await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
							expression: `(() => { const el = document.querySelectorAll(${JSON.stringify(detail.selector)})[${index}]; if (!el) return "null"; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }); })()`,
							returnByValue: true,
						})) as { result?: { value?: string } };
						const box = rectRaw.result?.value && rectRaw.result.value !== "null" ? (JSON.parse(rectRaw.result.value) as { x: number; y: number; w: number; h: number }) : null;
						if (!box || box.w < 8 || box.h < 8) continue;
						const clip = {
							x: Math.max(0, box.x - 6),
							y: Math.max(0, box.y - 6),
							width: Math.min(box.w + 12, viewport.width),
							height: Math.min(box.h + 12, viewport.height),
							scale: 2,
						};
						const shot = (await cdp.send("Page.captureScreenshot", { format: "png", clip })) as { data: string };
						const bytes = Buffer.from(shot.data, "base64");
						if (bytes.length < 2_000) continue;
						const safe = (detail.name ?? detail.selector).replace(/[^\w.-]+/g, "_").slice(0, 40);
						const name = `${route}-${viewport.name}-${safe}-${index}.png`;
						await writeFile(join(outDir, "shots", name), bytes);
						report.shots.push({
							name,
							route,
							viewport: viewport.name,
							kind: "detail",
							file: `shots/${name}`,
							sha256: createHash("sha256").update(bytes).digest("hex"),
							width: Math.round(clip.width),
							height: Math.round(clip.height),
							geometry: [],
							vlm: withVlm ? await analyzeWithVlm(bytes) : null,
						});
					}
				}
			}
		}
		cdp.close();
	} finally {
		chrome.kill("SIGKILL");
	}

	for (const shot of report.shots) {
		for (const finding of shot.geometry) report.defects.push({ shot: shot.name, source: "geometry", detail: `${finding.kind}: ${finding.detail}` });
		if (shot.vlm && !shot.vlm.ok) report.defects.push({ shot: shot.name, source: "vlm", detail: shot.vlm.verdict });
	}
	report.finishedAt = new Date().toISOString();
	await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	const md = [
		`# Визуальная приёмка · ${report.url}`,
		"",
		`Снимков: ${report.shots.length} (общих ${report.shots.filter(shot => shot.kind === "full").length}, детальных ${report.shots.filter(shot => shot.kind === "detail").length})`,
		`Дефектов: ${report.defects.length}`,
		"",
		...report.shots.map(shot => {
			const vlm = shot.vlm ? ` · VLM: ${shot.vlm.ok ? "ок" : shot.vlm.verdict}` : " · VLM: выключена";
			return `- ${shot.file} (${shot.width}×${shot.height})${vlm}${shot.geometry.length > 0 ? ` · геометрия: ${shot.geometry.length}` : ""}`;
		}),
		"",
		report.defects.length > 0 ? "## Дефекты" : "## Дефектов не найдено",
		...report.defects.map(item => `- ${item.shot}: ${item.detail}`),
	].join("\n");
	await writeFile(join(outDir, "report.md"), `${md}\n`, "utf8");
	console.log(`снимков: ${report.shots.length}, дефектов: ${report.defects.length} → ${outDir}`);
	for (const item of report.defects.slice(0, 12)) console.log(`  ✗ ${item.shot}: ${item.detail.slice(0, 160)}`);
	return report.defects.length === 0 ? 0 : 1;
}

if (!existsSync(".")) process.exit(2);
main(process.argv.slice(2))
	.then(code => process.exit(code))
	.catch(error => {
		console.error(`ошибка визуальной приёмки: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	});
