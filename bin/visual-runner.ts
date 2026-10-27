#!/usr/bin/env bun
// visual-runner — доверенный раннер визуальной приёмки.
//
// Зачем: «скриншоты посмотрел, вроде ничего не поехало» — не доказательство, а
// мнение. Этот раннер сам поднимает Chrome по CDP (внешних библиотек нет),
// снимает полную матрицу (8 viewport'ов × 2 темы × 3 позиции прокрутки = 48 PNG),
// на каждой комбинации делает пять измеримых DOM-проверок и подписывает пакет
// доказательств Ed25519. Нет скриншота или провалилась проверка — пакет честно
// это пишет, `totals.failed` > 0, код возврата 1. «Зелёных по умолчанию» нет.
//
//   bun bin/visual-runner.ts --url <URL> --slug <slug> --out <каталог>
//     [--viewports 320x640,320x844,...] [--themes light,dark]
//     [--key ~/.omp/visual-runner.ed25519] [--chrome /usr/bin/google-chrome]
//     [--commit <sha>] [--diff-hash <16 hex>] [--timeout-ms 30000] [--keep-open]
//
// Пишет только в <out> и во временный профиль Chrome (плюс ключ по --key).
// Код возврата: 0 — все 48 скриншотов и все проверки прошли, 1 — что-то упало,
// 2 — плохой ввод/раннер не поднялся.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Theme = "light" | "dark";
export type Position = "top" | "middle" | "bottom";
export type CheckName = "overlap" | "lastBrand" | "horizontalOverflow" | "buttons" | "theme";

export interface Viewport {
	width: number;
	height: number;
}
export interface DomCheck {
	ok: boolean;
	detail: string;
}
export interface Shot {
	position: Position;
	path: string;
	sha256: string;
	bytes: number;
}
export interface Combo {
	viewport: Viewport;
	theme: Theme;
	shots: Shot[];
	dom: Record<CheckName, DomCheck>;
}
export interface Evidence {
	version: 1;
	slug: string;
	url: string;
	commit: string;
	diffHash: string;
	runId: string;
	startedAt: string;
	finishedAt: string;
	runner: { keyId: string; chrome: string; host: string };
	combos: Combo[];
	totals: { combos: number; shots: number; failed: number };
}

export const DEFAULT_VIEWPORTS = "320x640,320x844,360x640,360x844,390x640,390x844,430x640,430x844";
export const DEFAULT_THEMES: Theme[] = ["light", "dark"];
export const DEFAULT_KEY_PATH = "~/.omp/visual-runner.ed25519";
export const DEFAULT_CHROME = "/usr/bin/google-chrome";
export const POSITIONS: Position[] = ["top", "middle", "bottom"];
export const CHECK_NAMES: CheckName[] = ["overlap", "lastBrand", "horizontalOverflow", "buttons", "theme"];
/** Скриншот меньше этого размера — пустой кадр, а не картинка. */
export const MIN_SHOT_BYTES = 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

// ── канонизация и подпись ────────────────────────────────────────────────────

/**
 * Канонический JSON: ключи объектов отсортированы, без пробелов, массивы в
 * исходном порядке. Именно эти байты подписываются Ed25519.
 */
export function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const parts = Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
	return `{${parts.join(",")}}`;
}

