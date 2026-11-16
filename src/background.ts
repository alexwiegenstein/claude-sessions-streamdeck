import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Sitzungsprotokolle der CLI: `<Projekt>/<sessionId>.jsonl`, eine JSON-Zeile je Ereignis. */
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CHUNK_BYTES = 4 * 1024 * 1024;

type Task = { kind: "shell" | "agent"; startedAt: number };

type ContentBlock = { type?: string; name?: string; text?: string; input?: Record<string, unknown> };

/** Werkzeug, mit dem Claude in der Desktop-App eine Runde abschließt; `ask` ist die Frage an den Menschen. */
const WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";

/**
 * Liest das Protokoll einer Session fortlaufend mit. Der Statuseintrag der CLI kennt nur die Hauptsession
 * und nur Dialoge; zwei Dinge stehen allein hier:
 * - welche Hintergrundaufgaben (Shell-Befehle und Sub-Agents) gestartet, aber noch nicht beendet sind,
 * - ob die letzte Runde mit einer Frage an den Menschen geendet hat.
 */
export class Transcript {
	#offset = 0;
	#partial = "";
	readonly #open = new Map<string, Task>();
	/** Seit dem letzten Rundenbeginn: Frage in der Abschluss-Box gestellt? */
	#asked = false;
	/** Seit dem letzten Rundenbeginn: letzter Antworttext der Hauptsession. */
	#lastText = "";

	constructor(readonly path: string) {}

