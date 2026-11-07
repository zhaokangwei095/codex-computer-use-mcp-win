import { AsyncLocalStorage } from "node:async_hooks";
import { parentPort, workerData } from "node:worker_threads";
import util from "node:util";
import vm from "node:vm";
import { parse } from "acorn";

// These names exist only inside the vm context. They are installed on the
// context object before installGlobals runs, and captured by closures.
declare const __rpc: (method: string, argsJson: string) => Promise<string>;
declare const __write: (text: string) => void;
declare const __emitImage: (json: string) => void;
declare const __inspect: (value: unknown) => string;
declare const __setTimeout: (callback: () => void, ms: number) => number;
declare const __clearTimeout: (id: number) => void;
declare const __setInterval: (callback: () => void, ms: number) => number;
declare const __clearInterval: (id: number) => void;
declare const __cwd: string;
declare const __homeDir: string;
declare const __tmpDir: string;

export interface WorkerData {
	cwd: string;
	homeDir: string;
	tmpDir: string;
}

type MainMessage =
	| { type: "run"; id: number; code: string }
	| { type: "reset" }
	| { type: "rpc-result"; id: number; ok: boolean; result?: string; error?: string };

interface PendingRpc {
	resolve: (value: string) => void;
	/** Reject with a primitive string only. Host-realm objects are an escape vector. */
	reject: (reason: string) => void;
}

const port = parentPort;
if (!port) throw new Error("js-worker must run as a worker thread");

const data = workerData as WorkerData;
let context: vm.Context;
let pendingRpc = new Map<number, PendingRpc>();
let nextRpcId = 1;
let nextTimerId = 1;
let timers = new Map<number, NodeJS.Timeout>();
let running = false;
let generation = 0;
// Output, timers, and images inherit the run that created them, even when they
// fire after that run returned. The parent drops messages whose run is no longer
// active, so a late write can never land in the next tool result.
const runContext = new AsyncLocalStorage<number>();

function post(message: unknown): void {
	port!.postMessage(message);
}

function safeInspect(value: unknown): string {
	try {
		if (util.types.isNativeError(value)) {
			const record = value as { name?: unknown; message?: unknown };
			const name = typeof record.name === "string" ? record.name : "Error";
			const message = typeof record.message === "string" ? record.message : "";
			return `${name}: ${message}`;
		}
		return util.inspect(value, {
			depth: 4,
			maxArrayLength: 100,
			maxStringLength: 20_000,
			breakLength: 120,
			compact: true,
			customInspect: false,
			getters: false,
			showProxy: false,
		});
	} catch (error) {
		return `[uninspectable: ${error instanceof Error ? error.message : String(error)}]`;
	}
}

function formatError(error: unknown): string {
	try {
		if (util.types.isNativeError(error)) {
			const record = error as { name?: unknown; message?: unknown; code?: unknown };
			const name = typeof record.name === "string" && record.name ? record.name : "Error";
			const message = typeof record.message === "string" ? record.message : "";
			const code = typeof record.code === "string" ? record.code : "";
			if (
				code.startsWith("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") ||
				message.includes("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") ||
				/dynamic import callback/i.test(message)
			) {
				return "Error: import() is disabled in the Computer Use JavaScript runtime";
			}
			return message ? `${name}: ${message}` : name;
		}
		if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
			const record = error as { name?: unknown; message: string };
			const name = typeof record.name === "string" && record.name ? record.name : "Error";
			return `${name}: ${record.message}`;
		}
		return String(error);
	} catch {
		return "Error: unknown failure";
	}
}

function emitOutput(text: string): void {
	post({ type: "output", id: runContext.getStore(), text });
}

function clearTimers(): void {
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
}

function rejectPendingRpc(reason: string): void {
	for (const pending of pendingRpc.values()) pending.reject(reason);
	pendingRpc.clear();
}

