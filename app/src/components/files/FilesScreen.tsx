import { ArrowLeft, FileText, Folder, FolderGit2, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { listProjectFiles, projectGit } from "../../lib/gateway";
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

function Breadcrumbs(props: { path: string; root: string; onJump: (path: string) => void }): ReactNode {
	const { path, root, onJump } = props;
	const rest = path.startsWith(root) ? path.slice(root.length) : path;
	const parts = rest.split("/").filter(p => p.length > 0);
	const segments: { label: string; target: string }[] = [{ label: root, target: root }];
	let acc = root;
	for (const part of parts) {
		acc = acc === "/" ? `/${part}` : `${acc}/${part}`;
		segments.push({ label: part, target: acc });
	}
	return (
		<div className="fs-crumbs">
			{segments.map((seg, i) => (
				<span key={seg.target} className="fs-crumb-wrap">
					{i > 0 && <span className="fs-crumb-sep">/</span>}
					<button
						type="button"
						className={`fs-crumb${i === segments.length - 1 ? " fs-crumb--current" : ""}`}
						onClick={() => onJump(seg.target)}
					>
						{seg.label}
					</button>
				</span>
			))}
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
						if (line.startsWith("+")) cls += " fs-line--add";
						else if (line.startsWith("-")) cls += " fs-line--del";
						else if (line.startsWith("@@")) cls += " fs-line--hunk";
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
	const [gitView, setGitView] = useState<{ title: string; text: string } | null>(null);

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
				<button type="button" className="fs-icon-btn" onClick={onBack} aria-label="Назад">
					<ArrowLeft size={20} />
				</button>
				<div className="fs-title">Файлы проекта</div>
				{hasGit && <FolderGit2 size={18} className="fs-git-badge" />}
			</header>

			<Breadcrumbs path={path} root={root} onJump={target => void load(target)} />

			{error != null && <div className="fs-error">{error}</div>}

			<div className="fs-list">
				{entries === null && error === null && <div className="fs-loading">Загрузка…</div>}
				{entries !== null && path !== root && (
					<button
						type="button"
						className="fs-row"
						onClick={() => void load(parentPath(path))}
					>
						<ArrowLeft size={16} className="fs-row-icon" />
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
							<span className="fs-row-size">{humanSize(entry.size)}</span>
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
							{sheetFile.size !== null && ` · ${humanSize(sheetFile.size)}`}
						</div>
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