export function sha256Hex(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Нормализованный PEM: без хвостовых пустых строк, с одним переводом строки в конце. */
export function normalizePem(pem: string): string {
	return `${pem.trimEnd()}\n`;
}

/** keyId = "ed25519:<первые 16 hex sha256 публичного PEM>". */
export function keyIdFor(publicPem: string): string {
	return `ed25519:${sha256Hex(normalizePem(publicPem)).slice(0, 16)}`;
}

export interface KeyPairPem {
	privatePem: string;
	publicPem: string;
}

export function generateKeyPairPem(): KeyPairPem {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

/** Читает ключ по пути или создаёт пару (приватный 0600, публичный рядом `<key>.pub`). */
export function loadOrCreateKey(keyPath: string): KeyPairPem {
	const privatePath = resolveUserPath(keyPath);
	const publicPath = `${privatePath}.pub`;
	if (!existsSync(privatePath)) {
		const pair = generateKeyPairPem();
		mkdirSync(dirname(privatePath), { recursive: true });
		writeFileSync(privatePath, pair.privatePem, { mode: 0o600 });
		writeFileSync(publicPath, pair.publicPem, { mode: 0o644 });
		chmodSync(privatePath, 0o600);
		return pair;
	}
	const privatePem = readFileSync(privatePath, "utf8");
	// Ключ должен быть читаемым — иначе подпись молча получится «никакой».
	createPrivateKey(privatePem);
	chmodSync(privatePath, 0o600);
	const publicPem = existsSync(publicPath)
		? readFileSync(publicPath, "utf8")
		: createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
	return { privatePem, publicPem };
}

export function resolveUserPath(path: string): string {
	return path.startsWith("~/") ? join(process.env.HOME ?? "/root", path.slice(2)) : resolve(path);
}

/** Подпись Ed25519 (base64) по каноническому JSON пакета. */
export function signEvidence(evidence: Evidence, privatePem: string): string {
	return edSign(null, Buffer.from(canonicalize(evidence), "utf8"), createPrivateKey(privatePem)).toString("base64");
}

export function verifyEvidence(evidence: Evidence, signatureBase64: string, publicPem: string): boolean {
	try {
		return edVerify(
			null,
			Buffer.from(canonicalize(evidence), "utf8"),
			createPublicKey(publicPem),
			Buffer.from(signatureBase64, "base64"),
		);
	} catch {
		return false;
	}
}

// ── разбор аргументов ────────────────────────────────────────────────────────

export function parseViewports(spec: string): Viewport[] {
	const items = spec
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	if (items.length === 0) throw new Error("--viewports пуст");
	return items.map((item) => {
		const match = item.match(/^([0-9]{2,5})x([0-9]{2,5})$/);
		if (!match) throw new Error(`непонятный viewport: "${item}" (ожидается WxH, например 390x844)`);
		const width = Number(match[1]);
		const height = Number(match[2]);
		if (width < 100 || height < 100) throw new Error(`слишком маленький viewport: ${item}`);
		return { width, height };
	});
}

export function parseThemes(spec: string): Theme[] {
	const items = spec
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item.length > 0);
	if (items.length === 0) throw new Error("--themes пуст");
	for (const item of items) {
		if (item !== "light" && item !== "dark") throw new Error(`непонятная тема: "${item}" (только light/dark)`);
	}
	return [...new Set(items)] as Theme[];
}

/** Путь скриншота внутри <out>: shots/<W>x<H>-<theme>-<position>.png */
export function shotPath(viewport: Viewport, theme: Theme, position: Position): string {
	return `shots/${viewport.width}x${viewport.height}-${theme}-${position}.png`;
}

export function isShotEmpty(bytes: number): boolean {
	return bytes < MIN_SHOT_BYTES;
}

export interface CliOptions {
	url: string;
	slug: string;
	out: string;
	viewports: Viewport[];
	themes: Theme[];
	keyPath: string;
	chrome: string;
	commit?: string;
	diffHash?: string;
	timeoutMs: number;
	keepOpen: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
	const flags = new Map<string, string>();
	const bools = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) throw new Error(`лишний аргумент: ${arg}`);
		if (arg === "--keep-open") {
			bools.add(arg);
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) throw new Error(`${arg} требует значение`);
		flags.set(arg, next);
		i++;
	}
	const known: Record<string, true> = {
		"--url": true,
		"--slug": true,
		"--out": true,
		"--viewports": true,
		"--themes": true,
		"--key": true,
		"--chrome": true,
		"--commit": true,
		"--diff-hash": true,
		"--timeout-ms": true,
		"--keep-open": true,
	};
	for (const flag of [...flags.keys(), ...bools.keys()]) {
		if (known[flag] !== true) throw new Error(`неизвестный флаг: ${flag}`);
	}
	const url = flags.get("--url");
	const slug = flags.get("--slug");
	const out = flags.get("--out");
	if (!url || !slug || !out) throw new Error("нужны --url, --slug и --out");
	const timeoutMs = flags.has("--timeout-ms") ? Number(flags.get("--timeout-ms")) : DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms должен быть положительным числом");
	return {
		url,
		slug,
		out: resolve(out),
		viewports: parseViewports(flags.get("--viewports") ?? DEFAULT_VIEWPORTS),
		themes: parseThemes(flags.get("--themes") ?? DEFAULT_THEMES.join(",")),
		keyPath: flags.get("--key") ?? DEFAULT_KEY_PATH,
		chrome: flags.get("--chrome") ?? DEFAULT_CHROME,
		commit: flags.get("--commit"),
		diffHash: flags.get("--diff-hash"),
		timeoutMs,
		keepOpen: bools.has("--keep-open"),
	};
}

/** Сборка матрицы: viewport'ы × темы, порядок — как передали. */
export function buildMatrix(viewports: Viewport[], themes: Theme[]): { viewport: Viewport; theme: Theme }[] {
	const combos: { viewport: Viewport; theme: Theme }[] = [];
	for (const viewport of viewports) for (const theme of themes) combos.push({ viewport, theme });
	return combos;
}

/** Счётчик провалов: пустые/битые скриншоты + проваленные DOM-проверки. */
export function countFailures(combos: Combo[], expectedShots: number): number {
	let failed = 0;
	for (const combo of combos) {
		failed += Math.max(0, expectedShots - combo.shots.length);
		for (const shot of combo.shots) if (isShotEmpty(shot.bytes)) failed += 1;
		for (const name of CHECK_NAMES) if (!combo.dom[name]?.ok) failed += 1;
	}
	return failed;
}

// ── мелочи ───────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}
function readNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readBool(record: Record<string, unknown>, key: string): boolean | null {
	const value = record[key];
	return typeof value === "boolean" ? value : null;
}
const sleep = (ms: number): Promise<void> => new Promise<void>((done) => setTimeout(done, ms));

/** Замеры страницы — всегда JSON-строка; ошибка внутри страницы тоже JSON, а не исключение. */
function parseMeasurements(raw: string, what: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${what}: страница вернула не JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	const record = asRecord(parsed);
	if (!record) throw new Error(`${what}: страница вернула не объект`);
	const pageError = readString(record, "error");
	if (pageError) throw new Error(`${what}: ${pageError}`);
	return record;
}

// ── CDP-клиент ───────────────────────────────────────────────────────────────

interface PendingCall {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

class Cdp {
	#socket: WebSocket;
	#nextId = 1;
	#pending = new Map<number, PendingCall>();
	#listeners = new Set<(message: Record<string, unknown>) => void>();

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.onmessage = (event) => this.#handle(event.data);
	}

	static async connect(wsUrl: string, timeoutMs: number): Promise<Cdp> {
		const socket = new WebSocket(wsUrl);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => reject(new Error("таймаут подключения к CDP")), timeoutMs);
		socket.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		socket.onerror = () => {
			clearTimeout(timer);
			reject(new Error(`не удалось подключиться к CDP: ${wsUrl}`));
		};
		await promise;
		return new Cdp(socket);
	}

	#handle(data: unknown): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof data === "string" ? data : String(data));
		} catch {
			return;
		}
		const message = asRecord(parsed);
		if (!message) return;
		const id = readNumber(message, "id");
		if (id !== null) {
			const call = this.#pending.get(id);
			if (!call) return;
			this.#pending.delete(id);
			const error = message.error;
			if (error !== undefined) call.reject(new Error(`CDP: ${JSON.stringify(error).slice(0, 300)}`));
			else call.resolve(asRecord(message.result) ?? {});
			return;
		}
		for (const listener of this.#listeners) listener(message);
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#pending.set(id, { resolve, reject });
		this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		return promise;
	}

	/** Ждёт событие CDP (или таймаут) — для Page.loadEventFired. */
	waitForEvent(method: string, sessionId: string, timeoutMs: number): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const listener = (message: Record<string, unknown>): void => {
			if (readString(message, "method") !== method) return;
			if (readString(message, "sessionId") !== sessionId) return;
			this.#listeners.delete(listener);
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			this.#listeners.delete(listener);
			resolve(false);
		}, timeoutMs);
		this.#listeners.add(listener);
		return promise;
	}

	close(): void {
		try {
			this.#socket.close();
		} catch {
			/* сокет уже закрыт — это не ошибка приёмки */
		}
	}
}