function createContext(): void {
	generation += 1;
	clearTimers();
	rejectPendingRpc("Computer Use JavaScript session was reset");
	const sandbox: Record<string, unknown> = Object.create(null);
	sandbox.__rpc = (method: string, argsJson: string): Promise<string> => {
		const id = nextRpcId++;
		return new Promise<string>((resolve, reject) => {
			pendingRpc.set(id, { resolve, reject });
			post({ type: "rpc", id, method, argsJson });
		});
	};
	sandbox.__write = (text: string): void => {
		if (typeof text === "string" && text.length > 0) emitOutput(text);
	};
	sandbox.__emitImage = (json: string): void => {
		try {
			const parsed = JSON.parse(json) as { url?: unknown };
			if (typeof parsed.url === "string" && parsed.url.startsWith("data:image/")) {
				post({ type: "image", id: runContext.getStore(), dataUrl: parsed.url });
			}
		} catch {
			// Ignore malformed image requests from the sandbox.
		}
	};
	sandbox.__inspect = (value: unknown): string => safeInspect(value);
	sandbox.__setTimeout = (callback: () => void, ms: number): number => {
		const id = nextTimerId++;
		const timer = setTimeout(() => {
			timers.delete(id);
			try { callback(); } catch (error) { emitOutput(`Uncaught ${safeInspect(error)}`); }
		}, Math.max(0, Number(ms) || 0));
		timers.set(id, timer);
		return id;
	};
	sandbox.__clearTimeout = (id: number): void => {
		const timer = timers.get(id);
		if (timer) { clearTimeout(timer); timers.delete(id); }
	};
	sandbox.__setInterval = (callback: () => void, ms: number): number => {
		const id = nextTimerId++;
		const timer = setInterval(() => {
			try { callback(); } catch (error) { emitOutput(`Uncaught ${safeInspect(error)}`); }
		}, Math.max(1, Number(ms) || 1));
		timers.set(id, timer);
		return id;
	};
	sandbox.__clearInterval = (id: number): void => {
		const timer = timers.get(id);
		if (timer) { clearInterval(timer); timers.delete(id); }
	};
	sandbox.__cwd = data.cwd;
	sandbox.__homeDir = data.homeDir;
	sandbox.__tmpDir = data.tmpDir;
	context = vm.createContext(sandbox, {
		name: "cua-repl",
		codeGeneration: { strings: false, wasm: false },
	});
	try {
		vm.runInContext(`(${installGlobals.toString()})()`, context, { filename: "cua-repl-bootstrap.js" });
	} catch (error) {
		post({ type: "fatal", error: error instanceof Error ? error.stack ?? error.message : String(error) });
	}
}

/**
 * Runs inside the vm context. Keep this function self-contained: it may only
 * use standard ECMAScript intrinsics and the bridge globals installed by
 * createContext. Do not reference module-scope variables.
 */
