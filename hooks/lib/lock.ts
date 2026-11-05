/**
 * Межпроцессная блокировка вокруг «прочитать → изменить → записать».
 *
 * Очередь в памяти защищает только один процесс: хук, отдельный runner наблюдателя
 * и второй экземпляр хука пишут один файл состояния, и счётчики теряются.
 * Здесь атомарный замок на файловой системе: `open(..., "wx")`, устаревший замок
 * (старше staleMs) снимается, ожидание ограничено timeoutMs.
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface LockOptions {
	timeoutMs?: number;
	staleMs?: number;
}

export async function withFileLock<T>(path: string, fn: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 4000;
	const staleMs = options.staleMs ?? 15_000;
	const started = Date.now();
	// Родительский каталог может отсутствовать (новый HOME, новая сессия):
	// без него замок падал бы ENOENT вместо ожидания.
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch {
		// если создать нельзя — ниже будет внятная ошибка замка
	}
	for (;;) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(path).mtimeMs > staleMs) {
					unlinkSync(path);
					continue;
				}
			} catch {
				// замок исчез между проверками — пробуем снова
			}
			if (Date.now() - started > timeoutMs) throw new Error(`замок не получен за ${timeoutMs} мс: ${path}`);
			await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 25));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			unlinkSync(path);
		} catch {
			// уже снят
		}
	}
}
