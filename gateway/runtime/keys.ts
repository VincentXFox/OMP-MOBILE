/**
 * Клавиши терминала: вход приложения (`enter`, `ctrl+c`, `slash`) → байты PTY.
 *
 * Словарь тот же, что принимал herdr в `pane send-keys`: приложение шлёт
 * короткие токены (`[a-zA-Z0-9-]+`) и одиночные символы, поэтому старые
 * вызовы остаются валидными, а незнакомая клавиша честно отвергается
 * (`invalid_key`), а не печатается как текст.
 */

const NAMED: Record<string, string> = {
  enter: "\r",
  return: "\r",
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  space: " ",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  "page-up": "\x1b[5~",
  pagedown: "\x1b[6~",
  "page-down": "\x1b[6~",
  slash: "/",
  minus: "-",
  dash: "-",
};

// Ctrl-<буква> в трёх написаниях: ctrl+c, ctrl-c, ctrlc.
for (let i = 1; i <= 26; i++) {
  const letter = String.fromCharCode(96 + i);
  const control = String.fromCharCode(i);
  NAMED[`ctrl+${letter}`] = control;
  NAMED[`ctrl-${letter}`] = control;
  NAMED[`ctrl${letter}`] = control;
}

/** Один токен → байты. Печатаемый одиночный символ идёт как есть. */
export function keySequence(token: string): string | null {
  const named = NAMED[token.toLowerCase()];
  if (named !== undefined) return named;
  if ([...token].length === 1) {
    const code = token.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) return token;
  }
  return null;
}

/** Принимает ли приложение такой токен: та же проверка, что была у роутов шлюза. */
export function isKeyToken(token: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(token) || /^ctrl\+[a-z]$/.test(token) || keySequence(token) !== null;
}
