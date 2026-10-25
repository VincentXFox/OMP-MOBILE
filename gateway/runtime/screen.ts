/**
 * Экран панели: PTY-байты → эмуляция терминала (@xterm/headless) → снимок.
 *
 * Панель отдаёт приложению либо видимый текст (как `herdr pane read`), либо
 * ANSI-сериализацию со скроллбеком (как `ansi-terminal read`): второе рисуется
 * в приложении как настоящий терминал, поэтому цвета и рамки сохраняются.
 */

import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

export class Screen {
  readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;
  private readonly decoder = new TextDecoder();

  constructor(
    cols: number,
    rows: number,
    scrollback = 1000,
  ) {
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
  }

  /** Запись порции вывода: декодер держит неполные UTF-8 последовательности
   * между вызовами — иначе разрезанный по границе символ превращался бы в «». */
  async write(bytes: Uint8Array): Promise<string> {
    const text = this.decoder.decode(bytes, { stream: true });
    if (text === "") return text;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.terminal.write(text, resolve);
    await promise;
    return text;
  }

  /** Видимый экран или последние `lines` строк истории. */
  text(source: "visible" | "recent" = "visible", lines = this.terminal.rows): string {
    const buffer = this.terminal.buffer.active;
    const end = source === "visible" ? Math.min(buffer.length, buffer.viewportY + this.terminal.rows) : buffer.length;
    const start = Math.max(source === "visible" ? buffer.viewportY : 0, end - Math.max(1, lines));
    const out: string[] = [];
    for (let i = start; i < end; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n");
  }

  ansi(): string {
    return this.serializer.serialize({ scrollback: 1000 });
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
