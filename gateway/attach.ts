import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Гостевые вложения для видимости в ленте: снапшот collab отдаёт гостевые
 * промпты без image-блоков (замерено на 18.10.3), поэтому картинка уезжает
 * на шлюз файлом, а в текст промпта встаёт markdown-ссылка — её рендерят
 * и лента, и агент может скачать по URL.
 *
 * Отдаётся без Bearer: имя файла — unguessable UUID, это и есть секрет
 * (в <img> внутри ленты заголовки не подставишь).
 */

const ATTACH_DIR = "/tmp/omp-pocket-attach";
const MAX_BYTES = 10 * 1024 * 1024; // 10 МБ — как лимит композера

const EXT_BY_MIME: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
};

export function saveAttachment(bytes: Uint8Array, mimeType: string): { url: string } | { error: string } {
	const ext = EXT_BY_MIME[mimeType];
	if (!ext) return { error: `неподдерживаемый тип: ${mimeType || "неизвестный"}` };
	if (bytes.byteLength === 0) return { error: "пустой файл" };
	if (bytes.byteLength > MAX_BYTES) return { error: "файл больше 10 МБ" };
	mkdirSync(ATTACH_DIR, { recursive: true });
	const name = `${randomUUID()}${ext}`;
	writeFileSync(join(ATTACH_DIR, name), bytes);
	return { url: `/api/attach/${name}` };
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

export function readAttachment(name: string): Response | null {
	// только UUID+ext, никаких путей
	if (!/^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(name)) return null;
	const file = join(ATTACH_DIR, name);
	try {
		const f = Bun.file(file);
		return new Response(f, {
			headers: { "content-type": MIME_BY_EXT[name.slice(-4)] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" },
		});
	} catch {
		return null;
	}
}
