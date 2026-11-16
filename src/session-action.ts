import { execFile } from "node:child_process";
import { promisify } from "node:util";

import streamDeck, { type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";

import { renderEmpty, renderSession } from "./render.js";
import { loadSessions, NEW_SESSION_URL, type Session, sessionUrl } from "./sessions.js";

const run = promisify(execFile);
/** Takt der Anzeige (Pulsieren, Laufbalken); die Sessions werden einmal pro Sekunde neu gelesen. */
const TICK_MS = 125;
const TICKS_PER_LOAD = 8;
const DEFAULT_RECENT_HOURS = 8;

/** Für alle Tasten gemeinsam; wird in den Tasteneinstellungen gesetzt. */
type GlobalSettings = { recentHours?: number };

function toRecentHours(settings: GlobalSettings): number {
	const hours = settings.recentHours;
	if (hours === undefined) return DEFAULT_RECENT_HOURS;
	if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) throw new Error(`Ungültige Frist: ${JSON.stringify(hours)}`);
	return hours;
}

/**
 * Eine Taste = ein Platz. Alle sichtbaren Tasten dieser Aktion werden zeilenweise
 * (oben links zuerst) mit den laufenden Sessions gefüllt, älteste zuerst.
 */
export class SessionAction extends SingletonAction {
	override readonly manifestId = "pro.identic.claude-sessions.session";

	#timer: NodeJS.Timeout | undefined;
	#tick = 0;
	#refreshing = false;
	#sessions: Session[] = [];
	/** Wie lange eine angesehene, ruhende Session noch als aktuell gilt; `undefined` bis die Einstellungen geladen sind. */
	#recentHours: number | undefined;

	constructor() {
		super();
		streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
			this.#recentHours = toRecentHours(ev.settings);
			this.#tick = 0; // nächster Takt liest die Sessions neu
			void this.#refresh();
		});
	}
	/** Zuletzt gesetztes Bild und zugeordnete Session je Tasten-ID. */
	readonly #shown = new Map<string, { image: string; session: Session | undefined }>();

	override async onWillAppear(_ev: WillAppearEvent): Promise<void> {
		this.#recentHours ??= toRecentHours(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
		this.#timer ??= setInterval(() => void this.#refresh(), TICK_MS);
		await this.#refresh();
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#shown.delete(ev.action.id);
		if ([...this.actions].length === 0) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const session = this.#shown.get(ev.action.id)?.session;
		try {
			await run("/usr/bin/open", [session ? sessionUrl(session.id) : NEW_SESSION_URL]);
		} catch (err) {
			streamDeck.logger.error("Claude konnte nicht geöffnet werden", err);
			await ev.action.showAlert();
		}
	}

	async #refresh(): Promise<void> {
		if (this.#refreshing || this.#recentHours === undefined) return;
		this.#refreshing = true;
		try {
			if (this.#tick++ % TICKS_PER_LOAD === 0) this.#sessions = await loadSessions(this.#recentHours * 3_600_000);
			const sessions = this.#sessions;
			const keys = [...this.actions]
				.filter((a) => a.isKey())
				.sort((a, b) => {
					const ca = a.coordinates ?? { row: 0, column: 0 };
					const cb = b.coordinates ?? { row: 0, column: 0 };
					return a.device.id.localeCompare(b.device.id) || ca.row - cb.row || ca.column - cb.column;
				});
			const slotByDevice = new Map<string, number>();
			for (const key of keys) {
				const slot = slotByDevice.get(key.device.id) ?? 0;
				slotByDevice.set(key.device.id, slot + 1);
				const session = sessions[slot];
				const image = session ? renderSession(session, this.#tick) : renderEmpty();
				if (this.#shown.get(key.id)?.image !== image) await key.setImage(image);
				this.#shown.set(key.id, { image, session });
			}
		} catch (err) {
			streamDeck.logger.error("Sessions konnten nicht gelesen werden", err);
			for (const key of this.actions) if (key.isKey()) await key.showAlert();
		} finally {
			this.#refreshing = false;
		}
	}
}
