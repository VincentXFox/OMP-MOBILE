import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Вложения для ленты: снапшот collab отдаёт гостевые промпты без
 * image-блоков и без бинарных файлов, поэтому файл уезжает на шлюз, а в
 * текст промпта встаёт markdown-ссылка — её рендерят и лента, и агент
 * может скачать по URL.
 *
 * Отдаётся без Bearer: UUID в имени файла — и есть секрет (в <img> внутри
 * ленты заголовки не подставишь). Оригинальное имя файла хранится в
 * сайдкаре `<uuid>.meta.json` и идёт в content-disposition при скачивании.
 */

const ATTACH_DIR = "/tmp/omp-pocket-attach";
const MAX_BYTES = 25 * 1024 * 1024; // 25 МБ на файл

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

function extFrom(mimeType: string, originalName: string): string {
	const byName = originalName.includes(".") ? originalName.slice(originalName.lastIndexOf(".")).toLowerCase() : "";
	if (/^\.[a-z0-9]{1,8}$/.test(byName)) return byName;
	const byMime = Object.entries(IMAGE_MIME).find(([, m]) => m === mimeType)?.[0];
	return byMime ?? ".bin";
}

export interface SavedAttachment {
	url: string;
	name: string;
}

export function saveAttachment(bytes: Uint8Array, mimeType: string, originalName: string): SavedAttachment | { error: string } {
	if (bytes.byteLength === 0) return { error: "пустой файл" };
	if (bytes.byteLength > MAX_BYTES) return { error: "файл больше 25 МБ" };
	const clean = originalName.replace(/[^A-Za-zА-Яа-я0-9._ -]/g, "_").slice(0, 120).trim() || "file";
	mkdirSync(ATTACH_DIR, { recursive: true });
	const id = randomUUID();
	const ext = extFrom(mimeType, clean);
	const diskName = `${id}${ext}`;
	writeFileSync(join(ATTACH_DIR, diskName), bytes);
	writeFileSync(
		join(ATTACH_DIR, `${id}.meta.json`),
		JSON.stringify({ name: clean, mime: mimeType || "application/octet-stream", disk: diskName }),
	);
	// url несёт и UUID (секрет), и человекочитаемое имя для downloaded-файла
	return { url: `/api/attach/${id}/${encodeURIComponent(clean)}`, name: clean };
}

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".json": "application/json",
	".txt": "text/plain",
	".csv": "text/csv",
	".log": "text/plain",
};

export function readAttachment(id: string, requestedName: string): Response | null {
	if (!/^[0-9a-f-]{36}$/.test(id)) return null;
	const metaPath = join(ATTACH_DIR, `${id}.meta.json`);
	if (!existsSync(metaPath)) return null;
	let meta: { name?: string; mime?: string; disk?: string };
	try {
		meta = JSON.parse(readFileSync(metaPath, "utf8"));
	} catch {
		return null;
	}
	if (!meta.disk || !existsSync(join(ATTACH_DIR, meta.disk))) return null;
	const ext = meta.disk.slice(meta.disk.lastIndexOf("."));
	const isImage = ext in IMAGE_MIME;
	const mime = MIME_BY_EXT[ext] ?? meta.mime ?? "application/octet-stream";
	const headers: Record<string, string> = {
		"content-type": isImage ? mime : "application/octet-stream",
		"cache-control": "public, max-age=31536000, immutable",
	};
	if (!isImage) {
		const safeName = (meta.name ?? requestedName).replace(/[^\w.\-А-Яа-я ]/g, "_");
		headers["content-disposition"] = `attachment; filename="attach-${id.slice(0, 8)}${ext}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
	}
	return new Response(Bun.file(join(ATTACH_DIR, meta.disk)), { headers });
}
