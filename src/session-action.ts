import { execFile } from "node:child_process";
import { promisify } from "node:util";

import streamDeck, { type KeyDownEvent, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";

import { isLanguage, type Language, renderEmpty, renderSession } from "./render.js";
import { loadSessions, NEW_SESSION_URL, type Session, sessionUrl } from "./sessions.js";

const run = promisify(execFile);
/** Display tick (pulse, progress bar); sessions are re-read once per second. */
const TICK_MS = 125;
const TICKS_PER_LOAD = 8;

/** Shared by all keys; set in the key's settings in the Stream Deck app. */
type GlobalSettings = { recentHours?: number; language?: string };

type Config = {
	/** How long an idle session that has been looked at still counts as current. */
	recentHours: number;
	/** Language of the words on the keys. */
	language: Language;
};

const DEFAULTS: Config = { recentHours: 8, language: "en" };

function toConfig(settings: GlobalSettings): Config {
	const { recentHours = DEFAULTS.recentHours, language = DEFAULTS.language } = settings;
	if (typeof recentHours !== "number" || !Number.isFinite(recentHours) || recentHours < 0) throw new Error(`Invalid recentHours setting: ${JSON.stringify(recentHours)}`);
	if (!isLanguage(language)) throw new Error(`Invalid language setting: ${JSON.stringify(language)}`);
	return { recentHours, language };
}

/**
 * One key = one slot. All visible keys of this action are filled row by row
 * (top left first) with the running sessions, oldest first.
 */
export class SessionAction extends SingletonAction {
	override readonly manifestId = "com.alexwiegenstein.claude-sessions.session";

	#timer: NodeJS.Timeout | undefined;
	#tick = 0;
	#refreshing = false;
	#sessions: Session[] = [];
	/** `undefined` until the settings have been loaded. */
	#config: Config | undefined;
	/** Last image set and the session assigned, per key ID. */
	readonly #shown = new Map<string, { image: string; session: Session | undefined }>();

	constructor() {
		super();
		streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
			this.#config = toConfig(ev.settings);
			this.#tick = 0; // the next tick re-reads the sessions
			void this.#refresh();
		});
	}

	override async onWillAppear(_ev: WillAppearEvent): Promise<void> {
		this.#config ??= toConfig(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
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
			streamDeck.logger.error("Could not open Claude", err);
			await ev.action.showAlert();
		}
	}

	async #refresh(): Promise<void> {
		const config = this.#config;
		if (this.#refreshing || config === undefined) return;
		this.#refreshing = true;
		try {
			if (this.#tick++ % TICKS_PER_LOAD === 0) this.#sessions = await loadSessions(config.recentHours * 3_600_000);
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
				const image = session ? renderSession(session, this.#tick, config.language) : renderEmpty(config.language);
				if (this.#shown.get(key.id)?.image !== image) await key.setImage(image);
				this.#shown.set(key.id, { image, session });
			}
		} catch (err) {
			streamDeck.logger.error("Could not read the sessions", err);
			for (const key of this.actions) if (key.isKey()) await key.showAlert();
		} finally {
			this.#refreshing = false;
		}
	}
}
