import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { ApprovalController, HelperApprovalRequest } from "./approval.ts";
import { HelperError } from "./errors.ts";

export interface HelperWindow {
	app: string;
	id: number;
	title?: string;
}

export interface HelperScreenshot {
	id: string;
	zIndex: number;
	url: string;
	originX?: number;
	originY?: number;
	width?: number;
	height?: number;
	urlOmitted?: string;
}

export interface HelperAccessibilityState {
	tree: string;
	focused_element?: string;
	selected_text?: string;
	selected_elements?: string[];
	document_text?: string;
}

export interface HelperWindowState {
	window: HelperWindow;
	screenshots: HelperScreenshot[];
	accessibility: HelperAccessibilityState | null;
}

export interface HelperApp {
	id: string;
	displayName?: string;
	windows: HelperWindow[];
	lastUsedDate?: string;
	useCount?: number;
	isRunning?: boolean;
}

export interface HelperClientOptions {
	helperPath: string;
	/** Extra arguments inserted before --parent-pid. Useful for test doubles and local builds. */
	helperArgs?: string[];
	codexPath: string;
	codexHome: string;
	cwd?: string;
	timeoutMs?: number;
	approval: ApprovalController;
	env?: NodeJS.ProcessEnv;
	logger?: (message: string) => void;
	onEvent?: (event: unknown) => void;
	onExit?: (error: Error) => void;
}

const ENV_ALLOWLIST = [
	"SystemRoot", "windir", "SystemDrive", "ProgramData", "ProgramFiles",
	"ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
	"LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
	"USERNAME", "USERDOMAIN", "COMPUTERNAME", "TEMP", "TMP", "COMSPEC", "PATHEXT",
	"NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS",
] as const;

/**
 * Build a minimal environment for the signed helper. The helper is trusted,
 * but it does not need the caller's API keys, cloud credentials, proxy
 * passwords, NODE_OPTIONS, or other unrelated secrets.
 */
export function minimalHelperEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ENV_ALLOWLIST) {
		const value = source[name];
		if (typeof value === "string" && value.length > 0) env[name] = value;
	}
	const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
	env.PATH = [
		path.join(systemRoot, "System32"),
		systemRoot,
		path.join(systemRoot, "System32", "Wbem"),
		path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
	].join(";");
	if (!env.TEMP) env.TEMP = os.tmpdir();
	if (!env.TMP) env.TMP = env.TEMP;
	return env;
}

