import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MemoryBank, MemoryEntry, MemoryTable } from "../../lib/gateway";
import { fetchMemoryBanks, fetchMemoryEntries } from "../../lib/gateway";
import { relTime } from "../../lib/format";
import "./memory.css";

const PAGE_SIZE = 30;

const TYPES: readonly { id: MemoryTable; label: string }[] = [
	{ id: "working_memory", label: "Воспоминания" },
	{ id: "facts", label: "Факты" },
	{ id: "episodic_memory", label: "Эпизоды" },
	{ id: "gists", label: "Гисты" },
	{ id: "annotations", label: "Аннотации" },
];

/** Transcript chunks and gists can be long; collapsed until tapped. */
function MemCard(props: { entry: MemoryEntry }): ReactNode {
	const { entry } = props;
	const [open, setOpen] = useState(false);
	const when = entry.ts && Number.isFinite(Date.parse(entry.ts)) ? relTime(Date.parse(entry.ts)) : null;
	const stats: string[] = [];
	if (entry.importance != null) stats.push(`важность ${entry.importance.toFixed(2)}`);
	if (entry.recallCount != null && entry.recallCount > 0) stats.push(`вспомянуто ×${entry.recallCount}`);
	if (entry.confidence != null) stats.push(`уверенность ${Math.round(entry.confidence * 100)}%`);
	return (
		<div className="pk-card mem-card" onClick={() => setOpen(o => !o)}>
			{entry.title && <div className="mem-title">{entry.title}</div>}
			<div className={`mem-body${open ? " mem-body--open" : ""}`}>{entry.body}</div>
			{(entry.source || entry.kind || when || stats.length > 0) && (
				<div className="mem-meta">
					{entry.source && <span className="pk-chip">{entry.source}</span>}
					{entry.kind && <span className="pk-chip">{entry.kind}</span>}
					{when && <span className="mem-when">{when}</span>}
					{stats.length > 0 && <span className="mem-when">{stats.join(" · ")}</span>}
				</div>
			)}
		</div>
	);
}

export function MemoryScreen(): ReactNode {
	const [banks, setBanks] = useState<MemoryBank[] | null>(null);
	const [banksError, setBanksError] = useState<string | null>(null);
	const [bank, setBank] = useState<string | null>(null);
	const [type, setType] = useState<MemoryTable>("working_memory");
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const reqSeq = useRef(0);

	useEffect(() => {
		let alive = true;
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
	}, []);

	// debounce typing into the committed search term
	useEffect(() => {
		const timer = setTimeout(() => setSearch(query.trim()), 300);
		return () => clearTimeout(timer);
	}, [query]);

	const load = useCallback(
		async (offset: number, append: boolean): Promise<void> => {
			if (!bank) return;
			const seq = ++reqSeq.current;
			setLoading(true);
			try {
				const data = await fetchMemoryEntries(bank, type, { q: search || undefined, limit: PAGE_SIZE, offset });
				if (seq !== reqSeq.current) return;
				setEntries(prev => (append ? [...prev, ...data.entries] : data.entries));
				setTotal(data.total);
				setError(null);
			} catch (err) {
				if (seq === reqSeq.current) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (seq === reqSeq.current) setLoading(false);
			}
		},
		[bank, type, search],
	);

	useEffect(() => {
		void load(0, false);
	}, [load]);

	if (banksError != null) {
		return (
			<div className="pk-empty">
				<div className="pk-empty-title">Не удалось получить банки памяти</div>
				<div className="pk-empty-text">{banksError}</div>
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

	const activeBank = banks.find(b => b.name === bank);
	return (
		<div className="mem-screen">
			<div className="mem-row">
				{banks.map(b => (
					<button key={b.name} className={`pk-chip${b.name === bank ? " pk-chip--on" : ""}`} onClick={() => setBank(b.name)}>
						{b.name}
						<span className="mem-count">{b.total}</span>
					</button>
				))}
			</div>
			<div className="mem-row">
				{TYPES.map(t => (
					<button
						key={t.id}
						className={`pk-chip${t.id === type ? " pk-chip--on" : ""}`}
						onClick={() => setType(t.id)}
					>
						{t.label}
						{activeBank?.tables[t.id] != null && <span className="mem-count">{activeBank.tables[t.id]}</span>}
					</button>
				))}
			</div>
			<div className="mem-toolbar">
				<input
					className="pk-input mem-search"
					placeholder="Поиск по памяти…"
					value={query}
					onChange={e => setQuery(e.target.value)}
				/>
			</div>
			{error != null && (
				<div className="pk-empty">
					<div className="pk-empty-text">{error}</div>
				</div>
			)}
			{!loading && error == null && entries.length === 0 && (
				<div className="pk-empty">
					<div className="pk-empty-title">Пусто</div>
					<div className="pk-empty-text">В этом банке таких записей нет.</div>
				</div>
			)}
			<div className="pk-list">
				{entries.map(entry => (
					<MemCard key={entry.id} entry={entry} />
				))}
			</div>
			{entries.length < total && (
				<button className="pk-btn mem-more" disabled={loading} onClick={() => void load(entries.length, true)}>
					{loading ? "Загрузка…" : `Показать ещё · осталось ${total - entries.length}`}
				</button>
			)}
		</div>
	);
}