function installGlobals(): void {
	// Capture the host bridge now. These names are deleted from globalThis
	// below, but local bindings keep the functions reachable from closures.
	const bridgeRpc = __rpc;
	const bridgeWrite = __write;
	const bridgeEmitImage = __emitImage;
	const bridgeInspect = __inspect;
	const bridgeSetTimeout = __setTimeout;
	const bridgeClearTimeout = __clearTimeout;
	const bridgeSetInterval = __setInterval;
	const bridgeClearInterval = __clearInterval;
	const bridgeCwd = __cwd;
	const bridgeHomeDir = __homeDir;
	const bridgeTmpDir = __tmpDir;

	// Keep V8 from invoking a sandbox-defined stack formatter with host
	// CallSite objects, and keep error formatting predictable.
	try {
		Object.defineProperty(Error, "prepareStackTrace", {
			value: undefined,
			writable: false,
			configurable: false,
		});
	} catch {
		// Ignore engines that do not allow redefining this property.
	}

	const rpc = (method: string, args: unknown): Promise<unknown> =>
		new Promise((resolve, reject) => {
			let argsJson: string;
			try {
				argsJson = JSON.stringify(args);
			} catch (error) {
				reject(new TypeError(`Arguments must be JSON-serializable: ${String(error)}`));
				return;
			}
			bridgeRpc(method, argsJson).then(
				(json) => {
					try { resolve(JSON.parse(json)); } catch (error) { reject(error); }
				},
				(reason) => {
					// The bridge rejects with a primitive string so a host-realm Error
					// cannot leak its constructor into the context. Rebuild the Error
					// with the context realm's own Error constructor.
					const message = typeof reason === "string" && reason.trim() ? reason : "Computer Use RPC failed";
					reject(new Error(message));
				},
			);
		});

	const inspect = (value: unknown): string => bridgeInspect(value);
	const write = (value: unknown): void => bridgeWrite(typeof value === "string" ? value : inspect(value));
	const defineGlobal = (name: string, value: unknown): void => {
		try {
			Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
		} catch {
			try { (globalThis as Record<string, unknown>)[name] = value; } catch { /* ignore */ }
		}
	};
	const setTimeout = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number =>
		bridgeSetTimeout(() => callback(...args), Number(ms) || 0);
	const clearTimeout = (id: number): void => bridgeClearTimeout(id);
	const setInterval = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): number =>
		bridgeSetInterval(() => callback(...args), Number(ms) || 1);
	const clearInterval = (id: number): void => bridgeClearInterval(id);
	defineGlobal("setTimeout", setTimeout);
	defineGlobal("clearTimeout", clearTimeout);
	defineGlobal("setInterval", setInterval);
	defineGlobal("clearInterval", clearInterval);
	const emitImage = (image: unknown): void => {
		let url: string | undefined;
		if (typeof image === "string") {
			url = image;
		} else if (image && typeof image === "object") {
			const record = image as Record<string, unknown>;
			if (typeof record.url === "string") url = record.url;
			else if (typeof record.data_url === "string") url = record.data_url;
			else if (typeof record.dataUrl === "string") url = record.dataUrl;
			else if (typeof record.data === "string") {
				const mimeType = typeof record.mimeType === "string" ? record.mimeType : typeof record.mime_type === "string" ? record.mime_type : "image/png";
				url = `data:${mimeType};base64,${record.data}`;
			}
		}
		if (!url || !url.startsWith("data:image/")) throw new TypeError("emitImage expects an image data URL or {data, mimeType}");
		bridgeEmitImage(JSON.stringify({ url }));
	};

	const scope = new Proxy(Object.create(null), {
		has: (_target, key) => key !== Symbol.unscopables,
		get: (target, key) => key in target ? target[key] : (globalThis as Record<PropertyKey, unknown>)[key],
		set: (target, key, value) => { target[key] = value; return true; },
		deleteProperty: (target, key) => { delete target[key]; return true; },
		getPrototypeOf: () => null,
	});
	defineGlobal("__scope", scope);
	const sky = Object.freeze({
		target: "windows",
		list_apps: (): Promise<unknown> => rpc("sky.list_apps", []),
		list_windows: (): Promise<unknown> => rpc("sky.list_windows", []),
		get_window: (input: unknown): Promise<unknown> => rpc("sky.get_window", [input]),
		get_window_state: (input: unknown): Promise<unknown> => rpc("sky.get_window_state", [input]),
		activate_window: (input: unknown): Promise<unknown> => rpc("sky.activate_window", [input]),
		launch_app: (input: unknown): Promise<unknown> => rpc("sky.launch_app", [input]),
		click: (input: unknown): Promise<unknown> => rpc("sky.click", [input]),
		press_key: (input: unknown): Promise<unknown> => rpc("sky.press_key", [input]),
		type_text: (input: unknown): Promise<unknown> => rpc("sky.type_text", [input]),
		scroll: (input: unknown): Promise<unknown> => rpc("sky.scroll", [input]),
		set_value: (input: unknown): Promise<unknown> => rpc("sky.set_value", [input]),
		drag: (input: unknown): Promise<unknown> => rpc("sky.drag", [input]),
		perform_secondary_action: (input: unknown): Promise<unknown> => rpc("sky.perform_secondary_action", [input]),
	});

	const formatArgs = (args: unknown[]): string => args.map((value) => typeof value === "string" ? value : inspect(value)).join(" ");
	const console = Object.freeze({
		log: (...args: unknown[]) => write(formatArgs(args)),
		info: (...args: unknown[]) => write(formatArgs(args)),
		warn: (...args: unknown[]) => write(`[warn] ${formatArgs(args)}`),
		error: (...args: unknown[]) => write(`[error] ${formatArgs(args)}`),
		debug: (...args: unknown[]) => write(formatArgs(args)),
		dir: (value: unknown) => write(inspect(value)),
		table: (value: unknown) => write(inspect(value)),
	});
	defineGlobal("console", console);

	const nodeRepl = Object.freeze({
		write,
		emitImage,
		cwd: bridgeCwd,
		homeDir: bridgeHomeDir,
		tmpDir: bridgeTmpDir,
		requestMeta: Object.freeze({}),
		env: Object.freeze({}),
	});
	defineGlobal("nodeRepl", nodeRepl);
	defineGlobal("sky", sky);
	defineGlobal("codex", Object.freeze({ emitImage }));

	const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), ms));
	const normalize = (value: unknown): string => String(value ?? "").trim().toLowerCase().replace(/^process:/, "").replace(/!app$/i, "");
	const basename = (value: string): string => {
		const index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
		return index >= 0 ? value.slice(index + 1) : value;
	};
	const identify = (app: Record<string, unknown>): string[] => {
		const id = normalize(app.id);
		const displayName = normalize(app.displayName);
		return [id, basename(id), basename(id).replace(/\.exe$/i, ""), displayName, displayName.replace(/\s+/g, "")].filter(Boolean);
	};
	const scoreApp = (app: Record<string, unknown>, query: string, requestWindowTitle?: string): number => {
		const wanted = normalize(query);
		const wantedBase = basename(wanted);
		const wantedNoExe = wantedBase.replace(/\.exe$/i, "");
		let score = 0;
		for (const candidate of identify(app)) {
			if (candidate === wanted || candidate === wantedBase || candidate === wantedNoExe) score = Math.max(score, 3);
			else if (candidate.includes(wanted) || candidate.includes(wantedBase) || candidate.includes(wantedNoExe)) score = Math.max(score, 2);
		}
		if (score > 0 && app.isRunning === true) score += 1;
		if (score > 0 && requestWindowTitle && Array.isArray(app.windows)) {
			const title = normalize(requestWindowTitle);
			if (app.windows.some((window) => window && typeof window === "object" && normalize((window as Record<string, unknown>).title).includes(title))) score += 1;
		}
		return score;
	};
	const pickApp = (apps: unknown, query: string, requestWindowTitle?: string): Record<string, unknown> | undefined => {
		if (!Array.isArray(apps)) return undefined;
		let best: { app: Record<string, unknown>; score: number } | undefined;
		for (const item of apps) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const app = item as Record<string, unknown>;
			const score = scoreApp(app, query, requestWindowTitle);
			if (score <= 0) continue;
			if (!best || score > best.score) best = { app, score };
		}
		return best?.app;
	};
	const pickWindow = (app: Record<string, unknown>, wantedTitle?: string): Record<string, unknown> | undefined => {
		const windows = Array.isArray(app.windows) ? app.windows.filter((window): window is Record<string, unknown> => Boolean(window) && typeof window === "object" && !Array.isArray(window)) : [];
		if (!wantedTitle) return windows[0];
		const wanted = normalize(wantedTitle);
		return windows.find((window) => normalize(window.title).includes(wanted)) ?? windows[0];
	};

	const makeApp = (appRecord: Record<string, unknown>, windowRecord: Record<string, unknown>): Record<string, unknown> => {
		let currentWindow = windowRecord;
		let lastScreenshot: Record<string, unknown> | undefined;
		const app = {
			app: appRecord,
			id: String(appRecord.id ?? ""),
			name: String(appRecord.displayName ?? appRecord.id ?? ""),
			get window() { return currentWindow; },
			async getAXState(options?: { screenshot?: boolean; disableDiff?: boolean }): Promise<Record<string, unknown>> {
				const includeScreenshot = options?.screenshot !== false;
				const state = await sky.get_window_state({ window: currentWindow, include_text: true, include_screenshot: includeScreenshot });
				if (state && typeof state === "object") {
					const record = state as Record<string, unknown>;
					if (record.window && typeof record.window === "object") currentWindow = record.window as Record<string, unknown>;
					if (Array.isArray(record.screenshots) && record.screenshots.length > 0 && record.screenshots[0] && typeof record.screenshots[0] === "object") {
						lastScreenshot = record.screenshots[0] as Record<string, unknown>;
					}
					const accessibility = record.accessibility && typeof record.accessibility === "object" ? record.accessibility as Record<string, unknown> : undefined;
					return {
						...record,
						text: typeof accessibility?.tree === "string" ? accessibility.tree : "",
						screenshot: Array.isArray(record.screenshots) && record.screenshots[0] && typeof record.screenshots[0] === "object"
							? (record.screenshots[0] as Record<string, unknown>).url ?? null
							: null,
					};
				}
				return {};
			},
			async click(target: unknown, options: { clickCount?: number; click_count?: number; mouseButton?: string; mouse_button?: string; screenshotId?: string } = {}): Promise<void> {
				const click_count = options.clickCount ?? options.click_count ?? 1;
				const mouse_button = options.mouseButton ?? options.mouse_button ?? "left";
				if (typeof target === "number" || (typeof target === "string" && /^\d+$/.test(target.trim()))) {
					await sky.click({ window: currentWindow, element_index: Number(target), click_count, mouse_button });
					return;
				}
				if (Array.isArray(target) && target.length >= 2) {
					await sky.click({ window: currentWindow, x: Number(target[0]), y: Number(target[1]), click_count, mouse_button, ...(options.screenshotId ? { screenshotId: options.screenshotId } : {}) });
					return;
				}
				if (target && typeof target === "object") {
					const record = target as Record<string, unknown>;
					if (record.element_index !== undefined) {
						await sky.click({ window: currentWindow, element_index: record.element_index, click_count, mouse_button });
						return;
					}
					if (record.x !== undefined && record.y !== undefined) {
						await sky.click({ window: currentWindow, x: record.x, y: record.y, click_count, mouse_button, ...(options.screenshotId ? { screenshotId: options.screenshotId } : {}) });
						return;
					}
				}
				throw new TypeError("click expects an element index, [x, y], or {x, y}");
			},
			async typeText(text: unknown): Promise<void> {
				await sky.type_text({ window: currentWindow, text: String(text) });
			},
			async pressKey(key: unknown): Promise<void> {
				await sky.press_key({ window: currentWindow, key: String(key) });
			},
			async scroll(input: unknown = "down", pages: unknown = 1): Promise<void> {
				if (input && typeof input === "object" && !Array.isArray(input)) {
					const record = input as Record<string, unknown>;
					await sky.scroll({ window: currentWindow, x: record.x ?? 200, y: record.y ?? 200, scrollX: record.scrollX ?? 0, scrollY: record.scrollY ?? 0, ...(record.screenshotId ? { screenshotId: record.screenshotId } : {}) });
					return;
				}
				const direction = normalize(input) || "down";
				const amount = Math.max(1, Number(pages) || 1) * 600;
				const width = typeof lastScreenshot?.width === "number" ? lastScreenshot.width : 400;
				const height = typeof lastScreenshot?.height === "number" ? lastScreenshot.height : 400;
				const x = Math.max(1, Math.floor(width / 2));
				const y = Math.max(1, Math.floor(height / 2));
				const scrollX = direction === "left" ? -amount : direction === "right" ? amount : 0;
				const scrollY = direction === "up" ? -amount : direction === "down" ? amount : 0;
				await sky.scroll({ window: currentWindow, x, y, scrollX, scrollY });
			},
			async setValue(index: unknown, value: unknown): Promise<void> {
				await sky.set_value({ window: currentWindow, element_index: Number(index), value: String(value) });
			},
			async performSecondaryAction(index: unknown, action: unknown): Promise<void> {
				await sky.perform_secondary_action({ window: currentWindow, element_index: Number(index), action: String(action) });
			},
			async drag(from: unknown, to: unknown): Promise<void> {
				const start = Array.isArray(from) ? from : from && typeof from === "object" ? [ (from as Record<string, unknown>).x, (from as Record<string, unknown>).y ] : [];
				const end = Array.isArray(to) ? to : to && typeof to === "object" ? [ (to as Record<string, unknown>).x, (to as Record<string, unknown>).y ] : [];
				if (start.length < 2 || end.length < 2) throw new TypeError("drag expects [x, y] start and end points");
				await sky.drag({ window: currentWindow, from_x: Number(start[0]), from_y: Number(start[1]), to_x: Number(end[0]), to_y: Number(end[1]) });
			},
			async activate(): Promise<void> {
				await sky.activate_window({ window: currentWindow });
			},
			async screenshot(): Promise<unknown> {
				const state = await app.getAXState({ screenshot: true });
				return state.screenshots ?? [];
			},
			async getWindows(): Promise<unknown> {
				const windows = await sky.list_windows();
				if (!Array.isArray(windows)) return [];
				return windows.filter((window) => window && typeof window === "object" && normalize((window as Record<string, unknown>).app) === normalize(currentWindow.app));
			},
		};
		return app;
	};

	const cua = Object.freeze({
		async getApp(name: unknown, options: { windowTitle?: string; timeoutMs?: number } = {}): Promise<unknown> {
			const query = String(name ?? "").trim();
			if (!query) throw new TypeError("getApp requires an app name, id, or executable path");
			let apps = await sky.list_apps();
			let app = pickApp(apps, query, options?.windowTitle);
			if (!app) {
				try { await sky.launch_app({ app: query }); } catch (error) {
					throw new Error(`Could not find or launch ${query}: ${error instanceof Error ? error.message : String(error)}`);
				}
				apps = await sky.list_apps();
				app = pickApp(apps, query, options?.windowTitle);
			}
			if (!app) throw new Error(`App not found: ${query}`);
			let window = pickWindow(app, options?.windowTitle);
			if (!window) {
				try { await sky.launch_app({ app: String(app.id) }); } catch { /* ignore; poll below */ }
				const deadline = Date.now() + Math.max(1_000, Math.min(30_000, Number(options?.timeoutMs) || 10_000));
				while (Date.now() < deadline) {
					await delay(250);
					apps = await sky.list_apps();
					const refreshed = pickApp(apps, query, options?.windowTitle);
					if (refreshed) {
						app = refreshed;
						window = pickWindow(app, options?.windowTitle);
						if (window) break;
					}
				}
			}
			if (!window) throw new Error(`${query} has no open windows. Open a window in the app, then retry.`);
			return makeApp(app, window);
		},
		async listApps(): Promise<unknown> {
			return sky.list_apps();
		},
		async listWindows(): Promise<unknown> {
			return sky.list_windows();
		},
		async listTabs(): Promise<unknown> {
			throw new Error("Browser tab control is not available in this Windows port. Use a browser automation MCP for tabs.");
		},
		async createBrowserTab(): Promise<unknown> {
			throw new Error("Browser tab control is not available in this Windows port. Use a browser automation MCP for tabs.");
		},
	});
	defineGlobal("cua", cua);

	// Remove the bridge names after the closures above have captured them.
	delete (globalThis as Record<string, unknown>).__rpc;
	delete (globalThis as Record<string, unknown>).__write;
	delete (globalThis as Record<string, unknown>).__emitImage;
	delete (globalThis as Record<string, unknown>).__inspect;
	delete (globalThis as Record<string, unknown>).__setTimeout;
	delete (globalThis as Record<string, unknown>).__clearTimeout;
	delete (globalThis as Record<string, unknown>).__setInterval;
	delete (globalThis as Record<string, unknown>).__clearInterval;
	delete (globalThis as Record<string, unknown>).__cwd;
	delete (globalThis as Record<string, unknown>).__homeDir;
	delete (globalThis as Record<string, unknown>).__tmpDir;
	delete (globalThis as Record<string, unknown>).SharedArrayBuffer;
	delete (globalThis as Record<string, unknown>).Atomics;
	delete (globalThis as Record<string, unknown>).WebAssembly;
}