type Pending = {
	resolve: (response: HelperResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	method: string;
	child: ChildProcessWithoutNullStreams;
};

type HelperResponse =
	| { ok: true; result: unknown }
	| { ok: false; approvalRequest: HelperApprovalRequest };

const STDERR_TAIL_BYTES = 16 * 1024;

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function errorHint(stderr: string): string {
	const text = stderr.toLowerCase();
	if (text.includes("window is minimized") || text.includes("window is not visible")) {
		return " The window is minimized or hidden. Call sky.activate_window({window}), refresh it with sky.get_window({id, app}), then retry get_window_state.";
	}
	if (text.includes("failed to launch codex app-server: program not found")) {
		return " The helper could not find the Codex CLI. Set codexPath in config.json.";
	}
	if (text.includes("codex app-server exited before returning response")) {
		return " Codex could not authenticate. Open the ChatGPT desktop app or Codex, sign in, and check codexHome in config.json.";
	}
	if (text.includes("auth") || text.includes("login") || text.includes("unauthorized")) {
		return " Codex may not be signed in. Open the ChatGPT desktop app or Codex and sign in.";
	}
	if (text.includes("no longer available in this turn") || text.includes("turn has ended")) {
		return " The helper's Computer Use turn ended, often because Codex shares this CODEX_HOME. Restart the server or wait for the idle timeout; do not retry the action.";
	}
	if (text.includes("physical escape") || text.includes("stopped by the user")) {
		return " The user stopped Computer Use with the physical Escape key. Do not retry; re-observe the app or restart the server if the turn remains ended.";
	}
	if (text.includes("native pipe")) {
		return " The helper tried to use ChatGPT's native pipe transport. This server should force the direct helper transport; check SKY_CUA_NATIVE_PIPE in the environment.";
	}
	if (text.includes("approval") || text.includes("approved")) {
		return " The helper requires application approval. Approve the app in your MCP client, or set approval to \"auto\" in config.json.";
	}
	return "";
}

export class HelperClient {
	private readonly options: HelperClientOptions;
	private child: ChildProcessWithoutNullStreams | null = null;
	private lines: Interface | null = null;
	private nextId = 1;
	private epoch = 0;
	private pending = new Map<number, Pending>();
	private stderrTail = "";
	private closing = false;
	private queue: Promise<unknown> = Promise.resolve();
	private exitHandler: (() => void) | null = null;

	constructor(options: HelperClientOptions) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	private log(message: string): void {
		(this.options.logger ?? ((value) => console.error(value)))(`[computer-use] ${message}`);
	}

	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		// Work queued before an abort/close/timeout belongs to the cancelled run.
		// A helper restart must never silently execute it afterwards.
		const epoch = this.epoch;
		const guarded = (): Promise<T> => {
			if (epoch !== this.epoch) {
				throw new HelperError("HELPER_EXITED", "Computer Use request was cancelled before it started");
			}
			return run();
		};
		const next = this.queue.then(guarded, guarded);
		this.queue = next.then(() => undefined, () => undefined);
		return next;
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.closing) throw new HelperError("HELPER_EXITED", "Computer Use helper is closing");
		if (this.child && this.child.exitCode === null && this.child.signalCode === null) return this.child;
		const env: NodeJS.ProcessEnv = {
			...minimalHelperEnv(process.env),
			...this.options.env,
			CODEX_HOME: this.options.codexHome,
			CODEX_CLI_PATH: this.options.codexPath,
			SKY_CUA_NATIVE_PIPE: "0",
			SKY_ENABLE_AUDIO: "0",
		};
		delete env.SKY_CUA_NATIVE_PIPE_DIRECTORY;
		const child = spawn(
			this.options.helperPath,
			[...(this.options.helperArgs ?? []), "--parent-pid", String(process.pid)],
			{
				cwd: this.options.cwd ?? os.tmpdir(),
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				detached: false,
			},
		);
		this.child = child;
		this.stderrTail = "";
		this.lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		this.lines.on("line", (line) => this.handleLine(line));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${stripAnsi(chunk)}`;
			if (this.stderrTail.length > STDERR_TAIL_BYTES) {
				this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_BYTES);
			}
		});
		child.stdin.on("error", (error) => {
			this.log(`helper stdin error: ${error.message}`);
		});
		child.on("error", (error) => {
			this.epoch += 1;
			this.failAll(new HelperError("HELPER_START_FAILED", `Could not start the Computer Use helper: ${error.message}${errorHint(this.stderrTail)}`, { cause: error }));
		});
		child.on("exit", (code, signal) => {
			this.epoch += 1;
			const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			const stderr = this.stderrTail.trim();
			const error = new HelperError(
				"HELPER_EXITED",
				`Computer Use helper exited with ${detail}${stderr ? `: ${stderr.slice(-4_000)}` : ""}${errorHint(stderr)}`,
			);
			if (!this.closing) this.log(error.message);
			if (this.child === child) {
				this.child = null;
				this.lines?.close();
				this.lines = null;
			}
			this.failAll(error, false, child);
			if (!this.closing) this.options.onExit?.(error);
		});
		const exitHandler = () => {
			try {
				spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
					windowsHide: true,
					stdio: "ignore",
					timeout: 5_000,
				});
			} catch {
				try { child.kill(); } catch { /* ignore */ }
			}
		};
		this.exitHandler = exitHandler;
		process.once("exit", exitHandler);
		child.once("exit", () => {
			process.off("exit", exitHandler);
			if (this.exitHandler === exitHandler) this.exitHandler = null;
		});
		return child;
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let message: unknown;
		try {
			message = JSON.parse(trimmed);
		} catch {
			const child = this.child;
			const error = new HelperError("HELPER_ERROR", `Computer Use helper emitted invalid JSON: ${trimmed.slice(0, 200)}`);
			this.log(error.message);
			this.epoch += 1;
			this.failAll(error, false, child ?? undefined);
			this.lines?.close();
			this.lines = null;
			if (child) {
				this.killTree(child);
				if (this.child === child) this.child = null;
			}
			return;
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			this.log(`helper emitted a non-object message: ${trimmed.slice(0, 500)}`);
			return;
		}
		const record = message as Record<string, unknown>;
		const id = record.id;
		if (typeof id !== "number") {
			this.options.onEvent?.(message);
			return;
		}
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		if (record.ok === true) {
			pending.resolve({ ok: true, result: record.result });
			return;
		}
		const approval = record.approvalRequest;
		if (approval && typeof approval === "object" && !Array.isArray(approval)) {
			const request = approval as Record<string, unknown>;
			if (typeof request.app === "string" && request.app.trim()) {
				pending.resolve({
					ok: false,
					approvalRequest: {
						app: request.app,
						displayName: typeof request.displayName === "string" && request.displayName.trim() ? request.displayName : request.app,
						riskLevel: request.riskLevel === "high" || request.riskLevel === "low" ? request.riskLevel : undefined,
						allowPersistentApproval: request.allowPersistentApproval !== false,
					},
				});
				return;
			}
		}
		const messageText = typeof record.error === "string" && record.error.trim()
			? record.error.trim()
			: "Computer Use helper request failed";
		pending.reject(new HelperError("HELPER_ERROR", `${messageText}${errorHint(`${this.stderrTail}\n${messageText}`)}`, { helperMethod: pending.method }));
	}

	private failAll(error: Error, clearStderr = true, child?: ChildProcessWithoutNullStreams): void {
		for (const [id, pending] of this.pending) {
			if (child && pending.child !== child) continue;
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
		if (clearStderr) this.stderrTail = "";
	}

	private timeoutFor(method: string): number {
		return this.options.timeoutMs ?? (method === "launch_app" ? 90_000 : 60_000);
	}

	private sendRaw(method: string, params: Record<string, unknown>, meta?: Record<string, unknown>): Promise<HelperResponse> {
		const child = this.ensureStarted();
		const id = this.nextId++;
		const timeoutMs = this.timeoutFor(method);
		return new Promise<HelperResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				const error = new HelperError(
					"HELPER_TIMEOUT",
					`Computer Use helper request timed out after ${timeoutMs}ms: ${method}${errorHint(this.stderrTail)}`,
					{ helperMethod: method },
				);
				this.log(error.message);
				this.epoch += 1;
				this.killTree(child);
				this.failAll(error, false, child);
				if (this.child === child) this.child = null;
				reject(error);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout, method, child });
			// Always align the helper's own request budget with the client timer.
			// The official transport overwrites this value on every request.
			const requestMeta = { ...(meta ?? {}), "x-oai-cua-request-budget-ms": timeoutMs };
			const request = { id, method, params, meta: requestMeta };
			child.stdin.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timeout);
				reject(new HelperError("HELPER_START_FAILED", `Could not write to the Computer Use helper: ${error.message}`, { cause: error, helperMethod: method }));
			});
		});
	}

	private assertRequestAllowed(method: string, params: Record<string, unknown>): void {
		if (method === "list_apps" || method === "list_windows" || method === "close" || method === "end_turn") return;
		if (method === "launch_app") {
			const app = params.app;
			if (typeof app !== "string" || !app.trim()) throw new HelperError("HELPER_ERROR", "launch_app requires an app id or executable path");
			this.options.approval.assertAllowed(app);
			return;
		}
		if (method === "get_window") {
			return;
		}
		const window = params.window;
		if (window && typeof window === "object" && !Array.isArray(window)) {
			const app = (window as Record<string, unknown>).app;
			if (typeof app === "string" && app.trim()) {
				this.options.approval.assertAllowed(app);
				return;
			}
		}
		// Let the helper validate malformed input; no app to check.
	}

	private async requestOnce(
		method: string,
		params: Record<string, unknown>,
		meta?: Record<string, unknown>,
		epoch = this.epoch,
	): Promise<HelperResponse> {
		if (epoch !== this.epoch) {
			throw new HelperError("HELPER_EXITED", "Computer Use request was cancelled", { helperMethod: method });
		}
		this.assertRequestAllowed(method, params);
		return this.sendRaw(method, params, meta);
	}

	private async requestWithApproval(method: string, params: Record<string, unknown>): Promise<unknown> {
		const epoch = this.epoch;
		let response = await this.requestOnce(method, params, undefined, epoch);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			if (response.ok) return response.result;
			const request = response.approvalRequest;
			this.log(`approval requested for ${request.displayName} (${request.app})`);
			await this.options.approval.approve(request);
			// The run may have timed out or been cancelled while the approval
			// prompt was open. Never execute the action afterwards on a new helper.
			if (epoch !== this.epoch) {
				throw new HelperError("HELPER_EXITED", "Computer Use request was cancelled while waiting for approval", { helperMethod: method });
			}
			const meta = { "x-oai-cua-approved-app": request.app };
			response = await this.requestOnce(method, params, meta, epoch);
		}
		throw new HelperError("HELPER_ERROR", `Computer Use kept requesting approval for ${method}; giving up`, { helperMethod: method });
	}

	listApps(): Promise<HelperApp[]> {
		return this.enqueue(async () => await this.requestWithApproval("list_apps", {}) as HelperApp[]);
	}

	listWindows(): Promise<HelperWindow[]> {
		return this.enqueue(async () => await this.requestWithApproval("list_windows", {}) as HelperWindow[]);
	}

	getWindow(input: { id: number; app?: string }): Promise<HelperWindow> {
		return this.enqueue(async () => await this.requestWithApproval("get_window", input) as HelperWindow);
	}

	getWindowState(input: { window: HelperWindow; include_screenshot?: boolean; include_text?: boolean }): Promise<HelperWindowState> {
		return this.enqueue(async () => await this.requestWithApproval("get_window_state", input) as HelperWindowState);
	}

	activateWindow(input: { window: HelperWindow }): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("activate_window", input); });
	}

	launchApp(input: { app: string }): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("launch_app", input); });
	}

	click(input: Record<string, unknown>): Promise<void> {
		const window = input.window as HelperWindow | undefined;
		if (!window) throw new HelperError("HELPER_ERROR", "click requires a window");
		const base = {
			window,
			click_count: typeof input.click_count === "number" ? input.click_count : 1,
			mouse_button: typeof input.mouse_button === "string" ? input.mouse_button : "left",
		};
		if (input.element_index !== undefined && input.element_index !== null) {
			return this.enqueue(async () => {
				await this.requestWithApproval("click_element", { ...base, element_index: input.element_index });
			});
		}
		const params: Record<string, unknown> = { ...base, x: input.x, y: input.y };
		if (input.screenshotId !== undefined) params.screenshotId = input.screenshotId;
		return this.enqueue(async () => { await this.requestWithApproval("click", params); });
	}

	pressKey(input: { window: HelperWindow; key: string }): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("press_key", input); });
	}

	typeText(input: { window: HelperWindow; text: string }): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("type_text", input); });
	}

	scroll(input: Record<string, unknown>): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("scroll", input); });
	}

	setValue(input: { window: HelperWindow; element_index: number; value: string }): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("set_value", input); });
	}

	drag(input: Record<string, unknown>): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("drag", input); });
	}

	performSecondaryAction(input: { window: HelperWindow; element_index: number; action: string }): Promise<void> {
		return this.enqueue(async () => { await this.requestWithApproval("perform_secondary_action", input); });
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.epoch += 1;
		const child = this.child;
		if (!child) {
			this.closing = true;
			return;
		}
		try {
			await Promise.race([
				this.sendRaw("close", {}).catch(() => undefined),
				new Promise((resolve) => setTimeout(resolve, 5_000)),
			]);
		} catch {
			// Fall through to process cleanup.
		}
		this.closing = true;
		this.failAll(new HelperError("HELPER_EXITED", "Computer Use helper closed"), false, child);
		try { child.stdin.end(); } catch { /* ignore */ }
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve();
			const timer = setTimeout(() => resolve(), 2_000);
			child.once("exit", () => { clearTimeout(timer); resolve(); });
		});
		if (child.exitCode === null && child.signalCode === null) this.killTree(child);
		if (this.child === child) this.child = null;
	}

	/** Kill the current helper and reject in-flight requests, but allow a later request to start a new helper. */
	abort(reason = "Computer Use request aborted"): void {
		this.epoch += 1;
		const child = this.child;
		const error = new HelperError("HELPER_EXITED", reason);
		this.failAll(error, false, child ?? undefined);
		if (child) this.killTree(child);
		if (this.child === child) this.child = null;
	}

	private killTree(child = this.child): void {
		if (!child?.pid) return;
		try {
			spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
				timeout: 10_000,
			});
		} catch {
			try { child.kill(); } catch { /* ignore */ }
		}
	}
}
