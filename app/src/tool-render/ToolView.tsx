/**
 * Tool card chrome + per-tool dispatch. Works in the collab-web app and inside
 * the `<omp-tool-view>` web component embedded in HTML session exports.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { LucideIcon } from "lucide-react";
import {
	AppWindow,
	Brain,
	Bug,
	Check,
	CircleAlert,
	Clock,
	FilePen,
	FileText,
	FlaskConical,
	FolderSearch,
	Globe,
	Image,
	ListTodo,
	LogOut,
	MessageCircleQuestion,
	Search,
	SquareTerminal,
	Target,
	Workflow,
	Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { resolveToolRenderer } from "./registry";
import type { ToolRenderHost, ToolRenderProps, ToolResultLike } from "./types";
import { isRecord, replaceTabs, stripAnsi } from "./util";
import "./tool-render.css";

/** Per-tool type icon in the header; unknown tools get a generic wrench. */
const TYPE_ICONS: Record<string, LucideIcon> = {
	bash: SquareTerminal,
	ssh: SquareTerminal,
	read: FileText,
	edit: FilePen,
	apply_patch: FilePen,
	write: FilePen,
	grep: Search,
	search: Search,
	ast_grep: Search,
	glob: FolderSearch,
	find: FolderSearch,
	task: Workflow,
	eval: FlaskConical,
	js: FlaskConical,
	python: FlaskConical,
	notebook: FlaskConical,
	fetch: Globe,
	web_search: Globe,
	browser: AppWindow,
	puppeteer: AppWindow,
	todo: ListTodo,
	goal: Target,
	wait: Clock,
	yield: LogOut,
	ask: MessageCircleQuestion,
	debug: Bug,
	recall: Brain,
	reflect: Brain,
	retain: Brain,
	generate_image: Image,
};

/** Status: word + icon so the state never rides on color alone. */
const STATUS_META: Record<string, { word: string; icon: LucideIcon }> = {
	ok: { word: "готово", icon: Check },
	err: { word: "ошибка", icon: CircleAlert },
	pending: { word: "ожидание", icon: Clock },
	run: { word: "выполняется", icon: Clock },
};

export interface ToolViewProps {
	name: string;
	args?: unknown;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Model-provided intent (`i`), shown atop the body. */
	intent?: string;
	/** Streaming partial output tail while running. */
	partial?: string;
	defaultOpen?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
}

function normalizeArgs(raw: unknown): { args: Record<string, unknown>; intent: string | undefined } {
	if (!isRecord(raw)) return { args: {}, intent: undefined };
	const intent = typeof raw[INTENT_FIELD] === "string" ? (raw[INTENT_FIELD] as string).trim() : undefined;
	if (!(INTENT_FIELD in raw)) return { args: raw, intent };
	const args: Record<string, unknown> = {};
	for (const k in raw) {
		if (k !== INTENT_FIELD) args[k] = raw[k];
	}
	return { args, intent };
}

interface XdevDispatch {
	tool: string;
	args: Record<string, unknown>;
	inner: unknown;
}

function executeXdevDispatch(props: ToolViewProps): XdevDispatch | null {
	if (props.name !== "write" || props.result?.isError === true || !isRecord(props.result?.details)) return null;
	const xdev = props.result.details.xdev;
	if (!isRecord(xdev) || xdev.mode !== "execute" || typeof xdev.tool !== "string") return null;
	return { tool: xdev.tool, args: isRecord(xdev.args) ? xdev.args : {}, inner: xdev.inner };
}

export function ToolView(props: ToolViewProps): ReactNode {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	const xdev = executeXdevDispatch(props);
	const { args, intent: argIntent } = normalizeArgs(props.args);
	const intent = props.intent?.trim() || argIntent;
	const name = xdev?.tool ?? props.name;
	const result = xdev
		? { content: props.result!.content, details: xdev.inner, isError: props.result!.isError }
		: props.result;
	const renderer = resolveToolRenderer(name);
	const renderProps: ToolRenderProps = {
		name,
		args: xdev?.args ?? args,
		result,
		running: props.running,
		host: props.host,
	};

	const isError = props.result?.isError === true;
	const status = props.running ? "run" : isError ? "err" : props.result ? "ok" : "pending";
	const partial = props.running && !props.result && props.partial ? stripAnsi(replaceTabs(props.partial)) : "";
	const displayName = xdev ? `xd://${name}` : name;
	const TypeIcon = TYPE_ICONS[name] ?? Wrench;
	const statusMeta = STATUS_META[status];

	return (
		<div className={`tv-card${isError ? " tv-card--error" : ""}`}>
			<button
				type="button"
				className="tv-head"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
				title={intent || undefined}
			>
				<TypeIcon size={14} className="tv-type" aria-hidden="true" />
				<span className="tv-name">{displayName}</span>
				<span className="tv-sum">
					<renderer.Summary {...renderProps} />
				</span>
				<span
					className={`tv-state tv-state--${status}`}
					aria-label={statusMeta?.word}
				>
					{status === "run" ? (
						<span className="tv-spin" aria-hidden="true" />
					) : (
						<span className={`tv-status tv-status--${status}`} aria-hidden="true" />
					)}
					{/* Слово — только для неблагополучных статусов: ряды «готово» сплошным текстом замусоривают ленту. */}
					{status !== "ok" && statusMeta && <span className="tv-state-word">{statusMeta.word}</span>}
				</span>
				<span className="tv-chev" aria-hidden="true" />
			</button>
			{open && (
				<div className="tv-body">
					{intent && <div className="tv-intent">{intent}</div>}
					{renderer.Body ? <renderer.Body {...renderProps} /> : null}
				</div>
			)}
			{partial && <pre className="tv-partial">{partial.length > 2048 ? `…${partial.slice(-2048)}` : partial}</pre>}
		</div>
	);
}
