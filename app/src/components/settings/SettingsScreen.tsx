import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import {
	fetchUpdateStatus,
	getActiveBase,
	getGatewayBase,
	getGatewayBases,
	getToken,
	pingBase,
	setActiveBase,
	setGatewayBases,
	setToken,
} from "../../lib/gateway";
import { APP_VERSION } from "../../lib/format";
import { pushState, subscribePush, unsubscribePush, type PushState } from "../../lib/push";
import { useThemePreference } from "../../lib/theme";
import {
	getTtsRate,
	isTtsEnabled,
	setTtsEnabled,
	setTtsRate,
	TTS_RATE_MAX,
	TTS_RATE_MIN,
} from "../../lib/tts";
import "./settings.css";

const PUSH_LABEL: Record<PushState, string> = {
	unsupported: "не поддерживается",
	denied: "запрещены в браузере",
	subscribed: "включены",
	unsubscribed: "выключены",
};

const THEME_LABEL: Record<"system" | "dark" | "light", string> = {
	system: "Системная",
	dark: "Тёмная",
	light: "Светлая",
};

function ConnectionSection(props: { onToast: (text: string) => void }): ReactNode {
	const [draft, setDraft] = useState<string>(() => getGatewayBases().join("\n"));
	const [token, setTok] = useState(getToken());
	const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
	const [checking, setChecking] = useState(false);
	const [probes, setProbes] = useState<{ base: string; alive: boolean }[] | null>(null);
	const active = getActiveBase();

	const save = async (): Promise<void> => {
		const bases = draft
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
		// пустой список = приложение ходит на собственный origin
		const targets = bases.length > 0 ? bases : [""];
		setChecking(true);
		setCheck(null);
		setProbes(null);
		try {
			const results = await Promise.all(targets.map(async base => ({ base, alive: await pingBase(base) })));
			setProbes(results);
			const winner = results.find(r => r.alive);
			if (!winner) {
				setCheck({ ok: false, message: "Ни один адрес не отвечает — сохранены прежние значения" });
				return;
			}
			setGatewayBases(bases);
			setActiveBase(winner.base);
			setToken(token.trim());
			setCheck({ ok: true, message: `Активный адрес: ${winner.base || window.location.origin}` });
			props.onToast("Сохранено");
		} finally {
			setChecking(false);
		}
	};

	return (
		<section className="pk-section">
			<h2 className="pk-section-title">Подключение</h2>
			<div className="pk-section-body">
				<label className="pk-field">
					<span>Адреса шлюза</span>
					<textarea
						className="pk-input set-bases"
						rows={3}
						placeholder="пусто = как этот сайт"
						value={draft}
						onInput={e => setDraft(e.currentTarget.value)}
					/>
				</label>
				<div className="pk-fieldrow">
					<span>Текущий рабочий</span>
					<span className="set-row-end pk-muted set-base-active">{active || window.location.origin}</span>
				</div>
				<label className="pk-field">
					<span>Токен</span>
					<input
						className="pk-input"
						type="password"
						autoComplete="off"
						value={token}
						onInput={e => setTok(e.currentTarget.value)}
					/>
				</label>
				<button className="pk-btn" disabled={checking} onClick={() => void save()}>
					{checking ? "Проверяю…" : "Проверить"}
				</button>
				{probes && (
					<ul className="set-probe-list">
						{probes.map(p => (
							<li key={p.base || "origin"} className={p.alive ? "set-probe set-probe--ok" : "set-probe set-probe--bad"}>
								<span className="set-probe-base">{p.base || window.location.origin}</span>
								<span className="set-probe-state">{p.alive ? "жив" : "нет"}</span>
							</li>
						))}
					</ul>
				)}
				{check && <div className={check.ok ? "pk-check pk-check--ok" : "pk-check pk-check--err"}>{check.message}</div>}
				<p className="set-hint">
					Пусто = приложение использует собственный адрес. Примеры: LAN <code>https://192.0.2.11:8443</code>, публичный{" "}
					<code>https://pocket.example.com</code>.
				</p>
			</div>
		</section>
	);
}

