#!/usr/bin/env bun
/**
 * ru-lint: сообщения хуков и инструментов GRANDMASTER — только по-русски.
 *
 * Правило пользователя: всё, что хук печатает ему в лицо (reason, additionalContext,
 * stderr), должно быть на русском. Технические маркеры (ADVERSARIAL:, EVIDENCE:, СТАТУС:,
 * имена инструментов и поля JSON) — исключение, их не переводим.
 *
 * Эвристика: из исходника убираются комментарии, затем собираются строковые литералы.
 * Литерал считается английским текстом, если в нём нет ни одной кириллической буквы,
 * ≥ 5 латинских слов длиннее двух букв и нет технических маркеров.
 *
 * CLI: ru-lint.ts [--json] [пути…]   (без путей — хуки + harness)
 * Exit 0 = нарушений нет, 1 = есть.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_ROOTS = [
  "/home/vincentfox/.omp/agent/hooks/pre",
  "/home/vincentfox/.omp/agent/hooks/tests",
  "/home/vincentfox/.omp/agent/harness",
];

/** Технические маркеры: их перевод сломал бы контракт. Только жёсткие токены —
 * обычные английские слова (file, path, tool, reason, return) сюда НЕ входят, иначе
 * под них прячется английская проза. */
const TECH_RE =
  /(?:\b(?:PASS|FAIL|ADVERSARIAL|EVIDENCE|STATUS|JSON|JSONL|HTTP|HTTPS|UUID|UTF|HOME|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_STATE_HOME|GRANDMASTER|gm-harness|loop-breaker|todo-first|adversarial-review|stop-gate|session_stop|session_compact|before_agent_start|tool_result|tool_call|MEMORY-CHECKSUM|GM-MEMORY|SEED|DONE-WITH-CAVEATS|PARTIAL|BLOCKED|CAVEATS|bun|node|systemd|omp|herdr|sqlite|sha256|sha-256)\b)/u;

/** Код, а не проза: скобки, вызовы, операторы. */
const CODE_RE = /(?:await\s|\.cwd|\bctx\b|\bevent\b|=>|\|\||&&|\([^)]*,|\bjoin\(|\bpathExists\(|\bimport\b|\bconst\b|\breturn\b)/u;

/** Код, а не проза: явные конструкции, а не одиночный слэш. */
const SKIP_RE =
  /(?:https?:\/\/|=>|\{\}|;|\$var|\brequire\(|\bimport\b|\bexport\b|\bconst\b|\blet\b|\bprocess\.|\bexit\b|\b[a-z]+_[a-z_]+\b|\bstdin\b|\bstdout\b|\bstderr\b|\bcmd\b|\bargv\b)/iu;

export interface Finding {
  path: string;
  line: number;
  text: string;
}

export function stripComments(source: string): string {
  // Блочные комментарии заменяются пробелами с сохранением переводов строк (нумерация строк).
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  return withoutBlock
    .split("\n")
    .map((line) => {
      // Комментарий ищем ВНЕ строковых литералов: иначе «path:81//x» режет строку
      // и английский текст в ней остаётся невидимым для линтера.
      let quote: string | null = null;
      for (let i = 0; i < line.length - 1; i++) {
        const ch = line[i];
        if (quote === null) {
          if (ch === '"' || ch === "'" || ch === "`") quote = ch;
          else if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
        } else if (ch === "\\") {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
      }
      return line;
    })
    .join("\n");
}

function literalsOf(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.){4,})"|'((?:[^'\\]|\\.){4,})'|`((?:[^`\\]|\\.){4,})`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) {
      // Подстановки ${…} — это код, а не проза: оставляем их как технический маркер.
      out.push(value.replace(/\$\{[^}]*\}/g, " $var "));
    }
  }
  return out;
}

function hasCyrillic(text: string): boolean {
  return /[А-Яа-яЁё]/.test(text);
}

/** Английский текст для пользователя: много латинских слов без кириллицы. */
/** Технические токены без пробелов — идентификаторы, пути, имена модулей, а не проза. */
const IDENTIFIER_ALLOW = new Set(["You should know"]);

export function looksEnglish(text: string): boolean {
  if (hasCyrillic(text)) return false;
  // «you-should-know», «./you-should-know.ts», «grandmaster-goal-memory-loop» — это код.
  if (!/\s/.test(text.trim())) return false;
  if (IDENTIFIER_ALLOW.has(text.trim())) return false;
  if (TECH_RE.test(text)) return false;
  if (CODE_RE.test(text)) return false;
  if (SKIP_RE.test(text)) return false;
  const words = text.match(/[A-Za-z]{3,}/g) ?? [];
  if (words.length >= 3) return true;
  // Короткие сообщения тоже сообщения: «Upload failed, please retry» — 4 слова, но даже
  // два слова + запятая — это фраза для человека, а не идентификатор.
  return words.length >= 2 && /[a-z] [a-z]/i.test(text);
}

export function lintFile(path: string): Finding[] {
  const findings: Finding[] = [];
  const lines = stripComments(readFileSync(path, "utf8")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const literals = literalsOf(line);
    for (const literal of literals) {
      if (looksEnglish(literal)) findings.push({ path, line: i + 1, text: literal.slice(0, 120) });
    }
    // Сообщение, собранное из кусков («Upload » + «failed, » + «please retry»), по частям
    // выглядит безобидно: проверяем и склейку всей строки.
    if (literals.length > 1 && /(?:\+|\bjoin\()/.test(line)) {
      const joined = literals.join(" ");
      // Склейка считается сообщением только если в ней есть фраза (≥2 пробелов),
      // иначе это сборка пути или команды из кусков.
      const spaces = (joined.match(/ /g) ?? []).length;
      const pathLike = /[./]/.test(joined);
      if (spaces >= 2 && !pathLike && looksEnglish(joined) && !findings.some((finding) => finding.line === i + 1)) {
        findings.push({ path, line: i + 1, text: `склейка: ${joined.slice(0, 120)}` });
      }
    }
  }
  return findings;
}

function filesIn(root: string): string[] {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.name.includes(".bak-")) continue;
      const full = join(root, entry.name);
      if (entry.isDirectory()) out.push(...filesIn(full));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith("ru-lint.ts")) out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const explicit = argv.filter((arg) => !arg.startsWith("--"));
const targets = explicit.length > 0 ? explicit : DEFAULT_ROOTS.flatMap(filesIn);
if (targets.length === 0) {
  process.stdout.write("ru-lint: не найдено ни одного файла для проверки — это не «чисто», а отсутствие проверки\n");
  process.exit(1);
}
const findings = targets.flatMap(lintFile);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
} else if (findings.length === 0) {
  process.stdout.write(`ru-lint: нарушений нет (проверено файлов: ${targets.length})\n`);
} else {
  process.stdout.write(`ru-lint: английский текст в сообщениях (${findings.length}):\n`);
  for (const finding of findings) process.stdout.write(`  ${finding.path}:${finding.line} — ${finding.text}\n`);
}
process.exit(findings.length === 0 ? 0 : 1);
