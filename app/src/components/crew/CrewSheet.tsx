import { FolderTree, RefreshCw, UsersRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { pluralRu, shortenPath } from "../../lib/format";
import { fetchCrew, organizeCrew, type CrewDesk, type CrewResponse } from "../../lib/gateway";
import "./crew.css";

/** «Штат»: кто за что отвечает.
 *
 * Вопрос, который решает шит: «этот агент вообще за что?» — два десятка сессий
 * раньше лежали в одной папке, и ответить было нечем. Здесь — столы (папки),
 * их зоны ответственности и закреплённые агенты, плюс ручная раскладка, которая
 * по расписанию и так идёт раз в сутки.
 */

function whenLabel(ts: number | null): string {
  if (ts === null) return "ещё не запускался";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "только что";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} ${pluralRu(minutes, "минуту", "минуты", "минут")} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${pluralRu(hours, "час", "часа", "часов")} назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${pluralRu(days, "день", "дня", "дней")} назад`;
}

function nextLabel(ts: number | null): string {
  if (ts === null) return "по расписанию в 04:00";
  const diff = ts - Date.now();
  if (diff <= 0) return "вот-вот";
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) return `через ${Math.max(1, Math.floor(diff / 60_000))} мин`;
  return `через ${hours} ${pluralRu(hours, "час", "часа", "часов")}`;
}

const MODE_LABEL: Record<string, string> = {
  llm: "решала модель",
  deterministic: "без модели: один агент — один стол",
  noop: "раскладывать было нечего",
};

function DeskRow(props: { desk: CrewDesk; titles: Record<string, string | null> }): ReactNode {
  const { desk, titles } = props;
  const named = desk.sessions.map(id => ({ id, title: titles[id] ?? null }));
  return (
    <div className="pk-card crew-desk">
      <span className="crew-role">{desk.role}</span>
      {desk.brief !== "" && <span className="crew-brief">{desk.brief}</span>}
      <span className="crew-path">
        <FolderTree size={12} aria-hidden="true" />
        {shortenPath(desk.dir)}
      </span>
      <span className="crew-members">
        <UsersRound size={12} aria-hidden="true" />
        {/* Имена в отдельном блоке: у флекса «иконка + текст» текст иначе
            переносится отдельным флекс-элементом и рвётся от иконки. */}
        <span className="crew-members-names">
          {named.length === 0 ? "агентов пока нет" : named.map(m => m.title ?? `сессия ${m.id.slice(0, 8)}`).join(" · ")}
        </span>
      </span>
    </div>
  );
}

export function CrewSheet(props: { onClose: () => void; onToast: (text: string) => void }): ReactNode {
  const { onClose, onToast } = props;
  const [data, setData] = useState<CrewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Пока шит открыт — короткий опрос: раскладка идёт минутами, и «распределяю…»
  // должно смениться результатом само, без перезахода.
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchCrew();
        if (!alive) return;
        setData(next);
        setError(null);
        if (!next.organizer.running) setBusy(false);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);

  const organize = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await organizeCrew();
      onToast("Раскладываю агентов по папкам…");
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [busy, onToast]);

  const organizer = data?.organizer ?? null;
  const loose = data?.loose ?? 0;
  const running = busy || organizer?.running === true;
  const desks = data?.desks ?? [];

  return (
    <>
      <div className="pk-sheet-backdrop" onClick={onClose} />
      <div className="pk-sheet crew-sheet" role="dialog" aria-modal="true" aria-labelledby="crew-title" ref={sheetRef} tabIndex={-1}>
        <div className="pk-sheet-handle" />
        <div className="pk-sheet-title" id="crew-title">
          Штат агентов
        </div>
        <div className="crew-sub">
          {data === null ? "Загружаю…" : `${desks.length} ${pluralRu(desks.length, "стол", "стола", "столов")} · ${data.root}`}
        </div>
        <div className="crew-status">
          <span className="crew-status-line">
            {running
              ? "Распределяю агентов по папкам…"
              : organizer === null
                ? "—"
                : `${MODE_LABEL[organizer.lastMode ?? "noop"] ?? "—"} · ${whenLabel(organizer.lastRunAt)}`}
          </span>
          {organizer !== null && !running && <span className="crew-status-next">следующая — {nextLabel(organizer.nextRunAt)}</span>}
          {organizer?.lastSummary !== null && organizer?.lastSummary !== undefined && !running && (
            <span className="crew-status-summary">{organizer.lastSummary}</span>
          )}
          {organizer?.lastError != null && <span className="crew-status-error">{organizer.lastError}</span>}
        </div>
        <button type="button" className="pk-btn pk-btn--primary crew-run" disabled={running || data === null} onClick={() => void organize()}>
          {running ? <span className="pk-spinner" aria-label="Раскладываю…" /> : <RefreshCw size={16} />}
          {running ? "Раскладываю…" : "Разложить сейчас"}
        </button>
        {loose > 0 && !running && (
          <div className="crew-loose">
            {loose} {pluralRu(loose, "агент сидит", "агента сидят", "агентов сидят")} в общих папках (дом, /tmp) — организатор даст
            каждому свой стол.
          </div>
        )}
        {error != null && (
          <div className="pk-form-error" role="alert">
            {error}
          </div>
        )}
        <div className="crew-list">
          {desks.length === 0 && data !== null && (
            <div className="pk-empty crew-empty">
              <div className="pk-empty-title">Столов пока нет</div>
              <div className="pk-empty-text">
                Нажми «Разложить сейчас»: организатор разберёт агентов по темам и заведёт папки в {data.root}. Дальше это
                происходит само раз в сутки.
              </div>
            </div>
          )}
          {desks.map(desk => (
            <DeskRow key={desk.slug} desk={desk} titles={data?.titles ?? {}} />
          ))}
        </div>
      </div>
    </>
  );
}