	async update(): Promise<void> {
		const { size } = await stat(this.path);
		if (size < this.#offset) {
			this.#offset = 0;
			this.#partial = "";
			this.#open.clear();
			this.#startTurn();
		}
		if (size === this.#offset) return;
		const file = await open(this.path, "r");
		try {
			const decoder = new TextDecoder();
			while (this.#offset < size) {
				const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - this.#offset));
				const { bytesRead } = await file.read(buffer, 0, buffer.length, this.#offset);
				if (bytesRead === 0) break;
				this.#offset += bytesRead;
				const lines = (this.#partial + decoder.decode(buffer.subarray(0, bytesRead), { stream: true })).split("\n");
				this.#partial = lines.pop()!;
				for (const line of lines) this.apply(line);
			}
		} finally {
			await file.close();
		}
	}

	/** Offene Aufgaben, die nach `since` gestartet wurden (ältere gehören zu einem früheren Prozess und sind mit ihm beendet). */
	openTasks(since: number): Task[] {
		return [...this.#open.values()].filter((task) => task.startedAt >= since);
	}

	/** Ob die letzte Runde mit einer offenen Frage endete: per Abschluss-Box oder als Schlusssatz mit Fragezeichen. */
	endsWithQuestion(): boolean {
		return this.#asked || /\?["“”»)*_`\s]*$/.test(this.#lastText);
	}

	#startTurn(): void {
		this.#asked = false;
		this.#lastText = "";
	}

	/** Verarbeitet eine Protokollzeile. */
	apply(line: string): void {
		// Billige Vorprüfung; große Zeilen ohne Belang (z. B. Anfrage-Mitschnitte) werden nicht geparst.
		const isTask = line.includes('"backgroundTaskId"') || line.includes('"async_launched"') || line.includes('"queue-operation"');
		const isMessage = line.includes('"type":"assistant"') || line.includes('"type":"user"');
		if (!isTask && !isMessage) return;
		const entry = JSON.parse(line) as {
			type?: string;
			operation?: string;
			content?: unknown;
			timestamp?: string;
			isSidechain?: boolean;
			isMeta?: boolean;
			toolUseResult?: { backgroundTaskId?: unknown; agentId?: unknown; status?: unknown };
			message?: { content?: unknown };
		};
		if (entry.isSidechain === true) return;

		if (entry.type === "queue-operation") {
			if (entry.operation !== "enqueue") {
				// Eine eingereihte Meldung wurde abgeholt: Claude arbeitet wieder.
				this.#startTurn();
			} else if (typeof entry.content === "string") {
				// Nur Meldungen mit Status beenden eine Aufgabe; Zwischenmeldungen tragen keinen.
				const id = /<task-id>([^<]+)<\/task-id>/.exec(entry.content)?.[1];
				if (id && /<status>[^<]+<\/status>/.test(entry.content)) this.#open.delete(id);
			}
			return;
		}

		if (entry.type === "user") {
			const result = entry.toolUseResult;
			if (result && typeof result === "object") {
				const startedAt = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
				if (typeof result.backgroundTaskId === "string") this.#open.set(result.backgroundTaskId, { kind: "shell", startedAt });
				else if (result.status === "async_launched" && typeof result.agentId === "string") this.#open.set(result.agentId, { kind: "agent", startedAt });
			}
			const content = entry.message?.content;
			const isPrompt = typeof content === "string" || (Array.isArray(content) && (content as ContentBlock[]).some((block) => block.type === "text"));
			// Eine neue Nachricht des Menschen beantwortet die offene Frage.
			if (isPrompt && entry.isMeta !== true) this.#startTurn();
			return;
		}

		if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
			for (const block of entry.message.content as ContentBlock[]) {
				if (block.type === "text" && block.text?.trim()) {
					this.#lastText = block.text;
				} else if (block.type === "tool_use" && block.name === WRAP_UP_TOOL) {
					this.#asked = typeof block.input?.ask === "string" && block.input.ask.trim() !== "";
				} else if (block.type === "tool_use" && block.name === "TaskStop" && block.input) {
					for (const value of Object.values(block.input)) if (typeof value === "string") this.#open.delete(value);
				} else if (block.type === "tool_use") {
					// Nach dem letzten Text wurde weitergearbeitet: Er war nicht das Schlusswort.
					this.#lastText = "";
				}
			}
		}
	}
}

const transcripts = new Map<string, Transcript>();

async function findTranscript(sessionId: string): Promise<Transcript | undefined> {
	const known = transcripts.get(sessionId);
	if (known) return known;
	for (const project of await readdir(PROJECTS_DIR, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const path = join(PROJECTS_DIR, project.name, `${sessionId}.jsonl`);
		try {
			await stat(path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		const transcript = new Transcript(path);
		transcripts.set(sessionId, transcript);
		return transcript;
	}
	return undefined;
}

async function hasChildProcesses(pid: number): Promise<boolean> {
	try {
		await run("/usr/bin/pgrep", ["-P", String(pid)]);
		return true;
	} catch (err) {
		// pgrep endet mit 1, wenn es keinen Kindprozess gibt.
		if ((err as { code?: unknown }).code === 1) return false;
		throw err;
	}
}

export type TranscriptFindings = { backgroundWork: boolean; question: boolean };

/**
 * Was das Protokoll über eine ruhende Session verrät. `startedAt` ist der Start des CLI-Prozesses `pid`.
 * Shell-Aufgaben sind Kindprozesse der CLI: Gibt es keine mehr, sind sie beendet, auch ohne Abschlussmeldung.
 */
export async function inspectTranscript(sessionId: string, pid: number, startedAt: number): Promise<TranscriptFindings> {
	const transcript = await findTranscript(sessionId);
	if (!transcript) return { backgroundWork: false, question: false };
	await transcript.update();
	const tasks = transcript.openTasks(startedAt);
	const backgroundWork = tasks.some((task) => task.kind === "agent") || (tasks.length > 0 && (await hasChildProcesses(pid)));
	return { backgroundWork, question: transcript.endsWithQuestion() };
}

/** Gibt die Protokolle beendeter Sessions frei. */
export function forgetTranscriptsExcept(sessionIds: Set<string>): void {
	for (const id of transcripts.keys()) if (!sessionIds.has(id)) transcripts.delete(id);
}
