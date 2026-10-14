import { Download, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

/** Полноэкранный просмотр картинки из ленты: contain, закрытие по фону/Esc, скачивание. */
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): ReactNode {
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return createPortal(
		<div className="tr-imgv" role="dialog" aria-modal="true" aria-label={alt || "Просмотр картинки"} onClick={onClose}>
			<button type="button" className="tr-imgv-close" aria-label="Закрыть" onClick={onClose}>
				<X size={22} />
			</button>
			<img className="tr-imgv-img" src={src} alt={alt} onClick={e => e.stopPropagation()} />
			<a className="tr-imgv-download" href={src} download onClick={e => e.stopPropagation()}>
				<Download size={18} />
				Скачать
			</a>
		</div>,
		document.body,
	);
}
