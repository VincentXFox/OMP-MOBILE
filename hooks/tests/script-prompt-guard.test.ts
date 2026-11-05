/**
 * Регрессия заслонки «скрипт вместо промпта».
 *
 * Заслонка гасит сессию, чей промпт — путь к скрипту внутри каталога хуков
 * (так выглядит каскад, когда хук поднял процесс бинарём omp вместо bun).
 * Ошибочное срабатывание стоило бы человеку сессии, поэтому проверяются
 * границы: только первая строка, только один токен, только .ts/.js, только
 * внутри каталога хуков.
 */
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { scriptPromptPath } from "../pre/script-prompt-guard.ts";

const HOOKS = resolve(import.meta.dir, "..");
const RUNNER = join(HOOKS, "bin", "you-should-know-runner.ts");

test("путь к скрипту хука в первой строке — срабатывание", () => {
	expect(scriptPromptPath(RUNNER, "/tmp")).toBe(RUNNER);
	expect(scriptPromptPath(`  ${RUNNER}  `, "/tmp")).toBe(RUNNER);
	expect(scriptPromptPath(`"${RUNNER}"`, "/tmp")).toBe(RUNNER);
	expect(scriptPromptPath(`\`${RUNNER}\`\nвторая строка`, "/tmp")).toBe(RUNNER);
});

test("относительный путь разрешается от cwd", () => {
	expect(scriptPromptPath("bin/you-should-know-runner.ts", HOOKS)).toBe(RUNNER);
	expect(scriptPromptPath("bin/you-should-know-runner.ts", "/tmp")).toBeNull();
});

test("проза с путём внутри не гасит сессию", () => {
	expect(scriptPromptPath(`починить ${RUNNER}`, "/tmp")).toBeNull();
	expect(scriptPromptPath(`${RUNNER} _tmp /tmp`, "/tmp")).toBeNull();
	expect(scriptPromptPath(`Проверь файл\n${RUNNER}`, "/tmp")).toBeNull();
});

test("не скрипт и не каталог хуков — пропуск", () => {
	expect(scriptPromptPath(join(HOOKS, "README.md"), "/tmp")).toBeNull();
	expect(scriptPromptPath(join(HOOKS, "..", "APPEND_SYSTEM.md"), "/tmp")).toBeNull();
	expect(scriptPromptPath("/tmp/scratch.ts", "/tmp")).toBeNull();
	expect(scriptPromptPath("", "/tmp")).toBeNull();
	expect(scriptPromptPath("   ", "/tmp")).toBeNull();
	expect(scriptPromptPath(undefined, "/tmp")).toBeNull();
	expect(scriptPromptPath(42, "/tmp")).toBeNull();
});
