import { RefreshCw, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryBank, MemoryEntry, MemoryFacets, MemoryScope, MemorySort, MemoryTable } from "../../lib/gateway";
import { fetchMemoryBanks, fetchMemoryEntries, fetchMemoryFacets } from "../../lib/gateway";
import { dayTimeLabel, pluralRu, relTime } from "../../lib/format";
import "./memory.css";

/**
 * Раздел памяти: пять таблиц Mnemopi отличаются по смыслу и по качеству данных,
 * поэтому они не равноправные вкладки. Основное — «Память» (что агент решил
 * сохранить) и «Эпизоды» (итоги прошедших сессий); «Факты» — машинные тройки;
 * гисты и аннотации — служебный слой (обрезки строк и метаданные), он живёт
 * под отдельной кнопкой с пояснением, а не рядом с содержанием.
 */

const PAGE_SIZE = 30;
/** Литерал, а не `MemoryScope`: по переменной типа-объединения TS не сужает. */
const ALL_SCOPE = "all";
const SERVICE_SCOPES: readonly MemoryTable[] = ["gists", "annotations"];

interface ScopeInfo {
	label: string;
	hint: string;
	short: string;
	/** Сортировки, осмысленные для этого раздела. */
	sorts: readonly { id: MemorySort; label: string }[];
}

const SORTS_TS: readonly { id: MemorySort; label: string }[] = [{ id: "ts", label: "Свежие" }];
const SORTS_MEMORY: readonly { id: MemorySort; label: string }[] = [
	{ id: "ts", label: "Свежие" },
	{ id: "importance", label: "Важные" },
	{ id: "recall", label: "Вспоминаемые" },
];

const SCOPE_INFO: Record<"working_memory" | "episodic_memory" | "facts" | "gists" | "annotations" | "all", ScopeInfo> = {
	working_memory: {
		label: "Память",
		short: "память",
		hint: "То, что Mnemopi сохранил сам после работы агента: факты о твоих системах, решения и их причины.",
		sorts: SORTS_MEMORY,
	},
	episodic_memory: {
		label: "Эпизоды",
		short: "эпизод",
		hint: "Итоги прошедших сессий (sleep_consolidation) — по записи на разговор, с короткой выжимкой.",
		sorts: SORTS_MEMORY,
	},
	facts: {
		label: "Факты",
		short: "факт",
		hint: "Машинные тройки «субъект — отношение — значение»: выжимка из памяти, у каждой оценки уверенности.",
		sorts: [
			{ id: "ts", label: "Свежие" },
			{ id: "confidence", label: "Уверенные" },
		],
	},
	gists: {
		label: "Гисты",
		short: "гист",
		hint: "Обрезки эпизодов в одну строку: служебные — по ним Mnemopi связывает выжимку с полным текстом.",
		sorts: SORTS_TS,
	},
	annotations: {
		label: "Аннотации",
		short: "аннотация",
		hint: "Метаданные памяти: occurred_on, has_source и прочие метки, по которым работает поиск.",
		sorts: SORTS_TS,
	},
	all: {
		label: "Всё",
		short: "везде",
		hint: "Поиск сразу по всем разделам: память, эпизоды, факты, гисты и аннотации — вкладку угадывать не нужно.",
		sorts: SORTS_TS,
	},
};

/** Порог 0.66/0.33 → высокая/средняя/низкая. */
function importanceLevel(value: number): "high" | "mid" | "low" {
	if (value >= 0.66) return "high";
	if (value >= 0.33) return "mid";
	return "low";
}

const IMPORTANCE_LABEL: Record<"high" | "mid" | "low", string> = {
	high: "важно",
	mid: "средне",
	low: "слабо",
};

/** Теги протокола, которые агент вставляет в текст. Список закрытый: снимать
 * любые `<слово>` нельзя — в памяти живут реальные плейсхолдеры вроде `<token>`. */
const PROTOCOL_TAGS = "file|context|memories|system-reminder|system_notice|project-context|user_message|assistant_message|tool_result|tool_call|thinking|command|output|env|todo|goal";

