import crypto from "node:crypto";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ApprovalController, type HelperApprovalRequest } from "./approval.ts";
import { appendAudit, type AuditRecord } from "./audit.ts";
import { configPath, defaultStateRoot, loadConfig, type AppConfig } from "./config.ts";
import { discoverInstallation, type Installation } from "./discovery.ts";
import { CuaError, errorMessage } from "./errors.ts";
import { HelperClient } from "./helper-client.ts";
import { JsKernel, type JsRunResult } from "./js-kernel.ts";
import type { ApprovalDecision } from "./approval.ts";
import { Sky } from "./sky.ts";
import { CUA_REPL_TOOLS, type CuaReplTool, type JsonObject } from "./tools.ts";
import { PACKAGE_VERSION } from "./version.ts";

export type ContentBlock = {
	type: "text";
	text: string;
} | {
	type: "image";
	data: string;
	mimeType: string;
};

export interface SessionResponse {
	isError: boolean;
	content: ContentBlock[];
	structuredContent?: Record<string, unknown>;
}

export interface SessionOptions {
	stateRoot?: string;
	onElicitation?: (request: HelperApprovalRequest, options?: RequestOptions) => Promise<ApprovalDecision>;
	logger?: (message: string) => void;
}

interface StatusShape {
	route: "cua_repl";
	platform: "win32";
	serverVersion: string;
	stateRoot: string;
	configPath: string;
	permissionMode: "helper-approval";
	approval: AppConfig["approval"];
	tools: CuaReplTool[];
	ready: boolean;
	error: string | null;
	helperRunning: boolean;
	helperPid: number | null;
	helperPath: string | null;
	helperSignature: Installation["helperSignature"] | null;
	codexPath: string | null;
	codexSignature: Installation["codexSignature"] | null;
	codexHome: string | null;
	configTomlPath: string | null;
	chatGptAppPath: string | null;
	warnings: string[];
	jsRunning: boolean;
	jsError: string | null;
}

function imageBlock(dataUrl: string): ContentBlock | undefined {
	const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(dataUrl);
	if (!match) return undefined;
	return { type: "image", data: match[2], mimeType: match[1] };
}

function outputBytes(result: JsRunResult): number {
	let bytes = 0;
	for (const text of result.output.text) bytes += Buffer.byteLength(text, "utf8");
	for (const image of result.output.images) bytes += Math.floor(image.length * 0.75);
	return bytes;
}

function errorCode(error: unknown): string | null {
	return error instanceof CuaError ? error.code : null;
}

export class ComputerUseSession {
	private readonly stateRoot: string;
	private readonly onElicitation?: SessionOptions["onElicitation"];
	private readonly logger: (message: string) => void;
	private config: AppConfig | null = null;
	private configError: string | null = null;
	private installation: Installation | null = null;
	private discoveryError: string | null = null;
	private discoveryErrorAt = 0;
	private discoveryPromise: Promise<Installation | null> | null = null;
	private approval: ApprovalController | null = null;
	private helper: HelperClient | null = null;
	private sky: Sky | null = null;
	private kernel: JsKernel | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private activeRuns = 0;
	private closed = false;

	constructor(options: SessionOptions = {}) {
		this.stateRoot = options.stateRoot ?? defaultStateRoot();
		this.onElicitation = options.onElicitation;
		this.logger = options.logger ?? ((message) => console.error(message));
	}

	private log(message: string): void {
		this.logger(`[computer-use] ${message}`);
	}

	private async ensureConfig(): Promise<AppConfig> {
		if (this.config) return this.config;
		if (this.configError) throw new CuaError("CONFIG_ERROR", this.configError);
		try {
			this.config = await loadConfig(this.stateRoot);
			this.approval = ApprovalController.fromConfig(this.config, {
				elicit: this.onElicitation,
				label: (request) => request.displayName || request.app,
			});
			return this.config;
		} catch (error) {
			this.configError = errorMessage(error);
			throw error;
		}
	}

	async ready(): Promise<Installation> {
		if (this.installation) return this.installation;
		if (this.discoveryError && Date.now() - this.discoveryErrorAt < 5_000) {
			throw new CuaError("DISCOVERY_FAILED", this.discoveryError);
		}
		if (!this.discoveryPromise) {
			this.discoveryPromise = (async () => {
				try {
					const config = await this.ensureConfig();
					const installation = await discoverInstallation(config, {});
					this.installation = installation;
					this.discoveryError = null;
					this.discoveryErrorAt = 0;
					return installation;
				} catch (error) {
					this.discoveryError = errorMessage(error);
					this.discoveryErrorAt = Date.now();
					this.discoveryPromise = null;
					return null;
				}
			})();
		}
		const pending = this.discoveryPromise;
		const installation = await pending;
		if (!installation) throw new CuaError("DISCOVERY_FAILED", this.discoveryError ?? "Computer Use discovery failed");
		return installation;
	}

