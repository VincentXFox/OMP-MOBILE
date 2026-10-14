import { ArrowLeft, FileText, Folder, FolderGit2, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { listProjectFiles, projectGit, readProjectFile } from "../../lib/gateway";
import type { ProjectFileEntry } from "../../lib/gateway";
import "./files.css";

function humanSize(size: number | null): string {
	if (size === null) return "";
	if (size < 1024) return `${size} Б`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
	return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function parentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	if (idx <= 0) return "/";
	return path.slice(0, idx);
}

const TEXT_PREVIEW_EXTS: Record<string, true> = {
	bash: true, c: true, cfg: true, conf: true, cpp: true, cjs: true, css: true, csv: true, env: true, go: true,
	graphql: true, h: true, hpp: true, htm: true, html: true, ini: true, java: true, js: true, json: true,
	jsonc: true, jsx: true, less: true, lock: true, log: true, lua: true, md: true, mdx: true, mjs: true,
	php: true, prisma: true, py: true, rb: true, rs: true, sass: true, scss: true, sh: true, sql: true,
	svg: true, svelte: true, toml: true, ts: true, tsx: true, txt: true, vue: true, xml: true, yaml: true, yml: true, zsh: true,
};
const TEXT_PREVIEW_MAX_BYTES = 200 * 1024;

function hasTextPreview(entry: ProjectFileEntry): boolean {
	const dot = entry.name.lastIndexOf(".");
	return dot > 0 && entry.size !== null && entry.size <= TEXT_PREVIEW_MAX_BYTES && TEXT_PREVIEW_EXTS[entry.name.slice(dot + 1).toLowerCase()] === true;
}

type FilePreview =
	| { state: "hidden" }
	| { state: "loading" }
	| { state: "error"; message: string }
	| { state: "ok"; content: string };

/** Сегментированные крошки: корень «/», промежуточные сегменты сжаты в «…»,
 * последний показан целиком. Тап по «…» и «/» поднимает на уровень вверх. */
function Breadcrumbs(props: { path: string; root: string; onJump: (path: string) => void }): ReactNode {
	const { path, root, onJump } = props;
	const rest = path.startsWith(root) ? path.slice(root.length) : path;
	const parts = rest.split("/").filter(p => p.length > 0);
	const parent = parts.length > 1 ? parentPath(path) : root;
	const current = parts[parts.length - 1] ?? "";
	const rootCurrent = parts.length === 0;
	return (
		<div className="fs-crumbs" role="navigation" aria-label="Путь">
			<button
				type="button"
				className={`fs-crumb${rootCurrent ? " fs-crumb--current" : ""}`}
				onClick={() => onJump(root)}
				aria-label="Корень"
			>
				/
			</button>
			{parts.length > 1 && (
				<>
					<button type="button" className="fs-crumb" onClick={() => onJump(parent)} aria-label="На уровень выше">
						…
					</button>
				</>
			)}
			{!rootCurrent && parts.length > 1 && (
				<>
					<span className="fs-crumb-sep">/</span>
					<span className="fs-crumb fs-crumb--current" aria-current="location">
						{current}
					</span>
				</>
			)}
			{!rootCurrent && parts.length === 1 && (
				<span className="fs-crumb fs-crumb--current" aria-current="location">
					{current}
				</span>
			)}
		</div>
	);
}

function GitView(props: { title: string; text: string; onBack: () => void }): ReactNode {
	return (
		<div className="fs-git-root">
			<header className="fs-git-header">
				<button type="button" className="fs-icon-btn" onClick={props.onBack} aria-label="Назад">
					<ArrowLeft size={20} />
				</button>
				<div className="fs-git-title">{props.title}</div>
			</header>
			<div className="fs-git-scroll">
				<pre className="fs-git-text">
					{props.text.split("\n").map((line, i) => {
						let cls = "fs-line";
						if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) {
							cls += " fs-line--meta"; // заголовок файла, не содержимое
						} else if (line.startsWith("+")) {
							cls += " fs-line--add";
						} else if (line.startsWith("-")) {
							cls += " fs-line--del";
						} else if (line.startsWith("@@")) {
							cls += " fs-line--hunk";
						}
						return (
							<span key={i} className={cls}>
								{line}
								{"\n"}
							</span>
						);
					})}
				</pre>
			</div>
		</div>
	);
}