/** Разметка протокола ([user:start], [assistant:end], [toolCall]…) → читаемый текст. */
function cleanMemoryText(text: string): string {
	return text
		.replace(/\[[a-z]+:(?:start|end)\]/gi, " ")
		.replace(/\[(?:role:\s*)?(?:user|assistant|system|toolCall|toolResult|toolUse|custom_message|compaction)\]/gi, " ")
		// Метки источника, которыми Mnemopi помечает записанные фрагменты.
		.replace(/\[(?:coding-agent-transcript|coding-agent-retain|sleep_consolidation)\]/gi, " ")
		.replace(/^[ \t]*(?:role:\s*)?(?:user|assistant|system)[ \t]*$(\n?)/gim, "")
		.replace(new RegExp(`<\\/?(${PROTOCOL_TAGS})(?:\\s+[^<>]{0,120})?>`, "gi"), " ")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** «coding-agent-retain» → «retain»: префикс одинаков у всех источников и только
 * удлиняет чипы фильтров. */
function sourceLabel(value: string): string {
	return value.replace(/^coding-agent-/, "");
}

/** Бейдж вида записи: «unknown» у эпизодов — не информация, а отсутствие значения. */
function kindBadge(entry: MemoryEntry): string | null {
	const kind = entry.kind?.trim() ?? "";
	if (kind.length === 0 || kind === "unknown") return null;
	return kind;
}

/** Первая строка записи: для списка служебных строк достаточно её. */
function firstLine(text: string): string {
	const clean = cleanMemoryText(text);
	const at = clean.indexOf("\n");
	return at === -1 ? clean : clean.slice(0, at);
}

/** «Сегодня», «Вчера», «16 октября» — заголовок группы при сортировке по времени. */
function dayHeading(ts: string | null): string {
	if (ts === null) return "Без даты";
	const time = Date.parse(ts);
	if (!Number.isFinite(time)) return "Без даты";
	const date = new Date(time);
	const now = new Date();
	if (date.toDateString() === now.toDateString()) return "Сегодня";
	const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
	if (date.toDateString() === yesterday.toDateString()) return "Вчера";
	const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
	const year = date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`;
	return `${date.getDate()} ${months[date.getMonth()]}${year}`;
}

/** Подсветка совпадений запроса: шлюз ищет по подстроке, поэтому и здесь подстрока. */
function Highlight(props: { text: string; query: string }): ReactNode {
	const { text, query } = props;
	const needle = query.trim().toLowerCase();
	if (needle.length < 2) return <>{text}</>;
	const haystack = text.toLowerCase();
	const parts: ReactNode[] = [];
	let at = 0;
	let key = 0;
	for (;;) {
		const found = haystack.indexOf(needle, at);
		if (found === -1) break;
		if (found > at) parts.push(text.slice(at, found));
		parts.push(
			<mark className="mem-mark" key={key++}>
				{text.slice(found, found + needle.length)}
			</mark>,
		);
		at = found + needle.length;
	}
	if (parts.length === 0) return <>{text}</>;
	parts.push(text.slice(at));
	return <>{parts}</>;
}

/** Важность и уверенность одной полоской: число без шкалы ничего не говорит. */
function Meter(props: { value: number; label: string; tone: "high" | "mid" | "low"; icon?: ReactNode }): ReactNode {
	const percent = Math.round(Math.min(1, Math.max(0, props.value)) * 100);
	return (
		<span className={`mem-meter mem-meter--${props.tone}`} title={`${props.label}: ${percent}%`}>
			{props.icon}
			<span className="mem-meter-track">
				<span className="mem-meter-fill" style={{ width: `${percent}%` }} />
			</span>
			<span className="mem-meter-label">{props.label}</span>
		</span>
	);
}

function FactCard(props: { entry: MemoryEntry; query: string; open: boolean; onToggle: () => void }): ReactNode {
	const { entry, open } = props;
	const body = cleanMemoryText(entry.body);
	const confidence = entry.confidence ?? 0;
	return (
		<button type="button" className="pk-card mem-card mem-card--fact" aria-expanded={open} onClick={props.onToggle}>
			<div className="mem-top">
				<span className="mem-when">{dayTimeLabel(Date.parse(entry.ts ?? ""))}</span>
				{kindBadge(entry) !== null && <span className="mem-badge">{kindBadge(entry)}</span>}
				<span className="mem-grow" />
				<Meter value={confidence} tone={importanceLevel(confidence)} label={`уверенность ${Math.round(confidence * 100)}%`} />
			</div>
			<div className={`mem-body${open ? " mem-body--open" : ""}`}>
				<Highlight text={body} query={props.query} />
			</div>
		</button>
	);
}

function MemoryCard(props: { entry: MemoryEntry; query: string; open: boolean; onToggle: () => void }): ReactNode {
	const { entry, open } = props;
	const body = cleanMemoryText(entry.body);
	const gist = entry.gist != null ? cleanMemoryText(entry.gist) : "";
	const recalls = entry.recallCount ?? 0;
	return (
		<button type="button" className="pk-card mem-card" aria-expanded={open} onClick={props.onToggle}>
			<div className="mem-top">
				<span className="mem-when">{dayTimeLabel(Date.parse(entry.ts ?? ""))}</span>
				{kindBadge(entry) !== null && <span className="mem-badge">{kindBadge(entry)}</span>}
				{entry.source && (
					<span className="mem-badge mem-badge--src" title={`источник ${entry.source}`}>
						{sourceLabel(entry.source)}
					</span>
				)}
				<span className="mem-grow" />
				{entry.importance != null && (
					<Meter value={entry.importance} tone={importanceLevel(entry.importance)} label={IMPORTANCE_LABEL[importanceLevel(entry.importance)]} />
				)}
			</div>
			<div className={`mem-body${open ? " mem-body--open" : ""}`}>
				<Highlight text={body} query={props.query} />
			</div>
			{gist.length > 0 && (
				<div className="mem-gist">
					<span className="mem-gist-tag">выжимка</span>
					<Highlight text={gist} query={props.query} />
				</div>
			)}
			{(recalls > 0 || (entry.annotations ?? []).length > 0) && (
				<div className="mem-foot">
					{recalls > 0 && (
						<span className="mem-stat" title="Сколько раз память поднималась в ответе">
							<RefreshCw size={12} />
							{recalls}×
						</span>
					)}
					{(entry.annotations ?? []).map(annotation => (
						<span key={`${annotation.kind}:${annotation.value}`} className="mem-anno">
							<span className="mem-anno-kind">{annotation.kind}</span>
							{annotation.value}
						</span>
					))}
				</div>
			)}
		</button>
	);
}

/** Гист и аннотация — служебные строки: сам смысл живёт в родительской записи,
 * поэтому рядом показываем её начало, иначе строка читается обрубком. */
function ServiceRow(props: { entry: MemoryEntry; query: string; onOpenParent: (entry: MemoryEntry) => void }): ReactNode {
	const { entry } = props;
	const text = firstLine(entry.body);
	const parent = entry.episode != null ? firstLine(entry.episode) : "";
	return (
		<div className="pk-card mem-service">
			<div className="mem-service-main">
				<span className="mem-service-text">
					{entry.title != null && entry.title !== text && <span className="mem-service-key">{entry.title}</span>}
					<Highlight text={text} query={props.query} />
				</span>
				<span className="mem-when">{dayTimeLabel(Date.parse(entry.ts ?? ""))}</span>
			</div>
			{parent.length > 0 && entry.memoryId != null && (
				<button type="button" className="mem-service-parent" onClick={() => props.onOpenParent(entry)}>
					<span className="mem-service-parent-tag">из записи</span>
					<Highlight text={parent.slice(0, 120)} query={props.query} />
				</button>
			)}
		</div>
	);
}

export function MemoryScreen(): ReactNode {
	const [banks, setBanks] = useState<MemoryBank[] | null>(null);
	const [banksError, setBanksError] = useState<string | null>(null);
	const [bank, setBank] = useState<string | null>(null);
	const [scope, setScope] = useState<MemoryScope>("working_memory");
	const [service, setService] = useState<MemoryTable>("gists");
	const [sort, setSort] = useState<MemorySort>("ts");
	const [source, setSource] = useState<string | null>(null);
	const [kind, setKind] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [facets, setFacets] = useState<MemoryFacets | null>(null);
	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	const [allBanks, setAllBanks] = useState(false);
	const reqSeq = useRef(0);

	// «Служебное» — не раздел данных, а режим показа гистов и аннотаций.
	const [showService, setShowService] = useState(false);
	const table: MemoryScope = showService && scope !== ALL_SCOPE ? service : scope;
	const info = SCOPE_INFO[table === ALL_SCOPE ? "all" : table];

	const [banksAttempt, setBanksAttempt] = useState(0);

	useEffect(() => {
		let alive = true;
		setBanksError(null);
		void (async () => {
			try {
				const list = await fetchMemoryBanks();
				if (!alive) return;
				setBanks(list);
				setBank(list[0]?.name ?? null);
			} catch (err) {
				if (alive) setBanksError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			alive = false;
		};
	}, [banksAttempt]);

	// Ввод не должен бить запросом на каждую букву.
	useEffect(() => {
		const timer = setTimeout(() => setSearch(query.trim()), 300);
		return () => clearTimeout(timer);
	}, [query]);

	// Фильтры и сортировка принадлежат разделу: у фактов нет источников, у
	// аннотаций — важности, поэтому при смене раздела выбор сбрасывается.
	const pickScope = useCallback((next: MemoryScope) => {
		setScope(next);
		setShowService(next === "gists" || next === "annotations");
		setService(next === "annotations" ? "annotations" : "gists");
		setSort("ts");
		setSource(null);
		setKind(null);
	}, []);

	const pickService = useCallback((next: MemoryTable) => {
		setService(next);
		setScope(next);
		setShowService(true);
		setSort("ts");
		setSource(null);
		setKind(null);
	}, []);

	const load = useCallback(
		async (offset: number, append: boolean): Promise<void> => {
			if (!bank) return;
			const seq = ++reqSeq.current;
			setLoading(true);
			try {
				const data = await fetchMemoryEntries(bank, table, {
					q: search || undefined,
					sort,
					source: source ?? undefined,
					kind: kind ?? undefined,
					limit: PAGE_SIZE,
					offset,
				});
				if (seq !== reqSeq.current) return;
				setEntries(previous => (append ? [...previous, ...data.entries] : data.entries));
				setTotal(data.total);
				setError(null);
			} catch (err) {
				if (seq === reqSeq.current) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (seq === reqSeq.current) setLoading(false);
			}
		},
		[bank, table, search, sort, source, kind],
	);

	useEffect(() => {
		void load(0, false);
	}, [load]);

	// Чипы-фильтры со частотами: у режима «всё» и у гистов фильтров нет.
	const facetsTable: MemoryTable | null = table === ALL_SCOPE || table === "gists" ? null : table;
	useEffect(() => {
		if (!bank || facetsTable === null) {
			setFacets(null);
			return;
		}
		let alive = true;
		void (async () => {
			try {
				const data = await fetchMemoryFacets(bank, facetsTable);
				if (alive) setFacets(data);
			} catch {
				if (alive) setFacets(null);
			}
		})();
		return () => {
			alive = false;
		};
	}, [bank, facetsTable]);

	// Переход «из записи»: у гистов и аннотаций смысл живёт в родительской памяти,
	// а ссылка — только id. Поиск шлюза идёт по тексту, поэтому ищем по началу
	// родительской записи и переключаемся в тот раздел, где она лежит.
	const openParent = useCallback((entry: MemoryEntry) => {
		const parentText = entry.episode != null ? cleanMemoryText(entry.episode) : "";
		if (parentText.length === 0) return;
		const seed = parentText.slice(0, 48);
		setShowService(false);
		setScope(entry.table === "gists" ? "episodic_memory" : "working_memory");
		setSource(null);
		setKind(null);
		setSort("ts");
		setQuery(seed);
	}, []);

	const rows = useMemo(
		() =>
			entries.map(entry => ({
				entry,
				// Ключ обязан быть уникальным в режиме «всё»: id бывают одинаковыми
				// в разных таблицах.
				key: `${entry.table ?? ""}:${entry.id}`,
			})),
		[entries],
	);

	if (banksError != null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить банки памяти</div>
				<div className="pk-empty-text">{banksError}</div>
				{/* keepAlive держит экран смонтированным: без повтора он умирал до перезагрузки. */}
				<button type="button" className="pk-btn pk-btn--ghost" onClick={() => setBanksAttempt(n => n + 1)}>
					Повторить
				</button>
			</div>
		);
	}
	if (banks == null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-text">Загрузка…</div>
			</div>
		);
	}
	if (banks.length === 0) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Памяти нет</div>
				<div className="pk-empty-text">На этой машине ещё нет банков Mnemopi (~/.omp/agent/memories/mnemopi/banks).</div>
			</div>
		);
	}

	const activeBank = banks.find(b => b.name === bank) ?? null;
	const counts: Record<string, number> = {
		working_memory: activeBank?.tables.working_memory ?? 0,
		facts: activeBank?.tables.facts ?? 0,
		episodic_memory: activeBank?.tables.episodic_memory ?? 0,
		all: activeBank?.total ?? 0,
		gists: activeBank?.tables.gists ?? 0,
		annotations: activeBank?.tables.annotations ?? 0,
	};

	// Группы по дням имеют смысл только при сортировке по времени.
	const groups: { heading: string; items: typeof rows }[] = [];
	if (sort === "ts") {
		for (const row of rows) {
			const heading = dayHeading(row.entry.ts);
			const last = groups[groups.length - 1];
			if (last !== undefined && last.heading === heading) last.items.push(row);
			else groups.push({ heading, items: [row] });
		}
	} else {
		groups.push({ heading: "", items: rows });
	}

	const renderEntry = (row: (typeof rows)[number]): ReactNode => {
		const open = openId === row.key;
		const toggle = (): void => setOpenId(current => (current === row.key ? null : row.key));
		if (row.entry.table === "gists" || row.entry.table === "annotations") {
			return <ServiceRow key={row.key} entry={row.entry} query={search} onOpenParent={openParent} />;
		}
		if (row.entry.table === "facts") return <FactCard key={row.key} entry={row.entry} query={search} open={open} onToggle={toggle} />;
		return <MemoryCard key={row.key} entry={row.entry} query={search} open={open} onToggle={toggle} />;
	};

	const sources = facets?.sources ?? [];
	const kinds = facets?.kinds ?? [];

	// Банков на машине десятки: тестовые прогоны оставляют по банку на каждый
	// запуск. В шапке — только непустые, и лишь первые; остальные по кнопке.
	const realBanks = banks.filter(item => item.total > 0 || item.name === bank);
	const shownBanks = allBanks ? realBanks : realBanks.slice(0, 6);
	const hiddenBanks = Math.max(0, realBanks.length - shownBanks.length);
	// Выбранный банк всегда в списке, даже если он за пределами первых шести.
	const selectedBank = realBanks.find(item => item.name === bank);
	const bankChips =
		selectedBank !== undefined && !shownBanks.some(item => item.name === bank) ? [...shownBanks, selectedBank] : shownBanks;

	// Сортировка и фильтры относятся к списку, а не к банку: стоят сразу под
	// поиском и уезжают при прокрутке — настраивают их один раз.
	const filtersRow = (
		<div className="mem-row mem-row--sorts">
			{info.sorts.map(option => (
				<button
					key={option.id}
					type="button"
					className={`pk-chip${sort === option.id ? " pk-chip--on" : ""}`}
					onClick={() => setSort(option.id)}
				>
					{option.label}
				</button>
			))}
			{sources.length > 0 && (
				<>
					<span className="mem-sep" aria-hidden="true" />
					{sources.map(item => (
						<button
							key={item.value}
							type="button"
							title={`источник ${item.value}`}
							className={`pk-chip${source === item.value ? " pk-chip--on" : ""}`}
							onClick={() => setSource(current => (current === item.value ? null : item.value))}
						>
							{sourceLabel(item.value)}
							<span className="mem-count">{item.count}</span>
						</button>
					))}
				</>
			)}
			{kinds.length > 1 && (
				<>
					<span className="mem-sep" aria-hidden="true" />
					{kinds.map(item => (
						<button
							key={`kind:${item.value}`}
							type="button"
							className={`pk-chip${kind === item.value ? " pk-chip--on" : ""}`}
							onClick={() => setKind(current => (current === item.value ? null : item.value))}
						>
							{item.value}
							<span className="mem-count">{item.count}</span>
						</button>
					))}
				</>
			)}
		</div>
	);

	return (
		<div className="mem-screen">
			{/* Банки и фильтры уезжают при прокрутке: разделы и поиск важнее, а
			 * липкая шапка из пяти строк съедала бы пол-экрана телефона. */}
			<div className="mem-banks">
				<div className="mem-row mem-row--banks">
					{bankChips.map(item => {
						const hashAt = item.name.lastIndexOf("-");
						const base = hashAt > 0 ? item.name.slice(0, hashAt) : item.name;
						return (
							<button
								key={item.name}
								type="button"
								title={item.name}
								className={`pk-chip${item.name === bank ? " pk-chip--on" : ""}`}
								onClick={() => setBank(item.name)}
							>
								{base}
								<span className="mem-count">{item.total}</span>
							</button>
						);
					})}
					{(hiddenBanks > 0 || allBanks) && (
						<button type="button" className="pk-chip mem-more-banks" onClick={() => setAllBanks(current => !current)}>
							{allBanks ? "свернуть банки" : `ещё ${hiddenBanks}`}
						</button>
					)}
				</div>
				{activeBank && (
					<div className="mem-summary">
						{activeBank.total} {pluralRu(activeBank.total, "запись", "записи", "записей")} · {(activeBank.bytes / 1048576).toFixed(1)} МБ · обновлено {relTime(activeBank.mtime)}
					</div>
				)}
			</div>
			<div className="mem-bar">
				<div className="mem-row mem-row--scopes">
					{(["working_memory", "facts", "episodic_memory", ALL_SCOPE] as const).map(id => (
						<button
							key={id}
							type="button"
							className={`pk-chip${!showService && scope === id ? " pk-chip--on" : ""}`}
							onClick={() => pickScope(id)}
						>
							{SCOPE_INFO[id].label}
							<span className="mem-count">{counts[id] ?? 0}</span>
						</button>
					))}
					<button
						type="button"
						className={`pk-chip mem-service-toggle${showService ? " pk-chip--on" : ""}`}
						onClick={() => pickService(service)}
					>
						Служебное
						<span className="mem-count">{(counts.gists ?? 0) + (counts.annotations ?? 0)}</span>
					</button>
				</div>
				{showService && (
					<div className="mem-row mem-row--service">
						{SERVICE_SCOPES.map(id => (
							<button key={id} type="button" className={`pk-chip${service === id ? " pk-chip--on" : ""}`} onClick={() => pickService(id)}>
								{SCOPE_INFO[id].label}
								<span className="mem-count">{counts[id] ?? 0}</span>
							</button>
						))}
					</div>
				)}
				<div className="mem-search-row">
					<Search size={16} className="mem-search-icon" aria-hidden="true" />
					<input
						className="mem-search"
						type="search"
						value={query}
						placeholder={table === ALL_SCOPE ? "Поиск по всей памяти" : `Поиск: ${info.short}`}
						aria-label="Поиск по памяти"
						spellCheck={false}
						onChange={e => setQuery(e.target.value)}
					/>
					{query !== "" && (
						<button type="button" className="mem-search-clear" aria-label="Очистить поиск" onClick={() => setQuery("")}>
							<X size={14} />
						</button>
					)}
				</div>
			</div>

			<div className="mem-body-wrap">
				{filtersRow}
				<div className="mem-hint">{info.hint}</div>
				{(search.length >= 2 || source !== null || kind !== null) && (
					<div className="mem-filterline">
						Найдено {total} {pluralRu(total, "запись", "записи", "записей")}
						{search.length >= 2 && ` по «${search.length > 40 ? `${search.slice(0, 40)}…` : search}»`}
						{table !== ALL_SCOPE && search.length >= 2 && (
							<button type="button" className="mem-link" onClick={() => pickScope(ALL_SCOPE)}>
								искать везде
							</button>
						)}
					</div>
				)}

				{error != null && (
					<div className="pk-form-error" role="alert">
						{error}
						<button type="button" className="mem-link" onClick={() => void load(0, false)}>
							повторить
						</button>
					</div>
				)}

				{loading && entries.length === 0 && (
					<div className="pk-list" aria-hidden="true">
						{[0, 1, 2].map(i => (
							<div key={i} className="pk-card mem-card">
								<span className="pk-skeleton mem-sk mem-sk--title" />
								<span className="pk-skeleton mem-sk" />
								<span className="pk-skeleton mem-sk mem-sk--short" />
							</div>
						))}
					</div>
				)}

				{!loading && error == null && entries.length === 0 && (
					<div className="pk-empty">
						<div className="pk-empty-title">{search.length >= 2 ? "Ничего не найдено" : "Пусто"}</div>
						<div className="pk-empty-text">
							{search.length >= 2
								? table === ALL_SCOPE
									? "Другие слова — сравнение идёт по подстроке без учёта регистра."
									: "Попробуй «искать везде»: в других разделах может быть то же слово."
								: "В этом банке таких записей нет."}
						</div>
					</div>
				)}

				{groups.map(group => (
					<div key={group.heading || "all"} className="mem-group">
						{group.heading !== "" && <div className="mem-group-head">{group.heading}</div>}
						<div className="pk-list">{group.items.map(renderEntry)}</div>
					</div>
				))}

				{entries.length < total && (
					<button className="pk-btn mem-more" disabled={loading} onClick={() => void load(entries.length, true)}>
						{loading ? "Загрузка…" : `Показать ещё · осталось ${total - entries.length}`}
					</button>
				)}
			</div>
		</div>
	);
}
