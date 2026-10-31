import { useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { TodoBoard, TodoTaskStatus } from "../../lib/todo-board";

const STATUS_ICONS: Record<TodoTaskStatus, string> = {
	completed: "✓",
	in_progress: "→",
	abandoned: "✕",
	pending: "○",
};

/** Липкий туду-бар: «Задача N/M» + прогресс, тап — список пунктов. */
export function TodoBar({ board }: { board: TodoBoard }): ReactNode {
	const [open, setOpen] = useState(false);
	const doneShare = board.total > 0 ? Math.round((board.done / board.total) * 100) : 0;
	const allDone = board.done >= board.total;
	return (
		<div className="ss-todo">
			<button
				type="button"
				className="ss-todo-bar"
				aria-expanded={open}
				onClick={() => setOpen(prev => !prev)}
			>
				<span className="ss-todo-bar-label">
					Задача <span className="ss-todo-bar-count">{board.done}/{board.total}</span>
				</span>
				<span className="ss-todo-bar-progress" aria-hidden="true">
					<span className="ss-todo-bar-progress-fill" style={{ width: `${doneShare}%` }} />
				</span>
				{allDone ? <Check size={14} className="ss-todo-bar-check" aria-label="Все пункты выполнены" /> : null}
				<ChevronDown size={16} className={`ss-todo-bar-chevron${open ? " ss-todo-bar-chevron--open" : ""}`} />
			</button>
			{open && (
				<div className="ss-todo-board">
					{board.phases.map((phase, pi) => (
						<div key={`p${pi}`} className="ss-todo-phase">
							{board.phases.length > 1 && <div className="ss-todo-phase-name">{`${pi + 1}. ${phase.name}`}</div>}
							{phase.tasks.map((task, ti) => (
								<div key={`p${pi}t${ti}`} className={`ss-todo-task ss-todo-task--${task.status}`}>
									<span className="ss-todo-task-icon">{STATUS_ICONS[task.status]}</span>
									<span>{task.content}</span>
								</div>
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
