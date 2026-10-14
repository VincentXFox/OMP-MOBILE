import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

export interface ConfirmSheetProps {
	open: boolean;
	title: string;
	body: string;
	/** Monospace block showing exactly what will be executed (optional). */
	command?: string;
	confirmLabel: string;
	danger?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

/** Bottom sheet for destructive-action confirmation (HIG: explicit, typed intent).
 * role=dialog + aria-labelledby, Escape cancels, focus moves in and returns on close. */
export function ConfirmSheet({
	open,
	title,
	body,
	command,
	confirmLabel,
	danger = false,
	onConfirm,
	onCancel,
}: ConfirmSheetProps): ReactNode {
	const titleId = useId();
	const sheetRef = useRef<HTMLDivElement>(null);
	const restoreRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!open) return;
		restoreRef.current = document.activeElement as HTMLElement | null;
		sheetRef.current?.focus();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			restoreRef.current?.focus?.();
		};
	}, [open, onCancel]);

	if (!open) return null;

	return (
		<div className="pk-sheet-backdrop" onClick={onCancel}>
			<div
				ref={sheetRef}
				className="pk-sheet"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				onClick={e => e.stopPropagation()}
			>
				<div className="pk-sheet-grabber" aria-hidden="true" />
				<h2 className="pk-sheet-title pk-confirm-title" id={titleId}>
					{danger && <AlertTriangle size={20} className="pk-confirm-warn" aria-hidden="true" />}
					{title}
				</h2>
				<p className="pk-confirm-body">{body}</p>
				{command !== undefined && (
					<pre className="pk-confirm-command" aria-label="Команда, которая будет выполнена">
						{command}
					</pre>
				)}
				<div className="pk-confirm-actions">
					<button type="button" className="pk-btn pk-btn--ghost" onClick={onCancel}>
						Отмена
					</button>
					<button
						type="button"
						className={`pk-btn${danger ? " pk-btn--danger" : " pk-btn--primary"}`}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