	private async ensureRuntime(): Promise<{ helper: HelperClient; sky: Sky; kernel: JsKernel; config: AppConfig }> {
		const installation = await this.ready();
		const config = await this.ensureConfig();
		if (!this.approval) {
			this.approval = ApprovalController.fromConfig(config, { elicit: this.onElicitation });
		}
		if (!this.helper) {
			this.helper = new HelperClient({
				helperPath: installation.helperPath,
				codexPath: installation.codexPath,
				codexHome: installation.codexHome,
				timeoutMs: config.helperTimeoutMs,
				approval: this.approval,
				logger: this.logger,
			});
		}
		if (!this.sky) {
			this.sky = new Sky({
				helper: this.helper,
				maxScreenshotBytes: config.maxScreenshotBytes,
				maxTextBytes: config.maxTextBytes,
			});
		}
		if (!this.kernel) {
			this.kernel = new JsKernel({
				sky: this.sky,
				timeoutMs: 30_000,
				maxTextBytes: config.maxTextBytes,
				maxImageBytes: config.maxScreenshotBytes,
				logger: this.logger,
			});
		}
		return { helper: this.helper, sky: this.sky, kernel: this.kernel, config };
	}

	private touchIdle(config: AppConfig): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.activeRuns > 0 || this.closed) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			this.log("session idle; closing the helper and resetting the JavaScript session");
			void this.kernel?.reset().catch(() => undefined);
			this.sky?.abort("Computer Use session idle timeout");
		}, config.sessionIdleMs);
		this.idleTimer.unref?.();
	}

	private async audit(record: Omit<AuditRecord, "schemaVersion" | "timestamp">): Promise<void> {
		const config = this.config;
		if (!config?.audit) return;
		try {
			await appendAudit(this.stateRoot, {
				schemaVersion: 1,
				timestamp: new Date().toISOString(),
				...record,
			});
		} catch (error) {
			this.log(`audit append failed: ${errorMessage(error)}`);
		}
	}

	async execute(tool: CuaReplTool, args: JsonObject, options: { signal?: AbortSignal } = {}): Promise<SessionResponse> {
		const runId = crypto.randomUUID();
		const started = Date.now();
		if (this.closed) {
			return { isError: true, content: [{ type: "text", text: "Computer Use session is closed" }] };
		}
		let config: AppConfig;
		try {
			config = await this.ensureConfig();
		} catch (error) {
			return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
		}
		this.activeRuns += 1;
		this.touchIdle(config);
		try {
			return await this.executeWithConfig(tool, args, options, runId, started);
		} finally {
			this.activeRuns = Math.max(0, this.activeRuns - 1);
			this.touchIdle(config);
		}
	}

	private async executeWithConfig(
		tool: CuaReplTool,
		args: JsonObject,
		options: { signal?: AbortSignal },
		runId: string,
		started: number,
	): Promise<SessionResponse> {
		if (tool === "js_reset") {
			try {
				await this.kernel?.reset();
				await this.audit({
					runId,
					method: "js_reset",
					inputBytes: Buffer.byteLength(JSON.stringify(args), "utf8"),
					outputBytes: 0,
					outcome: "ok",
					durationMs: Date.now() - started,
					resultContentTypes: ["text"],
				});
				return { isError: false, content: [{ type: "text", text: "Computer Use JavaScript session reset." }] };
			} catch (error) {
				await this.audit({
					runId,
					method: "js_reset",
					inputBytes: 0,
					outputBytes: 0,
					outcome: "tool_error",
					durationMs: Date.now() - started,
					resultContentTypes: ["text"],
					errorCode: errorCode(error),
				});
				return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
			}
		}
		const code = args.code;
		if (typeof code !== "string" || !code.trim()) {
			await this.audit({
				runId,
				method: "invalid_request",
				inputBytes: Buffer.byteLength(JSON.stringify(args), "utf8"),
				outputBytes: 0,
				outcome: "input_rejected",
				durationMs: Date.now() - started,
				resultContentTypes: [],
				errorCode: "JS_ERROR",
			});
			return { isError: true, content: [{ type: "text", text: "js requires a non-empty `code` string" }] };
		}
		const timeoutArg = args.timeout_ms;
		const timeoutMs = typeof timeoutArg === "number" && Number.isFinite(timeoutArg) ? timeoutArg : 30_000;
		let runtime;
		try {
			runtime = await this.ensureRuntime();
		} catch (error) {
			await this.audit({
				runId,
				method: "js",
				inputBytes: Buffer.byteLength(code, "utf8"),
				outputBytes: 0,
				outcome: "helper_error",
				durationMs: Date.now() - started,
				resultContentTypes: ["text"],
				errorCode: errorCode(error),
			});
			return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
		}
		const result = await runtime.kernel.run(code, timeoutMs, options.signal);
		const content: ContentBlock[] = [];
		for (const text of result.output.text) {
			if (text) content.push({ type: "text", text });
		}
		for (const image of result.output.images) {
			const block = imageBlock(image);
			if (block) content.push(block);
		}
		if (!result.ok) {
			if (content.length === 0) content.push({ type: "text", text: result.error ?? "Computer Use JavaScript execution failed" });
			else content.push({ type: "text", text: `Computer Use error: ${result.error ?? "JavaScript execution failed"}` });
		} else if (content.length === 0) {
			content.push({ type: "text", text: "Completed." });
		}
		const outcome: AuditRecord["outcome"] = result.ok
			? "ok"
			: result.timedOut
				? "timeout"
				: result.aborted
					? "cancelled"
					: result.error?.includes("approval") || result.error?.includes("approved")
						? "approval_denied"
						: "tool_error";
		await this.audit({
			runId,
			method: "js",
			inputBytes: Buffer.byteLength(code, "utf8"),
			outputBytes: outputBytes(result),
			outcome,
			durationMs: Date.now() - started,
			helperVersion: this.installation?.helperSignature?.version || null,
			resultContentTypes: [...new Set(content.map((block) => block.type))].sort(),
			errorCode: result.ok ? null : result.timedOut ? "JS_TIMEOUT" : "JS_ERROR",
		});
		return {
			isError: !result.ok,
			content,
			structuredContent: {
				ok: result.ok,
				durationMs: result.durationMs,
				outputBytes: outputBytes(result),
				contentTypes: [...new Set(content.map((block) => block.type))].sort(),
			},
		};
	}

	async status(): Promise<StatusShape> {
		const base: StatusShape = {
			route: "cua_repl",
			platform: "win32",
			serverVersion: PACKAGE_VERSION,
			stateRoot: this.stateRoot,
			configPath: configPath(this.stateRoot),
			permissionMode: "helper-approval",
			approval: this.config?.approval ?? "auto",
			tools: [...CUA_REPL_TOOLS],
			ready: false,
			error: null,
			helperRunning: this.helper?.isRunning ?? false,
			helperPid: this.helper?.pid ?? null,
			helperPath: this.installation?.helperPath ?? null,
			helperSignature: this.installation?.helperSignature ?? null,
			codexPath: this.installation?.codexPath ?? null,
			codexSignature: this.installation?.codexSignature ?? null,
			codexHome: this.installation?.codexHome ?? null,
			configTomlPath: this.installation?.configTomlPath ?? null,
			chatGptAppPath: this.installation?.chatGptAppPath ?? null,
			warnings: this.installation?.warnings ?? [],
			jsRunning: this.kernel?.isRunning ?? false,
			jsError: this.kernel?.error ?? null,
		};
		try {
			await this.ensureConfig();
			base.approval = this.config?.approval ?? "auto";
			const installation = await this.ready();
			base.ready = true;
			base.helperPath = installation.helperPath;
			base.helperSignature = installation.helperSignature ?? null;
			base.codexPath = installation.codexPath;
			base.codexSignature = installation.codexSignature ?? null;
			base.codexHome = installation.codexHome;
			base.configTomlPath = installation.configTomlPath;
			base.chatGptAppPath = installation.chatGptAppPath ?? null;
			base.warnings = installation.warnings;
			base.helperRunning = this.helper?.isRunning ?? false;
			base.helperPid = this.helper?.pid ?? null;
		} catch (error) {
			base.ready = false;
			base.error = errorMessage(error);
			if (this.configError) base.error = this.configError;
		}
		if (base.approval === "auto") {
			base.warnings.push("approval is auto: any app that is not denied can be controlled without a prompt");
		}
		return base;
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		await this.kernel?.close().catch(() => undefined);
		await this.sky?.close().catch(() => undefined);
		this.helper = null;
		this.sky = null;
		this.kernel = null;
	}
}
