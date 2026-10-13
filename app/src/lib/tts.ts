/** TTS («Озвучка») preferences + speech helpers, backed by localStorage. */

const TTS_ENABLED_KEY = "ompPocket.tts";
const TTS_RATE_KEY = "ompPocket.ttsRate";

export const TTS_RATE_MIN = 0.7;
export const TTS_RATE_MAX = 1.2;

export function isTtsEnabled(): boolean {
	try {
		return localStorage.getItem(TTS_ENABLED_KEY) === "1";
	} catch {
		return false;
	}
}

export function setTtsEnabled(on: boolean): void {
	try {
		if (on) localStorage.setItem(TTS_ENABLED_KEY, "1");
		else localStorage.removeItem(TTS_ENABLED_KEY);
	} catch {
		// storage unavailable — non-fatal
	}
}

export function getTtsRate(): number {
	try {
		const parsed = Number(localStorage.getItem(TTS_RATE_KEY));
		if (Number.isFinite(parsed) && parsed >= TTS_RATE_MIN && parsed <= TTS_RATE_MAX) return parsed;
	} catch {
		// storage unavailable — non-fatal
	}
	return 1;
}

export function setTtsRate(rate: number): void {
	try {
		localStorage.setItem(TTS_RATE_KEY, String(rate));
	} catch {
		// storage unavailable — non-fatal
	}
}

let cachedRuVoice: SpeechSynthesisVoice | null | undefined;

function pickRuVoice(): SpeechSynthesisVoice | null {
	if (cachedRuVoice !== undefined) return cachedRuVoice;
	const voices = window.speechSynthesis.getVoices();
	cachedRuVoice = voices.find(v => v.lang.toLowerCase().startsWith("ru")) ?? null;
	return cachedRuVoice;
}

/** Speaks assistant text with the system voice (ru preferred) at the saved rate. */
export function speakAssistantText(text: string): void {
	if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
	const synth = window.speechSynthesis;
	synth.cancel();
	const utterance = new SpeechSynthesisUtterance(text);
	const voice = pickRuVoice();
	if (voice) utterance.voice = voice;
	utterance.lang = voice?.lang ?? "ru-RU";
	utterance.rate = getTtsRate();
	synth.speak(utterance);
}

/** Stops any in-flight speech (abort, unmount). */
export function cancelSpeech(): void {
	if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}