export function FilesScreen(props: { root: string; onBack: () => void }): ReactNode {
	const { root, onBack } = props;
	const [path, setPath] = useState(root);
	const [entries, setEntries] = useState<ProjectFileEntry[] | null>(null);
	const [hasGit, setHasGit] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sheetFile, setSheetFile] = useState<ProjectFileEntry | null>(null);
	const [preview, setPreview] = useState<FilePreview>({ state: "hidden" });
	const [copied, setCopied] = useState(false);
	const [gitView, setGitView] = useState<{ title: string; text: string } | null>(null);

	useEffect(() => {
		setCopied(false);
		if (sheetFile === null || sheetFile.type !== "file" || !hasTextPreview(sheetFile)) {
			setPreview({ state: "hidden" });
			return;
		}
		let alive = true;
		setPreview({ state: "loading" });
		readProjectFile(path, sheetFile.name)
			.then(content => {
				if (alive) setPreview({ state: "ok", content });
			})
			.catch((err: unknown) => {
				if (alive) setPreview({ state: "error", message: err instanceof Error ? err.message : String(err) });
			});
		return () => {
			alive = false;
		};
	}, [sheetFile, path]);

	const copyPreview = useCallback(() => {
		if (preview.state !== "ok") return;
		void navigator.clipboard.writeText(preview.content).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		});
	}, [preview]);

	const load = useCallback(async (dir: string) => {
		setError(null);
		setEntries(null);
		try {
			const data = await listProjectFiles(dir);
			const sorted = [...data.entries].sort((a, b) => {
				if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
				return a.name.localeCompare(b.name, "ru");
			});
			setEntries(sorted);
			setHasGit(data.hasGit);
			setPath(dir);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load(root);
	}, [load, root]);

	const openGit = useCallback(
		async (mode: "status" | "diff") => {
			setError(null);
			try {
				const text = await projectGit(path, mode);
				if (text === null) {
					setError("Git недоступен в этой папке");
					return;
				}
				setSheetFile(null);
				setGitView({ title: mode === "status" ? "git status" : "git diff", text });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[path],
	);

	if (gitView !== null) {
		return <GitView title={gitView.title} text={gitView.text} onBack={() => setGitView(null)} />;
	}

	return (
		<div className="fs-root">
			<header className="fs-header">
				<div className="fs-header-bar">
					<button type="button" className="fs-icon-btn" onClick={onBack} aria-label="Назад">
						<ArrowLeft size={18} />
					</button>
					{hasGit && <FolderGit2 size={16} className="fs-git-badge" />}
				</div>
				<div className="fs-title">Файлы проекта</div>
				<Breadcrumbs path={path} root={root} onJump={target => void load(target)} />
			</header>

			{error != null && <div className="fs-error">{error}</div>}

			<div className="fs-list">
				{entries === null && error === null && <div className="fs-loading">Загрузка…</div>}
				{entries !== null && path !== root && (
					<button
						type="button"
						className="fs-row"
						onClick={() => void load(parentPath(path))}
					>
						<ArrowLeft size={16} className="fs-row-icon fs-row-icon--up" />
						<span className="fs-row-name">…</span>
					</button>
				)}
				{entries !== null &&
					entries.map(entry => (
						<button
							key={entry.name}
							type="button"
							className="fs-row"
							onClick={() => {
								if (entry.type === "dir") void load(`${path === "/" ? "" : path}/${entry.name}`);
								else setSheetFile(entry);
							}}
						>
							{entry.type === "dir" ? (
								<Folder size={16} className="fs-row-icon fs-row-icon--dir" />
							) : (
								<FileText size={16} className="fs-row-icon" />
							)}
							<span className="fs-row-name">{entry.name}</span>
							{entry.type === "file" && <span className="fs-row-size">{humanSize(entry.size)}</span>}
						</button>
					))}
				{entries !== null && entries.length === 0 && path === root && (
					<div className="fs-loading">Папка пуста</div>
				)}
			</div>

			{sheetFile !== null && (
				<>
					<div className="fs-sheet-backdrop" onClick={() => setSheetFile(null)} />
					<div className="fs-sheet" role="dialog" aria-modal="true">
						<div className="fs-sheet-handle" />
						<div className="fs-sheet-name">{sheetFile.name}</div>
						<div className="fs-sheet-meta">
							{sheetFile.type === "dir" ? "папка" : "файл"}
							{sheetFile.type === "file" && sheetFile.size !== null && ` · ${humanSize(sheetFile.size)}`}
						</div>
						{preview.state === "loading" && <div className="fs-preview-msg">Загрузка…</div>}
						{preview.state === "error" && <div className="fs-preview-msg">Не удалось загрузить: {preview.message}</div>}
						{preview.state === "hidden" && sheetFile.type === "file" && (
							<div className="fs-preview-msg">Предпросмотр недоступен</div>
						)}
						{preview.state === "ok" && (
							<div className="fs-preview">
								<div className="fs-preview-bar">
									<span className="fs-preview-label">Предпросмотр</span>
									<button
										type="button"
										className={`fs-preview-copy${copied ? " fs-preview-copy--done" : ""}`}
										onClick={copyPreview}
									>
										{copied ? "Скопировано" : "Копировать"}
									</button>
								</div>
								<div className="fs-preview-scroll">
									<pre className="fs-preview-text">{preview.content}</pre>
								</div>
							</div>
						)}
						{hasGit && (
							<div className="fs-sheet-actions">
								<button type="button" className="fs-opt" onClick={() => void openGit("diff")}>
									<GitBranch size={16} /> git diff
								</button>
								<button type="button" className="fs-opt" onClick={() => void openGit("status")}>
									<GitBranch size={16} /> git status
								</button>
							</div>
						)}
						<button type="button" className="fs-opt fs-opt--dismiss" onClick={() => setSheetFile(null)}>
							Закрыть
						</button>
					</div>
				</>
			)}
		</div>
	);
}
