import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTarget, buildUrl, downloadVerified, fetchOmpBuild, installBinary, IntegrityError, restoreBinary, sha256File } from "../release.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "omp-release-"));
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("build-сервис omp", () => {
  test("target и URL собираются как у самого omp", () => {
    expect(buildTarget("linux", "x64", false)).toBe("linux-x86_64");
    expect(buildTarget("linux", "x64", true)).toBe("linux-musl-x86_64");
    expect(buildTarget("darwin", "arm64")).toBe("macos-arm64");
    expect(buildUrl("https://build.example/", "linux-x86_64", null)).toBe("https://build.example/api/products/omp/latest/linux-x86_64?channel=stable");
    expect(buildUrl("https://build.example", "linux-x86_64", "v18.12.6")).toBe("https://build.example/api/products/omp/versions/18.12.6/linux-x86_64");
  });

  test("метаданные: выбирается файл под платформу, чужой arch игнорируется", async () => {
    const payload = {
      build: {
        version: "18.12.6",
        commit: "abc1234",
        channel: "stable",
        files: [
          { name: "omp-linux-arm64", platform: "linux", arch: "arm64", kind: "archive", size: 10, sha256: "a".repeat(64), url: "/d/arm" },
          { name: "omp-linux-x64", platform: "linux", arch: "x86_64", kind: "archive", size: 20, sha256: "b".repeat(64), url: "/d/x64" },
        ],
      },
    };
    const server = Bun.serve({ port: 0, fetch: () => Response.json(payload) });
    try {
      const build = await fetchOmpBuild(`http://127.0.0.1:${server.port}`, null, "linux-x86_64");
      expect(build.version).toBe("18.12.6");
      expect(build.file?.name).toBe("omp-linux-x64");
      expect(build.file?.size).toBe(20);
    } finally {
      server.stop(true);
    }
  });
});

describe("проверка целостности загрузки", () => {
  const bytes = new TextEncoder().encode("verified-binary-payload");
  const digest = sha(bytes);

  async function withServer(body: Uint8Array, run: (origin: string) => Promise<void>): Promise<void> {
    const server = Bun.serve({ port: 0, fetch: () => new Response(body as unknown as BodyInit) });
    try {
      await run(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  }

  test("совпавшие размер и SHA-256 дают установленный файл", async () => {
    const dir = tempDir();
    await withServer(bytes, async (origin) => {
      const result = await downloadVerified(origin, { name: "omp", platform: "linux", arch: "x86_64", kind: "archive", size: bytes.byteLength, sha256: digest, url: "/d/x" }, join(dir, "omp.new"));
      expect(result.sha256).toBe(digest);
      expect(readFileSync(result.path, "utf8")).toBe("verified-binary-payload");
      expect(statSync(result.path).mode & 0o777).toBe(0o755);
    });
  });

  test("несовпавший SHA-256 — IntegrityError и файла на диске нет", async () => {
    const dir = tempDir();
    const target = join(dir, "omp.bad");
    await withServer(bytes, async (origin) => {
      await expect(
        downloadVerified(origin, { name: "omp", platform: "linux", arch: "x86_64", kind: "archive", size: bytes.byteLength, sha256: "c".repeat(64), url: "/d/x" }, target),
      ).rejects.toBeInstanceOf(IntegrityError);
    });
    expect(existsSync(target)).toBe(false);
  });

  test("несовпавший размер ловится до записи файла", async () => {
    const dir = tempDir();
    const target = join(dir, "omp.size");
    await withServer(bytes, async (origin) => {
      await expect(
        downloadVerified(origin, { name: "omp", platform: "linux", arch: "x86_64", kind: "archive", size: bytes.byteLength + 1, sha256: digest, url: "/d/x" }, target),
      ).rejects.toBeInstanceOf(IntegrityError);
    });
    expect(existsSync(target)).toBe(false);
  });
});

describe("атомарная подмена бинаря и откат", () => {
  test("installBinary сохраняет предыдущий и ставит новый, restoreBinary возвращает старый", () => {
    const dir = tempDir();
    const ompBin = join(dir, "omp");
    const previous = join(dir, "omp.previous");
    writeFileSync(ompBin, "old-binary");
    const newPath = join(dir, "download");
    writeFileSync(newPath, "new-binary");

    const result = installBinary(newPath, ompBin, previous);
    expect(readFileSync(ompBin, "utf8")).toBe("new-binary");
    expect(readFileSync(previous, "utf8")).toBe("old-binary");
    expect(result.previousSha).toBe(sha256File(previous));
    expect(result.installedSha).toBe(sha256File(ompBin));

    restoreBinary(previous, ompBin);
    expect(readFileSync(ompBin, "utf8")).toBe("old-binary");
  });
});
