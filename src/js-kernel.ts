import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { CuaError, errorMessage } from "./errors.ts";
import type { Sky } from "./sky.ts";

export interface JsOutput {
	text: string[];
	images: string[];
}

export interface JsRunResult {
	ok: boolean;
	error?: string;
	durationMs: number;
	output: JsOutput;
	timedOut?: boolean;
	aborted?: boolean;
}

export interface JsKernelOptions {
	sky: Sky;
	timeoutMs?: number;
	maxTextBytes?: number;
	maxImageBytes?: number;
	maxTotalImageBytes?: number;
	maxOutputImages?: number;
	maxCodeBytes?: number;
	maxPendingRuns?: number;
	resourceLimits?: { maxOldGenerationSizeMb?: number; maxYoungGenerationSizeMb?: number };
	workerPath?: string;
	logger?: (message: string) => void;
}

interface WorkerRun {
	id: number;
	text: TextBuffer;
	images: string[];
	imageBytes: number;
	imageSet: Set<string>;
	resolve: (result: { ok: boolean; error?: string; durationMs: number }) => void;
	finished: boolean;
}

interface WorkerResultMessage {
	type: "result";
	id: number;
	ok: boolean;
	error?: string;
	durationMs: number;
}

type WorkerMessage =
	| { type: "ready" }
	| { type: "rpc"; id: number; method: string; argsJson: string }
	| { type: "output"; id?: number; text: string }
	| { type: "image"; id?: number; dataUrl: string }
	| WorkerResultMessage
	| { type: "fatal"; error: string };

class TextBuffer {
	private chunks: string[] = [];
	private bytes = 0;
	private truncated = false;

	constructor(private readonly maxBytes: number) {}

	append(text: string): void {
		if (!text || this.truncated) return;
		const size = Buffer.byteLength(text, "utf8");
		if (this.bytes + size <= this.maxBytes) {
			this.chunks.push(text);
			this.bytes += size;
			return;
		}
		const remaining = Math.max(0, this.maxBytes - this.bytes);
		if (remaining > 0) {
			const slice = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8").replace(/�+$/, "");
			if (slice) this.chunks.push(slice);
		}
		this.chunks.push("\n...[JavaScript output truncated by codex-computer-use-mcp-win]");
		this.truncated = true;
	}

	value(): string {
		return this.chunks.join("");
	}
}

function resolveWorkerPath(override?: string): string {
	if (override) return override;
	const base = fileURLToPath(new URL("./js-worker", import.meta.url));
	for (const extension of [".js", ".ts"]) {
		if (existsSync(`${base}${extension}`)) return `${base}${extension}`;
	}
	throw new CuaError("JS_ERROR", "Cannot locate js-worker.js. Run npm run build before starting the server.");
}

function imageByteLength(dataUrl: string): number {
	const comma = dataUrl.indexOf(",");
	if (comma < 0) return Number.POSITIVE_INFINITY;
	const base64 = dataUrl.slice(comma + 1);
	return Math.floor((base64.length * 3) / 4);
}

export class JsKernel {
	private readonly options: JsKernelOptions;
	private readonly workerPath: string;
	private worker: Worker | null = null;
	private ready: Promise<void> | null = null;
	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private currentRun: WorkerRun | null = null;
	private nextRunId = 1;
	private epoch = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private pendingRuns = 0;
	private closed = false;
	private lastError: string | null = null;

	constructor(options: JsKernelOptions) {
		this.options = options;
		this.workerPath = resolveWorkerPath(options.workerPath);
	}

	get isRunning(): boolean {
		return this.worker !== null;
	}

	get error(): string | null {
		return this.lastError;
	}