// ── страница: общий измерительный прелюд ─────────────────────────────────────

/** Хелперы внутри страницы. Без обратных кавычек и без экранирования — так надёжнее. */
const PAGE_HELPERS = String.raw`
  const all = (s) => Array.from(document.querySelectorAll(s));
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const round = (n) => Math.round(n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n) => new Promise((r) => { let left = n; const step = () => (left-- <= 0 ? r(1) : requestAnimationFrame(step)); step(); });
  const settle = async () => { await frames(2); await sleep(300); };
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return fn(); };
  const visible = (el) => { if (!el) return false; const c = getComputedStyle(el); return el.offsetParent !== null && c.visibility !== "hidden" && c.display !== "none" && Number(c.opacity) > 0.05; };
  const panelEl = () => document.querySelector("#ll-filters-panel") || document.querySelector(".ll-filters");
  const gridEl = () => document.querySelector(".ll-grid");
  const layoutEl = () => document.querySelector(".ll-layout");
  const brands = () => all('input[name="brand"]');
  const brandLabels = () => all('input[name="brand"]').map((i) => i.closest("label") || i.parentElement);
  const countEl = () => document.querySelector("[data-ll-count]");
  const applyEl = () => document.querySelector(".ll-filters-apply");
  const resetEl = () => document.querySelector(".ll-filters-reset");
  const toggleEl = () => document.querySelector("[data-ll-filters-toggle]");
  const isDrawer = () => { const p = panelEl(); return !!p && getComputedStyle(p).position === "fixed"; };
  const drawerOpen = () => { const p = panelEl(); if (!p) return false; const c = getComputedStyle(p); return c.visibility === "visible" && p.getBoundingClientRect().y < innerHeight - 5; };
  const openDrawer = async () => { if (!isDrawer() || drawerOpen()) return false; const t = toggleEl(); if (!t) return false; t.click(); await waitFor(drawerOpen, 1200); await settle(); return true; };
  const closeDrawer = async () => { if (!isDrawer() || !drawerOpen()) return false; const t = toggleEl(); if (!t) return false; t.click(); await waitFor(() => !drawerOpen(), 1200); await settle(); return true; };
  const hit = (el) => { const r = el.getBoundingClientRect(); const cx = r.x + r.width / 2; const cy = r.y + r.height / 2;
    const inView = cy >= 0 && cy <= innerHeight && cx >= 0 && cx <= innerWidth;
    const top = inView ? document.elementFromPoint(cx, cy) : null;
    return { box: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) }, inView, hitTag: top ? top.tagName : null,
      hitClass: top && typeof top.className === "string" ? top.className.slice(0, 60) : null, contains: top ? el.contains(top) : false }; };
  const interArea = (a, b) => { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x); const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? round(w * h) : 0; };
`;

