import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Session transcripts written by the CLI: `<project>/<sessionId>.jsonl`, one JSON line per event. */
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CHUNK_BYTES = 4 * 1024 * 1024;

type Task = { kind: "shell" | "agent"; startedAt: number };

type ContentBlock = { type?: string; name?: string; text?: string; input?: Record<string, unknown> };

/** Tool Claude uses in the desktop app to close a turn; `ask` is its question to the person. */
const WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";

/**
 * Follows the transcript of one session. The CLI's status record only knows about the main session
 * and about dialogs; two things are recorded here alone:
 * - which background tasks (shell commands and subagents) were started but have not finished yet,
 * - whether the last turn ended with a question to the person.
 */
export class Transcript {
	#offset = 0;
	#partial = "";
	readonly #open = new Map<string, Task>();
	/** Since the current turn began: was a question asked in the closing box? */
	#asked = false;
	/** Since the current turn began: the main session's last answer text. */
	#lastText = "";

	constructor(readonly path: string) {}

	/** Reads whatever was appended to the transcript since the last call. */
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

	/** Open tasks started after `since`; older ones belonged to a previous process and ended with it. */
	openTasks(since: number): Task[] {
		return [...this.#open.values()].filter((task) => task.startedAt >= since);
	}

	/** Whether the last turn ended with an open question: in the closing box, or as a final sentence ending in a question mark. */
	endsWithQuestion(): boolean {
		return this.#asked || /\?["“”»)*_`\s]*$/.test(this.#lastText);
	}

	#startTurn(): void {
		this.#asked = false;
		this.#lastText = "";
	}

	/** Processes one transcript line. */
	apply(line: string): void {
		// Cheap pre-check; large irrelevant lines (e.g. request dumps) are never parsed.
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
				// A queued notification was picked up: Claude is working again.
				this.#startTurn();
			} else if (typeof entry.content === "string") {
				// Only notifications carrying a status end a task; progress notifications have none.
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
			// A new message from the person answers the open question.
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
					// Work continued after the last text, so it was not the closing message.
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
		// pgrep exits with 1 when there is no child process.
		if ((err as { code?: unknown }).code === 1) return false;
		throw err;
	}
}

export type TranscriptFindings = { backgroundWork: boolean; question: boolean };

/**
 * What the transcript reveals about an idle session. `startedAt` is the start time of the CLI process `pid`.
 * Shell tasks are child processes of the CLI: once there are none left, they have ended, even without a notification.
 */
export async function inspectTranscript(sessionId: string, pid: number, startedAt: number): Promise<TranscriptFindings> {
	const transcript = await findTranscript(sessionId);
	if (!transcript) return { backgroundWork: false, question: false };
	await transcript.update();
	const tasks = transcript.openTasks(startedAt);
	const backgroundWork = tasks.some((task) => task.kind === "agent") || (tasks.length > 0 && (await hasChildProcesses(pid)));
	return { backgroundWork, question: transcript.endsWithQuestion() };
}

/** Drops the transcripts of sessions that are no longer running. */
export function forgetTranscriptsExcept(sessionIds: Set<string>): void {
	for (const id of transcripts.keys()) if (!sessionIds.has(id)) transcripts.delete(id);
}
