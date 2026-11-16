import type { Session, SessionState } from "./sessions.js";

/**
 * One design for all states: same type, same layout (state word on top, title in the middle).
 * Quiet states sit on a dark surface and carry their color only in the state word.
 * States that concern the person fill the whole key with their color:
 * green lies still (a result is waiting), amber breathes (Claude is waiting for you).
 * Red is deliberately absent; it stays reserved for errors.
 */
type Style = {
	/** Color of the state word on the dark surface, or the fill color of the key. */
	color: string;
	/** Filled edge to edge? `pulse` additionally lets the fill swell softly. */
	fill?: { ink: string; shade: string; pulse?: boolean };
};

const SURFACE = "#141416";
const BLUE = "#5aa2ff";
const GREEN = "#36c77c";
const AMBER = "#ffb02e";

const STYLE: Record<SessionState, Style> = {
	seen: { color: "#8e8e93" },
	running: { color: BLUE },
	done: { color: GREEN, fill: { ink: "#04240f", shade: "#2aa866" } },
	question: { color: AMBER, fill: { ink: "#2a1600", shade: "#c8700f", pulse: true } },
	permission: { color: AMBER, fill: { ink: "#2a1600", shade: "#c8700f", pulse: true } },
};

/** Words shown on the keys, per language. */
const WORDS = {
	en: { seen: "IDLE", running: "RUNNING", done: "DONE", question: "QUESTION", permission: "PERMISSION", empty: "NEW" },
	de: { seen: "BEREIT", running: "LÄUFT", done: "FERTIG", question: "RÜCKFRAGE", permission: "FREIGABE", empty: "NEU" },
} satisfies Record<string, Record<SessionState | "empty", string>>;

export type Language = keyof typeof WORDS;

export function isLanguage(value: string): value is Language {
	return Object.hasOwn(WORDS, value);
}

/** Ticks (125 ms each) for one swell of the pulse and for one sweep of the progress bar. */
const PULSE_TICKS = 12;
const SWEEP_TICKS = 16;

/** Mixes two hex colors; `t = 0` yields `a`, `t = 1` yields `b`. */
function mix(a: string, b: string, t: number): string {
	const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
	return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

const escapeXml = (s: string): string =>
	s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * Wraps the title into at most `maxLines` lines; the last one is shortened if needed.
 * Breaks happen at spaces and after hyphens; overlong words are split hard.
 */
function wrap(title: string, maxChars: number, maxLines: number): string[] {
	// Each piece remembers whether a space preceded it (otherwise it directly follows a hyphen).
	const pieces = title
		.trim()
		.split(/\s+/)
		.flatMap((word) =>
			word
				.split(/(?<=-)/)
				.flatMap((part) => part.match(new RegExp(`.{1,${maxChars}}`, "gu")) ?? [])
				.map((text, i) => ({ text, space: i === 0 })),
		);
	const lines: string[] = [];
	for (const { text, space } of pieces) {
		const last = lines[lines.length - 1];
		const joined = last === undefined ? text : last + (space ? " " : "") + text;
		if (last !== undefined && joined.length <= maxChars) {
			lines[lines.length - 1] = joined;
		} else if (lines.length < maxLines) {
			lines.push(text);
		} else {
			lines[maxLines - 1] = `${last!.slice(0, maxChars - 1).trimEnd()}…`;
			break;
		}
	}
	return lines;
}

const svg = (body: string): string =>
	`data:image/svg+xml;charset=utf8,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" font-family="-apple-system, Helvetica Neue, Helvetica, Arial, sans-serif">${body}</svg>`,
	)}`;

const word = (text: string, color: string, y: number): string =>
	`<text x="72" y="${y}" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="1.6" fill="${color}">${text}</text>`;

/** Key image for a session. `tick` counts eighths of a second and drives the pulse and the progress bar. */
export function renderSession(session: Session, tick: number, language: Language): string {
	const style = STYLE[session.state];
	const fill = style.fill;

	let background: string;
	if (fill) {
		// Soft breathing between the full color and its darker shade; without `pulse` the fill stands still.
		const depth = fill.pulse ? (1 - Math.cos((2 * Math.PI * (tick % PULSE_TICKS)) / PULSE_TICKS)) / 2 : 0;
		const top = mix(style.color, fill.shade, depth);
		const bottom = mix(top, fill.shade, 0.35);
		background =
			`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>` +
			`<rect width="144" height="144" fill="url(#g)"/>`;
	} else if (session.state === "running") {
		// Dark surface with a hint of the state color from the top.
		background =
			`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${style.color}" stop-opacity="0.30"/><stop offset="0.65" stop-color="${style.color}" stop-opacity="0"/></linearGradient></defs>` +
			`<rect width="144" height="144" fill="${SURFACE}"/><rect width="144" height="144" fill="url(#g)"/>`;
	} else {
		background = `<rect width="144" height="144" fill="${SURFACE}"/>`;
	}

	const label = word(WORDS[language][session.state], fill ? fill.ink : style.color, 30);

	const titleColor = fill ? fill.ink : session.state === "seen" ? "#b9b9bf" : "#ffffff";
	const lines = wrap(session.title, 12, 3);
	const firstY = 86 - (lines.length - 1) * 11 + 6;
	const title = lines
		.map((line, i) => `<text x="72" y="${firstY + i * 22}" text-anchor="middle" font-size="18" font-weight="600" fill="${titleColor}">${escapeXml(line)}</text>`)
		.join("");

	let progress = "";
	if (session.state === "running") {
		// Progress bar: a segment glides softly back and forth along the track.
		const phase = (1 - Math.cos((2 * Math.PI * (tick % SWEEP_TICKS)) / SWEEP_TICKS)) / 2;
		const x = 30 + phase * (84 - 28);
		progress = `<rect x="30" y="130" width="84" height="4" rx="2" fill="#ffffff" opacity="0.12"/><rect x="${x.toFixed(1)}" y="130" width="28" height="4" rx="2" fill="${style.color}"/>`;
	}

	return svg(background + label + title + progress);
}

/** Key image for a free slot; pressing it starts a new session. */
export function renderEmpty(language: Language): string {
	return svg(
		`<rect width="144" height="144" fill="${SURFACE}"/>` +
			`<path d="M72 54v32M56 70h32" stroke="#4a4a50" stroke-width="5" stroke-linecap="round"/>` +
			word(WORDS[language].empty, "#4a4a50", 116),
	);
}
