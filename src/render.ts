import type { Session, SessionState } from "./sessions.js";

/**
 * Ein Design für alle Zustände: gleiche Schrift, gleiche Aufteilung (Zustand oben, Titel in der Mitte).
 * Ruhige Zustände stehen auf dunkler Fläche und tragen ihre Farbe nur im Zustandswort.
 * Zustände, die den Menschen betreffen, füllen die ganze Taste mit ihrer Farbe:
 * Grün liegt ruhig da (Ergebnis wartet), Bernstein atmet (Claude wartet auf dich).
 * Rot kommt bewusst nicht vor; es bleibt Fehlern vorbehalten.
 */
type Style = {
	label: string;
	/** Farbe des Zustandsworts auf dunkler Fläche bzw. Füllfarbe der Taste. */
	color: string;
	/** Vollflächig gefüllt? `pulse` lässt die Füllung zusätzlich weich an- und abschwellen. */
	fill?: { ink: string; shade: string; pulse?: boolean };
};

const SURFACE = "#141416";
const BLUE = "#5aa2ff";
const GREEN = "#36c77c";
const AMBER = "#ffb02e";

const STYLE: Record<SessionState, Style> = {
	seen: { label: "BEREIT", color: "#8e8e93" },
	running: { label: "LÄUFT", color: BLUE },
	done: { label: "FERTIG", color: GREEN, fill: { ink: "#04240f", shade: "#2aa866" } },
	question: { label: "RÜCKFRAGE", color: AMBER, fill: { ink: "#2a1600", shade: "#c8700f", pulse: true } },
	permission: { label: "FREIGABE", color: AMBER, fill: { ink: "#2a1600", shade: "#c8700f", pulse: true } },
};

/** Takte (zu 125 ms) für ein An- und Abschwellen bzw. einen Durchlauf des Laufbalkens. */
const PULSE_TICKS = 12;
const SWEEP_TICKS = 16;

/** Mischt zwei Hex-Farben; `t = 0` ergibt `a`, `t = 1` ergibt `b`. */
function mix(a: string, b: string, t: number): string {
	const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
	return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, "0")).join("")}`;
}

const escapeXml = (s: string): string =>
	s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Bricht den Titel in höchstens `maxLines` Zeilen um; die letzte wird bei Bedarf gekürzt. */
function wrap(title: string, maxChars: number, maxLines: number): string[] {
	const words = title.split(/\s+|(?<=-)/).flatMap((w) => w.match(new RegExp(`.{1,${maxChars}}`, "gu")) ?? []);
	const lines: string[] = [];
	for (const word of words) {
		const last = lines[lines.length - 1];
		if (last !== undefined && last.length + 1 + word.length <= maxChars) {
			lines[lines.length - 1] = `${last} ${word}`;
		} else if (lines.length < maxLines) {
			lines.push(word);
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

/** Tastenbild für eine Session. `tick` zählt Achtelsekunden und treibt Pulsieren und Laufbalken. */
export function renderSession(session: Session, tick: number): string {
	const style = STYLE[session.state];
	const fill = style.fill;

	let background: string;
	if (fill) {
		// Weiches Atmen zwischen voller Farbe und ihrem dunkleren Ton; ohne `pulse` steht die Fläche still.
		const depth = fill.pulse ? (1 - Math.cos((2 * Math.PI * (tick % PULSE_TICKS)) / PULSE_TICKS)) / 2 : 0;
		const top = mix(style.color, fill.shade, depth);
		const bottom = mix(top, fill.shade, 0.35);
		background =
			`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>` +
			`<rect width="144" height="144" fill="url(#g)"/>`;
	} else if (session.state === "running") {
		// Dunkle Fläche mit einem Hauch der Zustandsfarbe von oben.
		background =
			`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${style.color}" stop-opacity="0.30"/><stop offset="0.65" stop-color="${style.color}" stop-opacity="0"/></linearGradient></defs>` +
			`<rect width="144" height="144" fill="${SURFACE}"/><rect width="144" height="144" fill="url(#g)"/>`;
	} else {
		background = `<rect width="144" height="144" fill="${SURFACE}"/>`;
	}

	const label = `<text x="72" y="30" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="1.6" fill="${fill ? fill.ink : style.color}">${style.label}</text>`;

	const titleColor = fill ? fill.ink : session.state === "seen" ? "#b9b9bf" : "#ffffff";
	const lines = wrap(session.title, 12, 3);
	const firstY = 86 - (lines.length - 1) * 11 + 6;
	const title = lines
		.map((line, i) => `<text x="72" y="${firstY + i * 22}" text-anchor="middle" font-size="18" font-weight="600" fill="${titleColor}">${escapeXml(line)}</text>`)
		.join("");

	let progress = "";
	if (session.state === "running") {
		// Laufbalken: ein Segment gleitet weich über die Spur hin und zurück.
		const phase = (1 - Math.cos((2 * Math.PI * (tick % SWEEP_TICKS)) / SWEEP_TICKS)) / 2;
		const x = 30 + phase * (84 - 28);
		progress = `<rect x="30" y="130" width="84" height="4" rx="2" fill="#ffffff" opacity="0.12"/><rect x="${x.toFixed(1)}" y="130" width="28" height="4" rx="2" fill="${style.color}"/>`;
	}

	return svg(background + label + title + progress);
}

/** Tastenbild für einen freien Platz; ein Druck startet eine neue Session. */
export function renderEmpty(): string {
	return svg(
		`<rect width="144" height="144" fill="${SURFACE}"/>` +
			`<path d="M72 54v32M56 70h32" stroke="#4a4a50" stroke-width="5" stroke-linecap="round"/>` +
			`<text x="72" y="116" text-anchor="middle" font-size="15" font-weight="700" letter-spacing="1.6" fill="#4a4a50">NEU</text>`,
	);
}
