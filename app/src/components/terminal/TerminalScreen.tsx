import { ArrowLeft, CornerDownLeft, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getTerminal, sendTerminalKeys, sendTerminalText } from "../../lib/gateway";
import { parseTerminalAnsi, type TerminalAnsiSpan } from "../../lib/terminal-ansi";
import "./terminal.css";

const POLL_MS = 2500;

/** Рендерим хвост снапшота: полный может быть мегабайтом скроллбака. */
const MAX_LINES = 700;
/** Псевдографика/блоки/стрелки — строки TUI-таблиц, которым нужны колонки. */
const BOX_RE = /[\u2500-\u257F\u2580-\u259F\u2190-\u21FF\u25A0-\u25CF]/;

const NAV_KEYS = [
	{ key: "esc", label: "Esc" },
	{ key: "tab", label: "Tab" },
	{ key: "up", label: "↑" },
	{ key: "down", label: "↓" },
	{ key: "left", label: "←" },
	{ key: "right", label: "→" },
	{ key: "space", label: "Space" },
] as const;

export function TerminalAnsiLine({ spans }: { spans: TerminalAnsiSpan[] }): ReactNode {
	return <>{spans.map((span, i) => <span key={i} style={span.style}>{span.text}</span>)}</>;
}

export function TerminalScreen(props: { instanceId: string; label: string; onBack: () => void }): ReactNode {
	const { instanceId, label, onBack } = props;
	const [snapshot, setSnapshot] = useState<{ text: string; format?: "ansi" } | null>(null);
	const text = snapshot?.text ?? null;
	const ansi = snapshot?.format === "ansi";
	const { lines, cut } = useMemo(() => {
		if (ansi) return parseTerminalAnsi(text ?? "");
		const all = (text ?? "").split("\n");
		const hidden = Math.max(0, all.length - MAX_LINES);
		return { lines: (hidden > 0 ? all.slice(-MAX_LINES) : all).map(text => [{ text, style: {} }]), cut: hidden };
	}, [text, ansi]);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const preRef = useRef<HTMLDivElement | null>(null);
	const tailLock = useRef(true);

	const refresh = useCallback(async () => {
		try {
			const result = await getTerminal(instanceId, "ansi");
			if (result === null) setError("Хост недоступен");
			else if ("error" in result) setError("Терминал недоступен");
			else {
				setSnapshot(result);
				setError(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [instanceId]);

	// Initial read + auto-poll while visible.
	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => void refresh(), POLL_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	// Tail-follow: stick to bottom on new output unless the user scrolled up.
	// Горизонтальную позицию НЕ трогаем: пользователь читает таблицу справа.
	useLayoutEffect(() => {
		const el = preRef.current;
		if (!el || !tailLock.current) return;
		el.scrollTop = el.scrollHeight;
	}, [text, ansi]);

	const [hScroll, setHScroll] = useState(false);
	const syncHScroll = useCallback((el: HTMLElement) => {
		setHScroll(el.scrollWidth - el.scrollLeft - el.clientWidth > 12);
	}, []);

	const onScroll = useCallback(() => {
		const el = preRef.current;
		if (!el) return;
		tailLock.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
		syncHScroll(el);
	}, [syncHScroll]);

	// Фейд справа актуален и после каждого нового снапшота.
	useLayoutEffect(() => {
		const el = preRef.current;
		if (el) syncHScroll(el);
	}, [text, ansi, syncHScroll]);

	const tapKey = useCallback(
		async (key: string) => {
			setBusy(true);
			try {
				await sendTerminalKeys(instanceId, [key]);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		},
		[instanceId, refresh],
	);

	const sendDraft = useCallback(async () => {
		const value = draft;
		if (value.length === 0 || busy) return;
		setBusy(true);
		try {
			await sendTerminalText(instanceId, value);
			await sendTerminalKeys(instanceId, ["enter"]);
			// Строка стирается только после успешной отправки: при обрыве
			// набранное остаётся в поле и не набирается заново.
			setDraft("");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [busy, draft, instanceId, refresh]);

	return (
		<div className="ts-root">
			<header className="ts-header">
				<div className="ts-nav">
					<button type="button" className="ts-icon-btn" onClick={onBack} aria-label="Назад">
						<ArrowLeft size={22} />
					</button>
					<button type="button" className="ts-icon-btn" onClick={() => void refresh()} aria-label="Обновить">
						<RefreshCw size={20} />
					</button>
				</div>
				<h1 className="ts-title">Терминал</h1>
				<div className="ts-label">{label}</div>
			</header>

			{error != null && <div className="ts-error">{error}</div>}

			<div className={`ts-screen-wrap${hScroll ? " ts-screen-wrap--scroll" : ""}`}>
				<div ref={preRef} className="ts-screen" onScroll={onScroll}>
					{cut > 0 && (
						<div className="ts-line ts-line--cut">… выше скрыто {cut.toLocaleString("ru-RU")} строк</div>
					)}
					{lines.map((spans, i) => {
						const plain = spans.map(span => span.text).join("");
						return (
							<div key={i} className={`ts-line${ansi ? " ts-line--ansi" : BOX_RE.test(plain) ? " ts-line--grid" : ""}`}>
								{ansi ? <TerminalAnsiLine spans={spans} /> : plain}
							</div>
						);
					})}
				</div>
			</div>

			<div className="ts-keys-zone">
				<div className="ts-key-row">
					<button
						type="button"
						className="ts-key ts-key--interrupt"
						disabled={busy}
						onClick={() => void tapKey("ctrl+c")}
					>
						Прервать (Ctrl+C)
					</button>
				</div>
				<div className="ts-key-row">
					{NAV_KEYS.map(k => (
						<button key={k.key} type="button" className="ts-key" disabled={busy} onClick={() => void tapKey(k.key)}>
							{k.label}
						</button>
					))}
				</div>
				<div className="ts-input-row">
					<input
						className="ts-input"
						value={draft}
						placeholder="ввести текст…"
						onChange={e => setDraft(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") void sendDraft();
						}}
					/>
					<button
						type="button"
						className="ts-send"
						disabled={draft.length === 0 || busy}
						aria-label="Отправить строку"
						onClick={() => void sendDraft()}
					>
						<CornerDownLeft size={18} />
					</button>
				</div>
			</div>
		</div>
	);
}
