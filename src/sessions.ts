import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { forgetTranscriptsExcept, inspectTranscript } from "./background.js";

/** Verzeichnis, in dem jede laufende Claude-Code-Instanz ihren Stand als `<pid>.json` ablegt. */
const CLI_SESSIONS_DIR = join(homedir(), ".claude", "sessions");
/** Sitzungsdateien der Desktop-App; liefern, wann eine Session zuletzt angesehen wurde. */
const DESKTOP_SESSIONS_DIR = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");

export type SessionState = "running" | "question" | "permission" | "done" | "seen";

export type Session = {
	/** ID der Desktop-Session (`local_…`), Ziel des Deep-Links. */
	id: string;
	title: string;
	state: SessionState;
	startedAt: number;
};

type CliRecord = {
	pid: number;
	/** ID der CLI-Session; so heißt auch ihr Protokoll. */
	sessionId: string;
	kind?: string;
	spare?: boolean;
	hostSessionId?: string;
	name?: string;
	cwd: string;
	startedAt: number;
	status?: "busy" | "shell" | "idle" | "waiting";
	waitingFor?: string;
};

const HOST_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw err;
	}
}

/** Liest eine JSON-Datei; `undefined`, wenn sie verschwunden ist oder gerade geschrieben wird. */
async function readJson<T>(path: string): Promise<T | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	try {
		return JSON.parse(text) as T;
	} catch (err) {
		if (err instanceof SyntaxError) return undefined;
		throw err;
	}
}

const desktopFileCache = new Map<string, string>();

async function findDesktopFile(hostSessionId: string): Promise<string | undefined> {
	const cached = desktopFileCache.get(hostSessionId);
	if (cached) return cached;
	for (const account of await readdir(DESKTOP_SESSIONS_DIR, { withFileTypes: true })) {
		if (!account.isDirectory()) continue;
		const accountDir = join(DESKTOP_SESSIONS_DIR, account.name);
		for (const org of await readdir(accountDir, { withFileTypes: true })) {
			if (!org.isDirectory()) continue;
			const dir = join(accountDir, org.name);
			if ((await readdir(dir)).includes(`${hostSessionId}.json`)) {
				const path = join(dir, `${hostSessionId}.json`);
				desktopFileCache.set(hostSessionId, path);
				return path;
			}
		}
	}
	return undefined;
}

type DesktopRecord = { lastFocusedAt?: number; lastActivityAt?: number; isArchived?: boolean };

/** Was die Desktop-App zur Session vermerkt hat: archiviert, zuletzt im Vordergrund, zuletzt aktiv. */
async function readDesktopRecord(hostSessionId: string): Promise<DesktopRecord | undefined> {
	const path = await findDesktopFile(hostSessionId);
	if (!path) return undefined;
	const desktop = await readJson<DesktopRecord>(path);
	if (!desktop) desktopFileCache.delete(hostSessionId);
	return desktop;
}

function toState(record: CliRecord, desktop: DesktopRecord | undefined): SessionState {
	switch (record.status) {
		case "busy":
		case "shell":
			return "running";
		case "waiting":
			return record.waitingFor === "permission prompt" ? "permission" : "question";
		case "idle":
		case undefined: {
			const seen = desktop?.lastFocusedAt !== undefined && desktop.lastFocusedAt >= (desktop.lastActivityAt ?? 0);
			return seen ? "seen" : "done";
		}
	}
}

/**
 * Die aktuellen Sessions der Claude-Desktop-App, älteste zuerst (stabile Reihenfolge auf den Tasten).
 * Angesehene, ruhende Sessions zählen nur, solange ihre letzte Aktivität höchstens `recentMs` zurückliegt,
 * auch wenn ihre letzte Runde mit einer Frage endete. Was läuft, in einem Dialog wartet oder ungesehen ist, zählt immer.
 */
export async function loadSessions(recentMs: number): Promise<Session[]> {
	const files = (await readdir(CLI_SESSIONS_DIR)).filter((name) => /^\d+\.json$/.test(name));
	const sessions: Session[] = [];
	const liveSessionIds = new Set<string>();
	for (const file of files) {
		const record = await readJson<CliRecord>(join(CLI_SESSIONS_DIR, file));
		if (!record) continue;
		if (record.kind !== "interactive" || record.spare === true) continue;
		if (!record.hostSessionId || !HOST_SESSION_ID.test(record.hostSessionId)) continue;
		if (!isAlive(record.pid)) continue;
		const desktop = await readDesktopRecord(record.hostSessionId);
		if (desktop?.isArchived === true) continue;
		liveSessionIds.add(record.sessionId);
		let state = toState(record, desktop);
		if (state === "done" || state === "seen") {
			const { backgroundWork, question } = await inspectTranscript(record.sessionId, record.pid, record.startedAt);
			const stale = state === "seen" && Date.now() - (desktop?.lastActivityAt ?? record.startedAt) > recentMs;
			// Die Runde endete mit einer Frage an den Menschen; der Statuseintrag der CLI meldet das nicht.
			// Das geht vor: Auch wenn im Hintergrund noch etwas läuft, wartet Claude auf eine Antwort.
			if (question && !stale) state = "question";
			// Die Hauptsession ruht, aber Hintergrundaufgaben arbeiten noch: nicht fertig.
			else if (backgroundWork) state = "running";
			else if (stale) continue;
		}
		sessions.push({
			id: record.hostSessionId,
			title: record.name?.trim() || record.cwd.split("/").pop() || record.cwd,
			state,
			startedAt: record.startedAt,
		});
	}
	forgetTranscriptsExcept(liveSessionIds);
	return sessions.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

export function sessionUrl(id: string): string {
	return `claude://code/continue?session=${encodeURIComponent(id)}`;
}

export const NEW_SESSION_URL = "claude://code/new";