function transform(code: string): string {
	const ast = parse(code, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
	});
	const statements: string[] = [];
	const body = ast.body;
	for (let index = 0; index < body.length; index += 1) {
		const node = body[index];
		if (node.type === "ImportDeclaration" || node.type.startsWith("Export")) {
			throw new SyntaxError("import/export is not available in the Computer Use JavaScript runtime. Use sky and cua instead.");
		}
		const isLast = index === body.length - 1;
		if (node.type === "VariableDeclaration") {
			for (let declarationIndex = 0; declarationIndex < node.declarations.length; declarationIndex += 1) {
				const declaration = node.declarations[declarationIndex];
				const init = declaration.init ? code.slice(declaration.init.start, declaration.init.end) : "undefined";
				const isLastDeclaration = declarationIndex === node.declarations.length - 1;
				if (declaration.id.type === "Identifier") {
					statements.push(`${declaration.id.name} = ${init};`);
					// Return the bound identifier, never the initializer again: evaluating
					// the initializer twice would duplicate clicks, launches, and captures.
					if (isLast && isLastDeclaration && declaration.init) {
						statements.push(`return (${declaration.id.name});`);
					}
				} else {
					const pattern = code.slice(declaration.id.start, declaration.id.end);
					if (isLast && isLastDeclaration && declaration.init) {
						statements.push(`return (${pattern} = ${init});`);
					} else {
						statements.push(`(${pattern} = ${init});`);
					}
				}
			}
			continue;
		}
		if (node.type === "FunctionDeclaration" && node.id) {
			statements.push(`${node.id.name} = ${code.slice(node.start, node.end)};`);
			continue;
		}
		if (node.type === "ClassDeclaration" && node.id) {
			statements.push(`${node.id.name} = ${code.slice(node.start, node.end)};`);
			continue;
		}
		if (isLast && node.type === "ExpressionStatement") {
			statements.push(`return (${code.slice(node.expression.start, node.expression.end)});`);
			continue;
		}
		statements.push(code.slice(node.start, node.end));
	}
	return `(async () => {\n  with (__scope) {\n${statements.map((statement) => `    ${statement}`).join("\n")}\n  }\n})()`;
}