function PushSection(): ReactNode {
	const [state, setState] = useState<PushState>("unsubscribed");
	const [testResult, setTestResult] = useState<string | null>(null);
	const [testing, setTesting] = useState(false);

	useEffect(() => {
		void pushState().then(setState);
	}, []);

	const toggle = async (): Promise<void> => {
		setTestResult(null);
		try {
			setState(await (state === "subscribed" ? unsubscribePush() : subscribePush()));
		} catch (err) {
			// Без рабочего шлюза/разрешения браузера тумблер молча не двигался.
			setTestResult(`Не удалось переключить уведомления: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const sendTest = async (): Promise<void> => {
		setTesting(true);
		setTestResult(null);
		try {
			const res = await fetch(`${getGatewayBase()}/api/push/test`, { method: "POST", headers: { authorization: `Bearer ${getToken()}` } });
			const data = (await res.json()) as { sent?: number };
			setTestResult(data.sent ? `Отправлено на ${data.sent} ${data.sent === 1 ? "устройство" : "устройств"} — пуш придёт через секунды` : "Нет подписок — включи тумблер выше");
		} catch {
			setTestResult("Шлюз недоступен");
		} finally {
			setTesting(false);
		}
	};

	return (
		<section className="pk-section">
			<h2 className="pk-section-title">Push-уведомления</h2>
			<div className="pk-section-body">
				<div className="pk-fieldrow">
					<span>Оповещения об агентах</span>
					<span className="set-row-end">
						<span className="pk-muted">{PUSH_LABEL[state]}</span>
						<button
							type="button"
							role="switch"
							aria-checked={state === "subscribed"}
							aria-label="Оповещения об агентах"
							className={`set-switch${state === "subscribed" ? " set-switch--on" : ""}`}
							disabled={state === "unsupported" || state === "denied"}
							onClick={() => void toggle()}
						/>
					</span>
				</div>
				{state === "denied" && (
					<div className="pk-check pk-check--err">Разрешите уведомления в настройках браузера</div>
				)}
				{state === "subscribed" && (
					<div className="pk-fieldrow">
						<span>Проверить пуш</span>
						<span className="set-row-end">
							<button type="button" className="pk-btn pk-btn--sm" disabled={testing} onClick={() => void sendTest()}>
								{testing ? "Отправляю…" : "Отправить"}
							</button>
						</span>
					</div>
				)}
				{testResult && <div className="pk-check">{testResult}</div>}
			</div>
		</section>
	);
}

function TtsSection(): ReactNode {
	const [on, setOn] = useState(isTtsEnabled);
	const [rate, setRate] = useState(getTtsRate);
	const [hint, setHint] = useState(false);

	const toggle = (): void => {
		const next = !on;
		setOn(next);
		setTtsEnabled(next);
		if (next) setHint(true);
	};

	return (
		<section className="pk-section">
			<h2 className="pk-section-title">Озвучка</h2>
			<div className="pk-section-body">
				<div className="pk-fieldrow">
					<span>Озвучивать ответы</span>
					<span className="set-row-end">
						<span className="pk-muted">{on ? "включено" : "выключено"}</span>
						<button
							type="button"
							role="switch"
							aria-checked={on}
							aria-label="Озвучивать ответы"
							className={`set-switch${on ? " set-switch--on" : ""}`}
							onClick={toggle}
						/>
					</span>
				</div>
				{on && hint && <div className="pk-check pk-check--ok">Готово — новые ответы агента будут произноситься голосом системы.</div>}
				{on && (
					<label className="pk-field">
						<span>Темп ({rate.toFixed(2)}×)</span>
						<input
							className="set-slider"
							type="range"
							min={TTS_RATE_MIN}
							max={TTS_RATE_MAX}
							step={0.05}
							value={rate}
							onInput={e => {
								const next = Number(e.currentTarget.value);
								setRate(next);
								setTtsRate(next);
							}}
						/>
					</label>
				)}
			</div>
		</section>
	);
}

function DisplaySection(): ReactNode {
	const [name, setName] = useState(() => {
		try {
			return localStorage.getItem("ompPocket.name") ?? "";
		} catch {
			return "";
		}
	});
	const { preference, setPreference } = useThemePreference();

	return (
		<section className="pk-section">
			<h2 className="pk-section-title">Отображение</h2>
			<div className="pk-section-body">
				<label className="pk-field">
					<span>Имя гостя</span>
					<input
						className="pk-input"
						type="text"
						placeholder="guest"
						value={name}
						onInput={e => {
							setName(e.currentTarget.value);
							try {
								localStorage.setItem("ompPocket.name", e.currentTarget.value);
							} catch {
								// storage unavailable — non-fatal
							}
						}}
					/>
				</label>
				<div className="pk-fieldrow">
					<span>Тема</span>
				</div>
				<div className="pk-segmented">
					{(["system", "dark", "light"] as const).map(mode => (
						<button
							key={mode}
							className={`pk-segment${preference === mode ? " pk-segment--on" : ""}`}
							onClick={() => setPreference(mode)}
						>
							{THEME_LABEL[mode]}
						</button>
					))}
				</div>
			</div>
		</section>
	);
}

/** Строка «О программе»: значение с ellipsis, тап копирует его. */
function AboutRow(props: { label: string; value: string; onToast: (text: string) => void }): ReactNode {
	const { label, value, onToast } = props;
	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(value);
			onToast("Скопировано");
		} catch {
			onToast("Не удалось скопировать");
		}
	};
	return (
		<button type="button" className="pk-fieldrow set-about-row" onClick={() => void copy()} aria-label={`${label}: скопировать`}>
			<span>{label}</span>
			<span className="pk-muted set-about-value">
				{value}
				<Copy size={13} aria-hidden="true" />
			</span>
		</button>
	);
}

export function SettingsScreen(props: { onOpenUpdates?: () => void; onOpenGoals?: () => void }): ReactNode {
	const { onOpenUpdates, onOpenGoals } = props;
	const [toast, setToast] = useState<string | null>(null);
	const [updateAvailable, setUpdateAvailable] = useState(false);

	// тихая проверка апдейтов — только ради точки-индикатора
	useEffect(() => {
		let alive = true;
		void fetchUpdateStatus()
			.then(status => {
				if (alive) setUpdateAvailable(status.components.some(c => c.updateAvailable));
			})
			.catch(() => {
				// шлюз недоступен — индикатор не показываем
			});
		return () => {
			alive = false;
		};
	}, []);

	const showToast = (text: string): void => {
		setToast(text);
		window.setTimeout(() => setToast(t => (t === text ? null : t)), 3000);
	};

	return (
		<div className="pk-list set-screen">
			{onOpenGoals && (
				<button type="button" className="pk-fieldrow" onClick={onOpenGoals}>
					<span className="pk-fieldrow-label">Автономные цели</span>
					<span className="pk-fieldrow-value">контроллер, доказательства, риски</span>
				</button>
			)}
			{onOpenUpdates && (
				<section className="pk-section">
					<div className="pk-section-body">
						<button type="button" className="pk-fieldrow set-updates-row" onClick={onOpenUpdates}>
							<span className="set-updates-label">
								Обновления
								{updateAvailable && <span className="set-updates-dot" aria-label="Доступно обновление" />}
							</span>
							<ChevronRight size={18} className="pk-muted" aria-hidden="true" />
						</button>
					</div>
				</section>
			)}
			<ConnectionSection onToast={showToast} />
			<PushSection />
			<TtsSection />
			<DisplaySection />
			<section className="pk-section">
				<h2 className="pk-section-title">О программе</h2>
				<div className="pk-section-body">
					<AboutRow label="Версия" value={APP_VERSION} onToast={showToast} />
					<AboutRow label="Протокол" value="omp collab" onToast={showToast} />
					<AboutRow label="Шифрование" value="E2E AES-256-GCM, ключ в ссылке" onToast={showToast} />
				</div>
			</section>
			{toast != null && (
				<div className="pk-toast" role="status">
					<span>{toast}</span>
					<button type="button" className="pk-toast-x" aria-label="Скрыть" onClick={() => setToast(null)}>
						<Check size={16} />
					</button>
				</div>
			)}
		</div>
	);
}
