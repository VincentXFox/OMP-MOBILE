import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Search, X } from "lucide-react";
import type { ModelOption } from "../../lib/gateway";
import { modelPriceLabel } from "../../lib/model-price";
import "./model-picker.css";

export interface ModelPickerSheetProps {
	open: boolean;
	title: string;
	models: readonly ModelOption[];
	/** Текущий селектор («provider/id») или null, если модель не задана явно. */
	current: string | null;
	/** Пункт «по умолчанию» (модель из настроек omp) — для создания агента. */
	allowDefault?: boolean;
	defaultLabel?: string;
	/** Идёт применение — выбор заблокирован, но лист видно. */
	busy?: boolean;
	error?: string | null;
	/** Смена модели невозможна (агент занят / вне панели шлюза) — причина на экране. */
	note?: string | null;
	/** Дополнительный блок над списком (например, чипы уровня усилия). */
	header?: ReactNode;
	/** Показывать поиск (в связанных листах он не нужен). */
	search?: boolean;
	onPick: (selector: string | null) => void;
	onClose: () => void;
}

function providerOf(selector: string): string {
	const idx = selector.indexOf("/");
	return idx > 0 ? selector.slice(0, idx) : selector;
}

function contextLabel(window: number): string {
	if (window <= 0) return "";
	if (window >= 1_000_000) return `${Math.round(window / 100_000) / 10}M контекст`;
	if (window >= 1000) return `${Math.round(window / 1000)}k контекст`;
	return `${window} контекст`;
}

/** Нижний лист выбора модели: поиск по каталогу omp + группировка по провайдеру. */
export function ModelPickerSheet(props: ModelPickerSheetProps): ReactNode {
	const { open, title, models, current, allowDefault = false, defaultLabel, busy = false, error = null, note = null, header = null, search = true, onPick, onClose } = props;
	const [query, setQuery] = useState("");
	const titleId = useId();
	const sheetRef = useRef<HTMLDivElement | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const restoreRef = useRef<HTMLElement | null>(null);
	// onClose приходит инлайновой стрелкой и меняет идентичность на каждый рендер
	// родителя (а он перерисовывается на каждом кадре снапшота): эффект открытия
	// не должен от этого перезапускаться, иначе поиск стирается и фокус уезжает.
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		setQuery("");
		restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		sheetRef.current?.focus();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") closeRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			restoreRef.current?.focus?.();
		};
	}, [open]);

	// Порядок задаёт шлюз: от дешёвых к дорогим (/api/models сортирует по цене
	// использования). Здесь только фильтр — сортировка по провайдеру его ломала.
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return [...models];
		return models.filter(m => m.selector.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
	}, [models, query]);

	if (!open) return null;

	return (
		<>
			<div className="pk-sheet-backdrop" onClick={onClose} />
			<div className="pk-sheet mp-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheetRef} tabIndex={-1}>
				<div className="pk-sheet-handle" />
				<div className="mp-head">
					<div className="pk-sheet-title" id={titleId}>
						{title}
					</div>
					<button type="button" className="pk-icon-btn" aria-label="Закрыть" onClick={onClose}>
						<X size={18} />
					</button>
				</div>
				{note !== null && <div className="mp-note">{note}</div>}
				{search && (
					<label className="mp-search">
						<Search size={16} aria-hidden="true" />
						<input
							ref={searchRef}
							className="mp-search-input"
							type="search"
							inputMode="search"
							placeholder="Поиск: провайдер, id или имя"
							value={query}
							spellCheck={false}
							onChange={e => setQuery(e.target.value)}
						/>
					</label>
				)}
				{header}
				{error !== null && <div className="pk-form-error">{error}</div>}
				{busy && <div className="mp-busy">Применяю…</div>}
				<div className="mp-list" role="listbox" aria-label={title}>
					{allowDefault && query.trim().length === 0 && (
						<button
							type="button"
							role="option"
							aria-selected={current === null}
							className={`mp-row${current === null ? " mp-row--on" : ""}`}
							disabled={busy}
							onClick={() => onPick(null)}
						>
							<span className="mp-row-main">
								<span className="mp-row-name">{defaultLabel ?? "По умолчанию"}</span>
								<span className="mp-row-sub">модель из настроек omp — не задавать явно</span>
							</span>
							{current === null && <Check size={16} className="mp-row-check" aria-hidden="true" />}
						</button>
					)}
					{filtered.map(model => {
						const provider = providerOf(model.selector);
						const on = model.selector === current;
						const meta = [
							provider,
							modelPriceLabel(model.selector, model.cost),
							contextLabel(model.contextWindow),
							model.thinking.length > 0 ? `усилие: ${model.thinking.join("/")}` : "",
						]
							.filter(Boolean)
							.join(" · ");
						return (
							<div key={model.selector}>
								<button
									type="button"
									role="option"
									aria-selected={on}
									className={`mp-row${on ? " mp-row--on" : ""}`}
									disabled={busy}
									onClick={() => onPick(model.selector)}
								>
									<span className="mp-row-main">
										<span className="mp-row-name">{model.name}</span>
										<span className="mp-row-sub">{model.selector}</span>
										{meta !== "" && <span className="mp-row-meta">{meta}</span>}
									</span>
									{on && <Check size={16} className="mp-row-check" aria-hidden="true" />}
								</button>
							</div>
						);
					})}
					{filtered.length === 0 && <div className="mp-empty">Ничего не нашлось</div>}
				</div>
			</div>
		</>
	);
}
