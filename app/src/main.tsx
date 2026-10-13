import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);

// PWA: register the service worker in secure contexts only.
if ("serviceWorker" in navigator && window.isSecureContext) {
	window.addEventListener("load", () => {
		void navigator.serviceWorker.register("/sw.js");
	});
}
