import { useEffect, useState, type ReactNode } from "react";
import {
	fetchHosts,
	getGatewayBase,
	getToken,
	setGatewayBase,
	setToken,
	GatewayError,
} from "../../lib/gateway";
import { pushState, subscribePush, unsubscribePush, type PushState } from "../../lib/push";
import { useThemePreference } from "../../lib/theme";

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

function ConnectionSection(): ReactNode {
	const [base, setBase] = useState(getGatewayBase());
	const [token, setTok] = useState(getToken());
	const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
	const [checking, setChecking] = useState(false);

	const save = async (): Promise<void> => {
		setGatewayBase(base.trim());
		setToken(token.trim());
		setChecking(true);
		setCheck(null);
		try {
			const hosts = await fetchHosts();
			setCheck({ ok: true, message: `ОК: ${hosts.length} агент(ов)` });
		} catch (err) {
			const status = err instanceof GatewayError ? err.status : 0;
			setCheck({ ok: false, message: status === 401 ? "401: неверный токен" : `Ошибка: ${err instanceof Error ? err.message : String(err)}` });
		} finally {
			setChecking(false);
		}
	};

	return (
		<section className="pk-section">
			<h2 className="pk-section-title">Подключение</h2>
			<div className="pk-section-body">
				<label className="pk-field">
					<span>Адрес шлюза</span>
					<input
						className="pk-input"
						type="url"
						placeholder="http://192.168.1.10:8088"
						value={base}
						onInput={e => setBase(e.currentTarget.value)}
					/>
				</label>
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
				{check && <div className={check.ok ? "pk-check pk-check--ok" : "pk-check pk-check--err"}>{check.message}</div>}
			</div>
		</section>
	);
}

function PushSection(): ReactNode {
	const [state, setState] = useState<PushState>("unsubscribed");

	useEffect(() => {
		void pushState().then(setState);
	}, []);

	const toggle = async (): Promise<void> => {
		setState(await (state === "subscribed" ? unsubscribePush() : subscribePush()));
	};

	return (
		<section className="pk-section">
			<h2 className="pk-section-title">Push-уведомления</h2>
			<div className="pk-section-body">
				<div className="pk-fieldrow">
					<span>Оповещения об агентах</span>
					<span className="pk-muted">{PUSH_LABEL[state]}</span>
				</div>
				<button
					className="pk-btn"
					disabled={state === "unsupported" || state === "denied"}
					onClick={() => void toggle()}
				>
					{state === "subscribed" ? "Выключить" : "Включить"}
				</button>
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

export function SettingsScreen(): ReactNode {
	return (
		<div className="pk-list">
			<ConnectionSection />
			<PushSection />
			<DisplaySection />
			<section className="pk-section">
				<h2 className="pk-section-title">О программе</h2>
				<div className="pk-section-body">
					<div className="pk-fieldrow">
						<span>Версия</span>
						<span className="pk-muted">0.1.0</span>
					</div>
					<div className="pk-fieldrow">
						<span>Протокол</span>
						<span className="pk-muted">omp collab</span>
					</div>
					<div className="pk-fieldrow">
						<span>Шифрование</span>
						<span className="pk-muted">E2E AES-256-GCM, ключ в ссылке</span>
					</div>
				</div>
			</section>
		</div>
	);
}