async function handleRun(message: { id: number; code: string }): Promise<void> {
	if (running) {
		post({ type: "result", id: message.id, ok: false, error: "A Computer Use JavaScript execution is already running.", durationMs: 0 });
		return;
	}
	running = true;
	const started = Date.now();
	const runGeneration = generation;
	try {
		const wrapped = transform(message.code);
		const script = new vm.Script(wrapped, {
			filename: "cua-repl.js",
			importModuleDynamically: () => {
				throw new Error("import() is disabled in the Computer Use JavaScript runtime");
			},
		});
		await runContext.run(message.id, async () => {
			const value = script.runInContext(context, { timeout: 10 * 60 * 1000, breakOnSigint: false });
			const resolved = await Promise.resolve(value);
			if (generation !== runGeneration) {
				post({ type: "result", id: message.id, ok: false, error: "The Computer Use JavaScript session was reset during execution.", durationMs: Date.now() - started });
				return;
			}
			if (resolved !== undefined) emitOutput(safeInspect(resolved));
			post({ type: "result", id: message.id, ok: true, durationMs: Date.now() - started });
		});
	} catch (error) {
		post({ type: "result", id: message.id, ok: false, error: formatError(error), durationMs: Date.now() - started });
	} finally {
		running = false;
	}
}

createContext();

port.on("message", (message: MainMessage) => {
	if (message.type === "run") {
		void handleRun(message);
		return;
	}
	if (message.type === "reset") {
		createContext();
		return;
	}
	if (message.type === "rpc-result") {
		const pending = pendingRpc.get(message.id);
		if (!pending) return;
		pendingRpc.delete(message.id);
		if (message.ok) pending.resolve(message.result ?? "null");
		else pending.reject(message.error ?? "Computer Use RPC failed");
	}
});

port.postMessage({ type: "ready" });