	private log(message: string): void {
		(this.options.logger ?? ((value) => console.error(value)))(`[computer-use] ${message}`);
	}

	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.then(() => undefined, () => undefined);
		return next;
	}

	private post(worker: Worker, message: unknown): void {
		if (this.worker !== worker) return;
		try { worker.postMessage(message); } catch { /* worker terminated */ }
	}

	private startWorker(): Promise<void> {
		if (this.closed) return Promise.reject(new CuaError("JS_ERROR", "Computer Use JavaScript session is closed"));
		if (this.worker && this.ready) return this.ready;
		const typescriptSupport = (process.features as { typescript?: string | false }).typescript;
		const execArgv = this.workerPath.endsWith(".ts") && !typescriptSupport
			? ["--experimental-strip-types"]
			: [];
		const worker = new Worker(this.workerPath, {
			workerData: { cwd: process.cwd(), homeDir: os.homedir(), tmpDir: os.tmpdir() },
			execArgv,
			resourceLimits: this.options.resourceLimits ?? {
				maxOldGenerationSizeMb: 512,
				maxYoungGenerationSizeMb: 64,
			},
		});
		this.worker = worker;
		this.lastError = null;
		this.ready = new Promise<void>((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		const startup = setTimeout(() => {
			if (this.worker !== worker) return;
			const error = new CuaError("JS_ERROR", "Computer Use JavaScript worker did not start in time");
			this.epoch += 1;
			this.readyReject?.(error);
			this.lastError = error.message;
			void worker.terminate();
			if (this.worker === worker) this.worker = null;
		}, 15_000);
		worker.on("message", (message: WorkerMessage) => {
			clearTimeout(startup);
			this.handleMessage(worker, message);
		});
		worker.on("error", (error) => {
			clearTimeout(startup);
			this.epoch += 1;
			this.lastError = error.message;
			this.log(`JavaScript worker error: ${error.message}`);
			if (this.worker === worker) {
				this.readyReject?.(error);
				this.worker = null;
				this.ready = null;
				this.readyResolve = null;
				this.readyReject = null;
				this.finishRun({ ok: false, error: `Computer Use JavaScript worker failed: ${error.message}`, durationMs: 0 });
			}
		});
		worker.on("exit", (code) => {
			clearTimeout(startup);
			if (this.worker !== worker) return;
			this.epoch += 1;
			const rejectReady = this.readyReject;
			this.worker = null;
			this.ready = null;
			this.readyResolve = null;
			this.readyReject = null;
			const error = new CuaError("JS_ERROR", `Computer Use JavaScript worker exited (code ${code ?? "unknown"})`);
			this.lastError = error.message;
			// A worker that exits before posting ready must settle startWorker();
			// otherwise the js call waits forever and ignores timeout_ms.
			rejectReady?.(error);
			this.finishRun({ ok: false, error: error.message, durationMs: 0 });
		});
		return this.ready;
	}

	private handleMessage(worker: Worker, message: WorkerMessage): void {
		if (this.worker !== worker) return;
		switch (message.type) {
			case "ready":
				this.readyResolve?.();
				this.readyResolve = null;
				this.readyReject = null;
				return;
			case "rpc":
				void this.handleRpc(worker, message);
				return;
			case "output":
				// Drop late writes and timer output that belong to an earlier run.
				if (this.currentRun && message.id === this.currentRun.id) this.currentRun.text.append(message.text);
				return;
			case "image":
				if (this.currentRun && message.id === this.currentRun.id) this.addImage(message.dataUrl);
				return;
			case "result":
				if (this.currentRun && this.currentRun.id === message.id) {
					this.finishRun({ ok: message.ok, error: message.error, durationMs: message.durationMs });
				}
				return;
			case "fatal":
				this.epoch += 1;
				this.lastError = message.error;
				this.log(`JavaScript worker fatal error: ${message.error}`);
				this.readyReject?.(new Error(message.error));
				this.finishRun({ ok: false, error: `Computer Use JavaScript worker failed: ${message.error}`, durationMs: 0 });
				if (this.worker === worker) {
					this.worker = null;
					this.ready = null;
					this.readyResolve = null;
					this.readyReject = null;
					void worker.terminate();
				}
				return;
		}
	}

	private addImage(dataUrl: string): void {
		const run = this.currentRun;
		if (!run || run.finished) return;
		if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;
		if (run.images.length >= (this.options.maxOutputImages ?? 8)) return;
		const bytes = imageByteLength(dataUrl);
		if (!Number.isFinite(bytes)) return;
		const maxImageBytes = this.options.maxImageBytes ?? 8 * 1024 * 1024;
		if (bytes > maxImageBytes) return;
		const maxTotalBytes = this.options.maxTotalImageBytes ?? Math.min(16 * 1024 * 1024, maxImageBytes * 4);
		if (run.imageBytes + bytes > maxTotalBytes) return;
		if (run.imageSet.has(dataUrl)) return;
		run.imageSet.add(dataUrl);
		run.imageBytes += bytes;
		run.images.push(dataUrl);
	}

	private finishRun(result: { ok: boolean; error?: string; durationMs: number }): void {
		const run = this.currentRun;
		if (!run || run.finished) return;
		run.finished = true;
		run.resolve(result);
	}

	private async handleRpc(worker: Worker, message: { id: number; method: string; argsJson: string }): Promise<void> {
		try {
			const args = JSON.parse(message.argsJson) as unknown;
			if (!Array.isArray(args)) throw new Error("RPC arguments must be an array");
			const result = await this.callSky(message.method, args);
			const json = result === undefined ? "null" : JSON.stringify(result);
			if (json.length > 64 * 1024 * 1024) throw new Error("Computer Use result is too large to return to the JavaScript runtime");
			this.post(worker, { type: "rpc-result", id: message.id, ok: true, result: json });
		} catch (error) {
			this.post(worker, { type: "rpc-result", id: message.id, ok: false, error: errorMessage(error) });
		}
	}

	private async callSky(method: string, args: unknown[]): Promise<unknown> {
		const sky = this.options.sky;
		switch (method) {
			case "sky.list_apps": return await sky.list_apps();
			case "sky.list_windows": return await sky.list_windows();
			case "sky.get_window": return await sky.get_window(args[0] as { id: number | string; app?: string });
			case "sky.get_window_state": return await sky.get_window_state(args[0] as Parameters<Sky["get_window_state"]>[0]);
			case "sky.activate_window": return await sky.activate_window(args[0] as { window: unknown });
			case "sky.launch_app": return await sky.launch_app(args[0] as { app: string });
			case "sky.click": return await sky.click(args[0] as Record<string, unknown>);
			case "sky.press_key": return await sky.press_key(args[0] as { window: unknown; key: string });
			case "sky.type_text": return await sky.type_text(args[0] as { window: unknown; text: string });
			case "sky.scroll": return await sky.scroll(args[0] as Record<string, unknown>);
			case "sky.set_value": return await sky.set_value(args[0] as { window: unknown; element_index: number; value: string });
			case "sky.drag": return await sky.drag(args[0] as Record<string, unknown>);
			case "sky.perform_secondary_action": return await sky.perform_secondary_action(args[0] as { window: unknown; element_index: number; action: string });
			default: throw new Error(`Unknown Computer Use RPC method: ${method}`);
		}
	}

	async run(code: string, timeoutMs = this.options.timeoutMs ?? 30_000, signal?: AbortSignal): Promise<JsRunResult> {
		const maxPendingRuns = Math.max(1, this.options.maxPendingRuns ?? 8);
		if (this.pendingRuns >= maxPendingRuns) {
			return {
				ok: false,
				error: `Too many Computer Use JavaScript runs are queued (maximum ${maxPendingRuns})`,
				durationMs: 0,
				output: { text: [], images: [] },
			};
		}
		this.pendingRuns += 1;
		const epoch = this.epoch;
		try {
			return await this.enqueue(async () => await this.runInternal(code, timeoutMs, signal, epoch));
		} finally {
			this.pendingRuns -= 1;
		}
	}

	private async runInternal(code: string, timeoutMs: number, signal: AbortSignal | undefined, epoch: number): Promise<JsRunResult> {
		if (this.closed) return { ok: false, error: "Computer Use JavaScript session is closed", durationMs: 0, output: { text: [], images: [] } };
		if (epoch !== this.epoch) return { ok: false, error: "The Computer Use JavaScript session was reset before this execution started", durationMs: 0, output: { text: [], images: [] } };
		if (typeof code !== "string" || !code.trim()) {
			return { ok: false, error: "code must be a non-empty string", durationMs: 0, output: { text: [], images: [] } };
		}
		const maxCodeBytes = this.options.maxCodeBytes ?? 1024 * 1024;
		if (Buffer.byteLength(code, "utf8") > maxCodeBytes) {
			return { ok: false, error: `code is too large (maximum ${maxCodeBytes} bytes)`, durationMs: 0, output: { text: [], images: [] } };
		}
		const clampedTimeout = Math.min(600_000, Math.max(1, Math.trunc(timeoutMs)));
		try {
			await this.startWorker();
		} catch (error) {
			return { ok: false, error: errorMessage(error), durationMs: 0, output: { text: [], images: [] } };
		}
		if (epoch !== this.epoch) {
			return { ok: false, error: "The Computer Use JavaScript session was reset before this execution started", durationMs: 0, output: { text: [], images: [] } };
		}
		const worker = this.worker;
		if (!worker) return { ok: false, error: "Computer Use JavaScript worker is not running", durationMs: 0, output: { text: [], images: [] } };
		const run: WorkerRun = {
			id: this.nextRunId++,
			text: new TextBuffer(this.options.maxTextBytes ?? 2 * 1024 * 1024),
			images: [],
			imageBytes: 0,
			imageSet: new Set<string>(),
			resolve: () => { /* replaced below */ },
			finished: false,
		};
		this.currentRun = run;
		this.options.sky.setImageSink((dataUrl) => this.addImage(dataUrl));
		const resultPromise = new Promise<{ ok: boolean; error?: string; durationMs: number; kind: "result" }>((resolve) => {
			run.resolve = (result) => resolve({ ...result, kind: "result" });
		});
		let timeoutHandle: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
			timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), clampedTimeout);
		});
		let abortHandler: (() => void) | undefined;
		const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
			if (!signal) return;
			if (signal.aborted) return resolve({ kind: "aborted" });
			abortHandler = () => resolve({ kind: "aborted" });
			signal.addEventListener("abort", abortHandler, { once: true });
		});
		const started = Date.now();
		this.post(worker, { type: "run", id: run.id, code });
		const outcome = await Promise.race([resultPromise, timeoutPromise, abortPromise]);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
		if (this.currentRun === run) this.currentRun = null;
		if (this.currentRun === null) this.options.sky.setImageSink(undefined);
		if (outcome.kind === "timeout" || outcome.kind === "aborted") {
			const reason = outcome.kind === "timeout"
				? `JavaScript execution timed out after ${clampedTimeout}ms; the Computer Use session was reset`
				: "JavaScript execution was cancelled; the Computer Use session was reset";
			this.log(reason);
			this.epoch += 1;
			this.options.sky.abort(reason);
			await this.terminateWorker();
			return {
				ok: false,
				error: reason,
				durationMs: Date.now() - started,
				output: { text: [run.text.value()].filter(Boolean), images: run.images },
				timedOut: outcome.kind === "timeout",
				aborted: outcome.kind === "aborted",
			};
		}
		return {
			ok: outcome.ok,
			error: outcome.error,
			durationMs: outcome.durationMs,
			output: { text: [run.text.value()].filter(Boolean), images: run.images },
		};
	}

	async reset(): Promise<void> {
		this.epoch += 1;
		this.options.sky.setImageSink(undefined);
		await this.terminateWorker();
	}

	async close(): Promise<void> {
		this.closed = true;
		this.epoch += 1;
		this.options.sky.setImageSink(undefined);
		await this.terminateWorker();
	}

	private async terminateWorker(): Promise<void> {
		const worker = this.worker;
		this.worker = null;
		const readyReject = this.readyReject;
		this.ready = null;
		this.readyResolve = null;
		this.readyReject = null;
		readyReject?.(new CuaError("JS_ERROR", "Computer Use JavaScript worker was reset"));
		this.finishRun({ ok: false, error: "Computer Use JavaScript worker was reset", durationMs: 0 });
		if (worker) {
			try { await worker.terminate(); } catch { /* ignore */ }
		}
	}
}
