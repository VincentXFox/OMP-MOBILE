import { ArrowLeft, Copy, FolderPlus, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { pluralRu } from "../../lib/format";
import { fetchPromptDoc, fetchPrompts, startAgent, type PromptDocBody, type PromptHit, type PromptsResult } from "../../lib/gateway";
import "./prompts.css";

/**
 * Библиотека системных промптов AI-инструментов (локальный клон
 * x1xhlol/system-prompts-and-models-of-ai-tools: Cursor, Windsurf, Devin, v0,
 * Claude Code, Xcode…). Это не скилы, а уставы: чужой промпт можно поставить
 * уставом стола — агент начнёт работать в характере выбранного инструмента.
 */

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  return `${Math.round(bytes / 1024)} КБ`;
}

export function PromptsSheet(props: {
  onClose: () => void;
  onToast: (text: string) => void;
  onStarted: () => void;
}): ReactNode {
  const { onClose, onToast, onStarted } = props;
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState("");
  const [data, setData] = useState<PromptsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<PromptDocBody | null>(null);
  const [busy, setBusy] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Поиск на сервере: 2.3 МБ текста по 111 файлам ищутся в шлюзе, на телефоне
  // держим только результат. Пустой запрос — весь список инструментов.
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      try {
        const next = await fetchPrompts(query, tool, controller.signal);
        if (!alive) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!alive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    const timer = window.setTimeout(() => void run(), 250);
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, tool]);

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (openDoc !== null) setOpenDoc(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose, openDoc]);

  const open = useCallback(async (hit: PromptHit) => {
    setError(null);
    try {
      setOpenDoc(await fetchPromptDoc(hit.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Стол по промпту: корень («/») — свалка, значит шлюз заведёт отдельный стол
  // с названием промпта, а текст промпта станет уставом AGENTS.md.
  const startWithCharter = useCallback(async () => {
    if (busy || openDoc === null) return;
    setBusy(true);
    setError(null);
    const result = await startAgent("/", undefined, undefined, {
      role: openDoc.doc.title,
      charter: openDoc.text,
      charterSource: `${openDoc.doc.tool}/${openDoc.doc.title}`,
    });
    setBusy(false);
    if (result.ok) {
      onToast(`Стол «${result.desk?.role ?? openDoc.doc.title}» заводится…`);
      onStarted();
      onClose();
    } else {
      setError(result.error ?? "не удалось создать стол по промпту");
    }
  }, [busy, onClose, onStarted, onToast, openDoc]);

  const copy = useCallback(async () => {
    if (openDoc === null) return;
    try {
      await navigator.clipboard.writeText(openDoc.text);
      onToast("Промпт в буфере обмена");
    } catch {
      setError("Браузер не дал доступ к буферу обмена");
    }
  }, [openDoc, onToast]);

  const tools = data?.tools ?? [];
  const docs = data?.docs ?? [];

  return (
    <>
      <div className="pk-sheet-backdrop" onClick={onClose} />
      <div className="pk-sheet prompts-sheet" role="dialog" aria-modal="true" aria-labelledby="prompts-title" ref={sheetRef} tabIndex={-1}>
        <div className="pk-sheet-handle" />
        <div className="pr-head">
          {openDoc !== null && (
            <button type="button" className="pr-back" aria-label="К списку промптов" onClick={() => setOpenDoc(null)}>
              <ArrowLeft size={16} />
            </button>
          )}
          <div className="pk-sheet-title" id="prompts-title">
            {openDoc !== null ? openDoc.doc.title : "Промпты AI-инструментов"}
          </div>
        </div>
        <div className="pr-sub">
          {openDoc !== null
            ? `${openDoc.doc.tool} · ${kb(openDoc.doc.bytes)}${openDoc.truncated ? " · показаны первые 200 КБ" : ""}`
            : data === null
              ? "Загружаю…"
              : data.available
                ? `${data.total} ${pluralRu(data.total, "промпт", "промпта", "промптов")} · ${tools.length} ${pluralRu(tools.length, "инструмент", "инструмента", "инструментов")}`
                : `Библиотеки нет: ${data.root} — склонируй репозиторий x1xhlol/system-prompts-and-models-of-ai-tools`}
        </div>

        {openDoc === null && (
          <>
            <div className="ag-search pr-search">
              <Search size={16} className="ag-search-icon" aria-hidden="true" />
              <input
                className="ag-search-input"
                type="search"
                value={query}
                placeholder="cursor, devin, tools, токены…"
                aria-label="Поиск по промптам"
                spellCheck={false}
                onChange={e => setQuery(e.target.value)}
              />
              {query !== "" && (
                <button type="button" className="ag-search-clear" aria-label="Очистить поиск" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
            {tools.length > 0 && (
              <div className="pk-chips pr-tools">
                <button type="button" className={`pk-chip${tool === "" ? " pk-chip--on" : ""}`} onClick={() => setTool("")}>
                  все
                </button>
                {tools.map(t => (
                  <button
                    key={t.name}
                    type="button"
                    className={`pk-chip${tool === t.name ? " pk-chip--on" : ""}`}
                    onClick={() => setTool(t.name)}
                  >
                    {t.name} · {t.count}
                  </button>
                ))}
              </div>
            )}
            <div className="pr-list">
              {docs.length === 0 && data !== null && (
                <div className="pk-empty pr-empty">
                  <div className="pk-empty-title">Ничего не найдено</div>
                  <div className="pk-empty-text">Другие слова или сбрось фильтр инструмента.</div>
                </div>
              )}
              {docs.map(hit => (
                <button key={hit.id} type="button" className="pk-card pr-card" onClick={() => void open(hit)}>
                  <span className="pr-name">{hit.title}</span>
                  <span className="pr-meta">
                    {hit.tool} · {kb(hit.bytes)}
                  </span>
                  <span className="pr-preview">{hit.snippet ?? hit.preview}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {openDoc !== null && (
          <>
            <pre className="pr-text">{openDoc.text.slice(0, 6000)}</pre>
            <div className="pr-actions">
              <button type="button" className="pk-btn pk-btn--primary pr-start" disabled={busy} onClick={() => void startWithCharter()}>
                {busy ? <span className="pk-spinner" aria-label="Запускаю…" /> : <FolderPlus size={16} />}
                Стол по промпту
              </button>
              <button type="button" className="pk-btn pk-btn--ghost pr-copy" onClick={() => void copy()}>
                <Copy size={16} />
                Копировать
              </button>
            </div>
          </>
        )}

        {error != null && (
          <div className="pk-form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </>
  );
}