/** Проверка 1: шторка/панель фильтров не наезжает на контент и не перекрыта сама. */
const JS_OVERLAP = String.raw`(async () => {
  try {
${PAGE_HELPERS}
    const panel = panelEl(); const grid = gridEl(); const layout = layoutEl();
    if (!panel || !grid || !layout) return JSON.stringify({ error: "нет .ll-filters/#ll-filters-panel, .ll-grid или .ll-layout" });
    const mode = isDrawer() ? "drawer" : "static-column";
    const collapsible = layout.className.indexOf("filters-collapsible") >= 0;
    const gridBox = box(grid);
    const result = { mode, collapsible, panelPresent: true, gridPresent: true, gridBox: { x: round(gridBox.x), y: round(gridBox.y), w: round(gridBox.w), h: round(gridBox.h) } };
    if (mode === "static-column") {
      result.panelPosition = getComputedStyle(panel).position;
      result.panelBox = box(panel);
      result.panelGridOverlapPx = interArea(box(panel), gridBox);
      return JSON.stringify(result);
    }
    result.drawerOpenedByRunner = await openDrawer();
    result.drawerOpen = drawerOpen();
    result.panelBox = box(panel);
    result.panelGridOverlapPx = interArea(box(panel), gridBox);
    const p = panel.getBoundingClientRect();
    const cx = p.x + p.width / 2; const cy = p.y + Math.min(30, p.height / 3);
    const topInPanel = document.elementFromPoint(cx, cy);
    result.panelCenterTag = topInPanel ? topInPanel.tagName + "." + (typeof topInPanel.className === "string" ? topInPanel.className.slice(0, 50) : "") : null;
    result.panelCenterInside = topInPanel ? panel.contains(topInPanel) : false;
    // Управление шторки должно быть кликабельно: шапка панели и кнопка «Показать».
    const head = panel.querySelector(".ll-filters-head"); const apply = applyEl();
    result.headHit = head ? hit(head) : null;
    result.applyHit = apply ? hit(apply) : null;
    result.headHitInsidePanel = head && result.headHit ? panel.contains(document.elementFromPoint(result.headHit.box.x + result.headHit.box.w / 2, result.headHit.box.y + result.headHit.box.h / 2)) : null;
    const backdrop = document.querySelector(".ll-filters-backdrop");
    if (backdrop) { const bb = box(backdrop); const bc = getComputedStyle(backdrop);
      result.backdrop = { z: bc.zIndex, panelZ: getComputedStyle(panel).zIndex, covers: bb.w > 0 && bb.h > 0 && bc.display !== "none",
        interceptsPanelCenter: topInPanel ? backdrop.contains(topInPanel) : null }; }
    result.drawerClosedByRunner = await closeDrawer();
    result.drawerOpenAfterRestore = drawerOpen();
    return JSON.stringify(result);
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/** Проверка 2: последний бренд списка достижим — виден и не закрыт чужим элементом. */
const JS_LAST_BRAND = String.raw`(async () => {
  try {
${PAGE_HELPERS}
    const panel = panelEl();
    if (!panel) return JSON.stringify({ error: "нет панели .ll-filters/#ll-filters-panel" });
    const list = brandLabels();
    if (list.length === 0) return JSON.stringify({ error: "в панели нет ни одного чекбокса input[name=brand]" });
    const input = brands()[brands().length - 1];
    const label = list[list.length - 1];
    const savedPanelScroll = panel.scrollTop;
    const savedPageScroll = window.scrollY;
    const opened = await openDrawer();
    label.scrollIntoView({ block: "center", inline: "nearest" });
    await settle();
    const info = hit(label);
    const c = getComputedStyle(label);
    const panelBox = box(panel);
    const insidePanel = info.box.x >= panelBox.x - 1 && info.box.x + info.box.w <= panelBox.x + panelBox.w + 1 &&
      info.box.y >= panelBox.y - 1 && info.box.y + info.box.h <= panelBox.y + panelBox.h + 1;
    const out = { brandCount: brands().length, openedDrawer: opened, inView: info.inView, box: info.box,
      offsetParentNull: input.offsetParent === null, labelVisible: visible(label), display: c.display, visibility: c.visibility,
      hitTag: info.hitTag, hitClass: info.hitClass, hitInsideLabel: info.contains, insidePanel, insideViewportBox: info.inView,
      panelBox: { x: round(panelBox.x), y: round(panelBox.y), w: round(panelBox.w), h: round(panelBox.h) } };
    panel.scrollTop = savedPanelScroll; window.scrollTo(0, savedPageScroll);
    if (opened) await closeDrawer();
    await settle();
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/** Проверка 3: горизонтального переполнения документа нет. */
const JS_OVERFLOW = String.raw`(async () => {
  try {
${PAGE_HELPERS}
    const de = document.documentElement;
    const wide = all("body *").filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
      .slice(0, 5).map((el) => el.tagName + "." + (typeof el.className === "string" ? el.className.slice(0, 40) : ""));
    return JSON.stringify({ scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, bodyScrollWidth: document.body.scrollWidth,
      delta: de.scrollWidth - de.clientWidth, widest: wide });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/** Проверка 4 (часть 1): кнопка «Показать N» живая — счётчик реагирует на фильтр. */
const JS_BUTTONS_ARM = String.raw`(async () => {
  try {
${PAGE_HELPERS}
    const apply = applyEl(); const reset = resetEl();
    if (!apply || !reset) return JSON.stringify({ error: "нет .ll-filters-apply или .ll-filters-reset" });
    const cb = brands()[0];
    if (!cb) return JSON.stringify({ error: "нет чекбокса бренда для пробы" });
    const text = (el) => (el ? el.textContent.replace(/[ \t\n]+/g, " ").trim() : null);
    const before = { count: text(countEl()), checked: brands().filter((i) => i.checked).length, applyText: text(apply),
      applyHasCounter: !!apply.querySelector("[data-ll-count]"), resetTag: reset.tagName, resetHref: reset.getAttribute("href"), url: location.href };
    cb.click();
    const reacted = await waitFor(() => countEl() && text(countEl()) !== before.count, 2500);
    if (!reacted) await sleep(400);
    const afterClick = { count: text(countEl()), checked: brands().filter((i) => i.checked).length, url: location.href };
    return JSON.stringify({ before, afterClick, counterReacted: reacted });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/** Снимок состояния после «Сбросить» (навигация могла перезагрузить страницу). */
const JS_BUTTONS_STATE = String.raw`(async () => {
  try {
${PAGE_HELPERS}
    const el = countEl();
    return JSON.stringify({ count: el ? el.textContent.replace(/[ \t\n]+/g, " ").trim() : null,
      checked: brands().filter((i) => i.checked).length, url: location.href,
      applyText: applyEl() ? applyEl().textContent.replace(/[ \t\n]+/g, " ").trim() : null,
      themeAttr: document.documentElement.dataset.theme || null });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/** Проверка 5: тема применена и две темы действительно различаются. */
const JS_THEME = String.raw`(async () => {
  try {
${PAGE_HELPERS}
    const want = "__THEME__";
    const other = want === "dark" ? "light" : "dark";
    const setTheme = (t) => { try { localStorage.setItem("ll-theme", t); } catch (e) {} document.documentElement.dataset.theme = t; };
    const lum = () => { const c = getComputedStyle(document.body).backgroundColor; const m = c.match(/[0-9.]+/g);
      if (!m || m.length < 3) return null; const r = Number(m[0]); const g = Number(m[1]); const b = Number(m[2]);
      return Math.round(((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 1000) / 1000; };
    const mediaDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(want); await settle();
    const applied = { attr: document.documentElement.dataset.theme || null, bodyBg: getComputedStyle(document.body).backgroundColor,
      lum: lum(), mediaDark: mediaDark(), stored: (() => { try { return localStorage.getItem("ll-theme"); } catch (e) { return null; } })(),
      toggleExists: !!document.querySelector("#ll-theme-toggle") };
    setTheme(other); await settle();
    const otherLum = lum();
    setTheme(want); await settle();
    return JSON.stringify({ want, other, applied, otherLum, contrast: applied.lum === null || otherLum === null ? null : Math.round(Math.abs(applied.lum - otherLum) * 1000) / 1000 });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

function themeScript(theme: Theme): string {
	return JS_THEME.replace('"__THEME__"', JSON.stringify(theme));
}

// ── Chrome и сессия ──────────────────────────────────────────────────────────

export interface ChromeHandle {
	child: ChildProcess;
	profile: string;
	wsUrl: string;
	version: string;
}

async function launchChrome(chromePath: string, timeoutMs: number): Promise<ChromeHandle> {
	const profile = mkdtempSync(join(tmpdir(), "visual-runner-"));
	const child = spawn(
		chromePath,
		[
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-dev-shm-usage",
			"--disable-extensions",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let buffer = "";
	let stderr = "";
	const timer = setTimeout(() => reject(new Error(`Chrome не поднялся за ${timeoutMs} мс: ${stderr.slice(-300)}`)), timeoutMs);
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
		buffer += chunk.toString();
		const match = buffer.match(/ws:\/\/[^\s]+/);
		if (match) {
			clearTimeout(timer);
			resolve(match[0]);
		}
	});
	child.on("exit", (code: number | null) => {
		clearTimeout(timer);
		reject(new Error(`Chrome завершился (код ${code}) до открытия CDP-порта: ${stderr.slice(-300)}`));
	});
	const version = readChromeVersion(chromePath);
	return { child, profile, wsUrl: await promise, version };
}

function readChromeVersion(chromePath: string): string {
	try {
		const result = Bun.spawnSync([chromePath, "--version"], { stdout: "pipe", stderr: "pipe" });
		const text = result.stdout.toString().trim();
		if (text.length > 0) return text;
	} catch {
		/* неизвестная версия честнее выдуманной ниже — вернём явный маркер */
	}
	return `unknown (${chromePath})`;
}

function gitInfo(cwd: string): { commit: string; diffHash: string } {
	try {
		const head = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
		if (head.exitCode !== 0) return { commit: "", diffHash: "" };
		const commit = head.stdout.toString().trim();
		const diff = Bun.spawnSync(["git", "-C", cwd, "diff", "HEAD"], { stdout: "pipe", stderr: "pipe" });
		const diffHash = diff.exitCode === 0 ? sha256Hex(diff.stdout) : "";
		return { commit, diffHash };
	} catch {
		return { commit: "", diffHash: "" };
	}
}

// ── проверки (решение принимает хост, страница только измеряет) ──────────────

function checkOverlap(m: Record<string, unknown>): DomCheck {
	const mode = readString(m, "mode") ?? "unknown";
	const overlap = readNumber(m, "panelGridOverlapPx") ?? -1;
	if (mode === "static-column") {
		const position = readString(m, "panelPosition") ?? "?";
		const panelBox = asRecord(m.panelBox);
		const detail = `колоночная панель (position:${position}), пересечение с .ll-grid = ${overlap}px²`;
		if (overlap !== 0) return { ok: false, detail: `${detail} — панель наезжает на сетку` };
		if (!panelBox) return { ok: false, detail: `${detail} — не удалось измерить бокс панели` };
		if (readNumber(panelBox, "w") === 0) return { ok: false, detail: `${detail} — нулевая ширина панели` };
		return { ok: true, detail };
	}
	const open = readBool(m, "drawerOpen") === true;
	const centerInside = readBool(m, "panelCenterInside") === true;
	const applyHit = asRecord(m.applyHit);
	const headHit = asRecord(m.headHit);
	const clickable = (entry: Record<string, unknown> | null): boolean =>
		entry !== null && readBool(entry, "inView") === true && readBool(entry, "contains") === true;
	const applyOk = clickable(applyHit);
	const headOk = clickable(headHit);
	const backdrop = asRecord(m.backdrop);
	const backdropOk = backdrop === null || readBool(backdrop, "interceptsPanelCenter") !== true;
	const detail =
		`шторка (drawer): открыта=${open}, центр панели внутри панели=${centerInside}, ` +
		`шапка панели кликабельна=${headOk}, «Показать» кликабельна=${applyOk}, подложка не перехватывает=${backdropOk}, ` +
		`пересечение с .ll-grid=${overlap}px² (шторка законно лежит поверх контента), ` +
		`закрыта после замера=${readBool(m, "drawerOpenAfterRestore") === false}`;
	if (!open) return { ok: false, detail: `${detail} — шторка не открылась` };
	if (!centerInside) return { ok: false, detail: `${detail} — в центре панели лежит чужой элемент` };
	if (!headOk) return { ok: false, detail: `${detail} — шапка панели перекрыта` };
	if (!applyOk) return { ok: false, detail: `${detail} — кнопка «Показать» перекрыта` };
	if (!backdropOk) return { ok: false, detail: `${detail} — подложка перекрывает панель` };
	return { ok: true, detail };
}

function checkLastBrand(m: Record<string, unknown>): DomCheck {
	const count = readNumber(m, "brandCount") ?? 0;
	const inView = readBool(m, "inView") === true;
	const labelVisible = readBool(m, "labelVisible") === true;
	const offsetParentNull = readBool(m, "offsetParentNull") === true;
	const hitInside = readBool(m, "hitInsideLabel") === true;
	const insidePanel = readBool(m, "insidePanel") === true;
	const box = asRecord(m.box);
	const boxText = box ? `${readNumber(box, "w")}×${readNumber(box, "h")} @ y=${readNumber(box, "y")}` : "?";
	const detail =
		`последний из ${count} брендов: бокс ${boxText}, в кадре=${inView}, виден=${labelVisible}, ` +
		`offsetParent=null:${offsetParentNull}, точка центра попадает в него=${hitInside}, внутри панели=${insidePanel}`;
	if (count === 0) return { ok: false, detail: `${detail} — чекбоксов бренда нет` };
	if (offsetParentNull) return { ok: false, detail: `${detail} — элемент не отрисован (offsetParent=null)` };
	if (!labelVisible) return { ok: false, detail: `${detail} — элемент скрыт CSS` };
	if (!inView) return { ok: false, detail: `${detail} — элемент не попал в кадр даже после scrollIntoView` };
	if (!hitInside) return { ok: false, detail: `${detail} — центр перекрыт другим элементом` };
	if (!insidePanel) return { ok: false, detail: `${detail} — вылез за пределы панели фильтров` };
	return { ok: true, detail };
}

function checkOverflow(m: Record<string, unknown>): DomCheck {
	const scrollWidth = readNumber(m, "scrollWidth");
	const clientWidth = readNumber(m, "clientWidth");
	if (scrollWidth === null || clientWidth === null) return { ok: false, detail: "не удалось измерить scrollWidth/clientWidth" };
	const delta = scrollWidth - clientWidth;
	const widest = m.widest;
	const widestText = Array.isArray(widest) && widest.length > 0 ? `; шире всех: ${widest.join(", ")}` : "";
	const detail = `documentElement.scrollWidth=${scrollWidth}, clientWidth=${clientWidth}, дельта=${delta}${widestText}`;
	if (delta > 1) return { ok: false, detail: `${detail} — горизонтальное переполнение` };
	return { ok: true, detail };
}

function checkButtons(arm: Record<string, unknown>, state: Record<string, unknown>): DomCheck {
	const before = asRecord(arm.before) ?? {};
	const afterClick = asRecord(arm.afterClick) ?? {};
	const counters = {
		before: readString(before, "count"),
		afterClick: readString(afterClick, "count"),
		afterReset: readString(state, "count"),
	};
	const checkedBefore = readNumber(before, "checked") ?? -1;
	const checkedAfterClick = readNumber(afterClick, "checked") ?? -1;
	const checkedAfterReset = readNumber(state, "checked") ?? -1;
	const applyText = readString(before, "applyText") ?? "";
	const hasCounter = readBool(before, "applyHasCounter") === true;
	const reacted = readBool(arm, "counterReacted") === true;
	const resetTag = readString(before, "resetTag") ?? "?";
	const urlChanged = readString(before, "url") !== readString(state, "url");
	const detail =
		`«${applyText}» (счётчик в кнопке=${hasCounter}); до пробы отмечено=${checkedBefore}, счётчик=${counters.before}; ` +
		`после отметки бренда отмечено=${checkedAfterClick}, счётчик=${counters.afterClick} (реакция счётчика=${reacted}); ` +
		`«Сбросить» (${resetTag}) → отмечено=${checkedAfterReset}, счётчик=${counters.afterReset}, url сменился=${urlChanged}`;
	if (!hasCounter) return { ok: false, detail: `${detail} — в кнопке «Показать» нет [data-ll-count]` };
	if (checkedBefore !== 0) return { ok: false, detail: `${detail} — на входе уже были отмечены бренды` };
	if (checkedAfterClick < 1) return { ok: false, detail: `${detail} — чекбокс бренда не отметился` };
	if (!reacted) return { ok: false, detail: `${detail} — счётчик «Показать N» не отреагировал на фильтр` };
	if (counters.afterClick === counters.before) return { ok: false, detail: `${detail} — счётчик не изменился` };
	if (checkedAfterReset !== 0) return { ok: false, detail: `${detail} — «Сбросить» не снял отметку` };
	if (counters.afterReset !== counters.before) return { ok: false, detail: `${detail} — после сброса счётчик не вернулся к исходному ` };
	return { ok: true, detail };
}

function checkTheme(m: Record<string, unknown>, want: Theme, emulated: string): DomCheck {
	const applied = asRecord(m.applied) ?? {};
	const attr = readString(applied, "attr");
	const stored = readString(applied, "stored");
	const lum = readNumber(applied, "lum");
	const otherLum = readNumber(m, "otherLum");
	const contrast = readNumber(m, "contrast");
	const mediaDark = readBool(applied, "mediaDark");
	const expectedMedia = want === "dark";
	const detail =
		`тема ${want}: data-theme=${attr}, localStorage=${stored}, фон body=${readString(applied, "bodyBg")} (яркость ${lum}), ` +
		`prefers-color-scheme:dark под эмуляцией=${mediaDark} (в CDP выставлено ${emulated}), ` +
		`яркость другой темы=${otherLum}, контраст=${contrast}`;
	if (attr !== want) return { ok: false, detail: `${detail} — data-theme не равен ${want}` };
	if (stored !== want) return { ok: false, detail: `${detail} — сайт хранит тему не так, как ожидалось` };
	if (lum === null) return { ok: false, detail: `${detail} — не удалось прочитать фон body` };
	if (mediaDark !== expectedMedia) return { ok: false, detail: `${detail} — эмуляция prefers-color-scheme не подействовала` };
	if (want === "light" && lum <= 0.6) return { ok: false, detail: `${detail} — светлая тема темнее порога 0.6` };
	if (want === "dark" && lum >= 0.4) return { ok: false, detail: `${detail} — тёмная тема светлее порога 0.4` };
	if (contrast === null || contrast <= 0.2) return { ok: false, detail: `${detail} — темы почти не различаются` };
	return { ok: true, detail };
}

// ── основной прогон ──────────────────────────────────────────────────────────

interface Session {
	cdp: Cdp;
	sessionId: string;
	chrome: ChromeHandle;
	timeoutMs: number;
	url: string;
}

async function evaluate(session: Session, script: string): Promise<string> {
	const result = await session.cdp.send(
		"Runtime.evaluate",
		{ expression: script, returnByValue: true, awaitPromise: true, userGesture: true },
		session.sessionId,
	);
	const inner = asRecord(result.result);
	const value = inner ? inner.value : undefined;
	if (typeof value !== "string") throw new Error(`страница вернула не строку: ${JSON.stringify(result).slice(0, 200)}`);
	return value;
}

/** Клик, после которого страница может уехать: ответ может не прийти — это не ошибка. */
async function fireAndForget(session: Session, script: string): Promise<void> {
	await session.cdp
		.send("Runtime.evaluate", { expression: script, returnByValue: true, awaitPromise: false, userGesture: true }, session.sessionId)
		.catch(() => undefined);
}

interface Measurement {
	record: Record<string, unknown> | null;
	error: string | null;
}

/** Замер страницы с одной повторной попыткой: после перезагрузки контекст живёт не сразу. */
async function measure(session: Session, script: string, what: string): Promise<Measurement> {
	let lastError: string | null = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return { record: parseMeasurements(await evaluate(session, script), what), error: null };
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt === 0) await sleep(400);
		}
	}
	return { record: null, error: lastError };
}

/** Решение принимает хост: страница только измеряет, провал измерения — честный FAIL. */
function verdict(m: Measurement, what: string, decide: (record: Record<string, unknown>) => DomCheck): DomCheck {
	if (m.record) return decide(m.record);
	return { ok: false, detail: `измерение «${what}» не удалось: ${m.error}` };
}

async function navigate(session: Session, url: string, timeoutMs: number): Promise<void> {
	const loaded = session.cdp.waitForEvent("Page.loadEventFired", session.sessionId, timeoutMs);
	await session.cdp.send("Page.navigate", { url }, session.sessionId);
	const ok = await loaded;
	if (!ok) throw new Error(`страница не догрузилась за ${timeoutMs} мс: ${url}`);
	await evaluate(session, "(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r('frames')))))()");
	await sleep(300);
}

async function scrollTo(session: Session, position: Position): Promise<void> {
	const script =
		position === "top"
			? "window.scrollTo(0, 0); 'top'"
			: position === "middle"
				? "window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2)); 'middle'"
				: "window.scrollTo(0, document.documentElement.scrollHeight); 'bottom'";
	await evaluate(session, `(async () => { ${script}; const f=(n)=>new Promise(r=>{let l=n;const s=()=>(l--<=0?r(1):requestAnimationFrame(s));s();}); await f(2); await new Promise(r=>setTimeout(r,300)); return 'ok'; })()`);
}

async function captureShot(session: Session, outDir: string, relativePath: string): Promise<Shot> {
	const position = relativePath.replace(/^.*-/, "").replace(/\.png$/, "") as Position;
	const result = await session.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, session.sessionId);
	const data = readString(result, "data");
	if (!data) return { position, path: relativePath, sha256: "", bytes: 0 };
	const bytes = Buffer.from(data, "base64");
	const fullPath = join(outDir, relativePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, bytes);
	return { position, path: relativePath, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
}

async function runCombo(session: Session, combo: { viewport: Viewport; theme: Theme }, outDir: string): Promise<Combo> {
	const { viewport, theme } = combo;
	const dom: Record<CheckName, DomCheck> = {
		overlap: { ok: false, detail: "не выполнялась" },
		lastBrand: { ok: false, detail: "не выполнялась" },
		horizontalOverflow: { ok: false, detail: "не выполнялась" },
		buttons: { ok: false, detail: "не выполнялась" },
		theme: { ok: false, detail: "не выполнялась" },
	};
	const shots: Shot[] = [];
	await session.cdp.send(
		"Emulation.setDeviceMetricsOverride",
		{ width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width < 700 },
		session.sessionId,
	);
	await session.cdp.send(
		"Emulation.setEmulatedMedia",
		{ features: [{ name: "prefers-color-scheme", value: theme }] },
		session.sessionId,
	);
	// Тема должна быть выставлена до бутстрапа страницы: сайт читает localStorage("ll-theme").
	const bootstrap = await session.cdp.send(
		"Page.addScriptToEvaluateOnNewDocument",
		{ source: `try { localStorage.setItem("ll-theme", ${JSON.stringify(theme)}); } catch (e) {}` },
		session.sessionId,
	);
	const bootstrapId = readString(bootstrap, "identifier");
	try {
		await navigate(session, session.url, session.timeoutMs);
		const forced = themeScript(theme);
		// Тема задаётся тем же способом, что и на сайте: dataset.theme + localStorage.
		await evaluate(session, forced);
		for (const position of POSITIONS) {
			await scrollTo(session, position);
			shots.push(await captureShot(session, outDir, shotPath(viewport, theme, position)));
		}
		const overlapM = await measure(session, JS_OVERLAP, "overlap");
		const lastBrandM = await measure(session, JS_LAST_BRAND, "lastBrand");
		const overflowM = await measure(session, JS_OVERFLOW, "horizontalOverflow");
		const themeM = await measure(session, forced, "theme");
		dom.overlap = verdict(overlapM, "overlap", checkOverlap);
		dom.lastBrand = verdict(lastBrandM, "lastBrand", checkLastBrand);
		dom.horizontalOverflow = verdict(overflowM, "horizontalOverflow", checkOverflow);
		dom.theme = verdict(themeM, "theme", (record) => checkTheme(record, theme, theme));
		// Кнопки: сначала отметка бренда и живой счётчик, потом «Сбросить» (может быть ссылкой с перезагрузкой).
		const arm = await measure(session, JS_BUTTONS_ARM, "buttons");
		if (!arm.record) {
			dom.buttons = { ok: false, detail: `проба кнопок не удалась: ${arm.error}` };
		} else {
			const navigationPossible = (readString(asRecord(arm.record.before) ?? {}, "resetTag") ?? "").toUpperCase() === "A";
			const loaded = navigationPossible
				? session.cdp.waitForEvent("Page.loadEventFired", session.sessionId, session.timeoutMs)
				: Promise.resolve(false);
			await fireAndForget(session, "document.querySelector('.ll-filters-reset').click(); 'clicked'");
			if (navigationPossible) await loaded;
			await sleep(600);
			const state = await measure(session, JS_BUTTONS_STATE, "buttonsState");
			dom.buttons = checkButtons(arm.record, state.record ?? {});
			await evaluate(session, forced);
		}
	} finally {
		if (bootstrapId) {
			await session.cdp
				.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: bootstrapId }, session.sessionId)
				.catch(() => undefined);
		}
	}
	return { viewport, theme, shots, dom };
}

export async function run(options: CliOptions): Promise<{ evidence: Evidence; outDir: string }> {
	const startedAt = new Date();
	const outDir = options.out;
	mkdirSync(join(outDir, "shots"), { recursive: true });
	const key = loadOrCreateKey(options.keyPath);
	const chrome = await launchChrome(options.chrome, Math.max(options.timeoutMs, 20_000));
	let chromeRunning = true;
	// Chrome и его временный профиль убираются в любом исходе, кроме --keep-open.
	const stopChrome = (): void => {
		if (!chromeRunning) return;
		chromeRunning = false;
		chrome.child.kill();
		rmSync(chrome.profile, { recursive: true, force: true });
	};
	try {
		return { evidence: await drive(options, outDir, chrome, key, startedAt), outDir };
	} finally {
		if (!options.keepOpen) stopChrome();
	}
}

async function drive(
	options: CliOptions,
	outDir: string,
	chrome: ChromeHandle,
	key: KeyPairPem,
	startedAt: Date,
): Promise<Evidence> {
	const cdp = await Cdp.connect(chrome.wsUrl, Math.max(options.timeoutMs, 10_000));
	const created = await cdp.send("Target.createTarget", { url: "about:blank" });
	const targetId = readString(created, "targetId");
	if (!targetId) throw new Error("Chrome не отдал targetId");
	const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
	const sessionId = readString(attached, "sessionId");
	if (!sessionId) throw new Error("Chrome не отдал sessionId");
	await cdp.send("Page.enable", {}, sessionId);
	await cdp.send("Runtime.enable", {}, sessionId);
	const session: Session = { cdp, sessionId, chrome, timeoutMs: options.timeoutMs, url: options.url };
	// Разогрев: первый заход на холодный стенд может занять десятки секунд (сборка
	// страницы, кэш пуст). Дальше комбинации идут по кэшу и укладываются в --timeout-ms.
	const warmupMs = Math.max(options.timeoutMs, 60_000);
	try {
		await navigate(session, options.url, warmupMs);
	} catch (error) {
		cdp.close();
		throw new Error(`страница не открылась даже за ${warmupMs} мс: ${error instanceof Error ? error.message : String(error)}`);
	}
	const matrix = buildMatrix(options.viewports, options.themes);
	const combos: Combo[] = [];
	let combosDone = 0;
	for (const combo of matrix) {
		combosDone += 1;
		process.stderr.write(`[visual-runner] комбинация ${combosDone}/${matrix.length}: ${combo.viewport.width}x${combo.viewport.height} ${combo.theme}\n`);
		try {
			combos.push(await runCombo(session, combo, outDir));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[visual-runner] комбинация упала: ${message}\n`);
			combos.push({
				viewport: combo.viewport,
				theme: combo.theme,
				shots: POSITIONS.map((position) => ({ position, path: shotPath(combo.viewport, combo.theme, position), sha256: "", bytes: 0 })),
				dom: {
					overlap: { ok: false, detail: `комбинация не отработала: ${message}` },
					lastBrand: { ok: false, detail: `комбинация не отработала: ${message}` },
					horizontalOverflow: { ok: false, detail: `комбинация не отработала: ${message}` },
					buttons: { ok: false, detail: `комбинация не отработала: ${message}` },
					theme: { ok: false, detail: `комбинация не отработала: ${message}` },
				},
			});
		}
	}
	const git = gitInfo(process.cwd());
	const finishedAt = new Date();
	const evidence: Evidence = {
		version: 1,
		slug: options.slug,
		url: options.url,
		commit: options.commit ?? git.commit,
		diffHash: options.diffHash ?? git.diffHash,
		runId: `vr-${sha256Hex(`${startedAt.toISOString()}${process.pid}${Math.random()}`).slice(0, 16)}`,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		runner: { keyId: keyIdFor(key.publicPem), chrome: chrome.version, host: hostname() },
		combos,
		totals: { combos: combos.length, shots: 0, failed: 0 },
	};
	// totals.shots — только реально записанные кадры (≥1024 байт); пустые кадры
	// не считаются снятыми, а идут в failed вместе с проваленными проверками.
	evidence.totals.shots = combos.reduce((sum, combo) => sum + combo.shots.filter((shot) => !isShotEmpty(shot.bytes)).length, 0);
	evidence.totals.failed = countFailures(combos, POSITIONS.length);
	const signature = signEvidence(evidence, key.privatePem);
	writeFileSync(join(outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
	writeFileSync(join(outDir, "evidence.sig"), `${signature}\n`);
	cdp.close();
	return evidence;
}

async function main(): Promise<number> {
	let options: CliOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.stderr.write(
			"visual-runner --url <URL> --slug <slug> --out <каталог> [--viewports ...] [--themes light,dark] [--key ...] [--chrome ...] [--commit sha] [--diff-hash hex] [--timeout-ms 30000] [--keep-open]\n",
		);
		return 2;
	}
	let result: { evidence: Evidence; outDir: string };
	try {
		result = await run(options);
	} catch (error) {
		process.stderr.write(`visual-runner не смог отработать: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	const { evidence, outDir } = result;
	process.stdout.write(
		`${JSON.stringify({
			slug: evidence.slug,
			url: evidence.url,
			runId: evidence.runId,
			out: outDir,
			chrome: evidence.runner.chrome,
			keyId: evidence.runner.keyId,
			totals: evidence.totals,
			commit: evidence.commit,
			diffHash: evidence.diffHash,
		})}\n`,
	);
	process.stdout.write(`[visual-runner] пакет: ${join(outDir, "evidence.json")} (+ evidence.sig)\n`);
	for (const combo of evidence.combos) {
		const bad = CHECK_NAMES.filter((name) => !combo.dom[name].ok);
		const sizes = combo.shots.map((shot) => `${shot.position}=${shot.bytes}B`).join(" ");
		process.stdout.write(
			`[visual-runner] ${combo.viewport.width}x${combo.viewport.height} ${combo.theme}: ${sizes}` +
				`${bad.length > 0 ? ` | ПРОВАЛ: ${bad.join(", ")}` : " | проверки OK"}\n`,
		);
	}
	return evidence.totals.failed > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
