import path from "node:path";
import type {
	HelperAccessibilityState,
	HelperApp,
	HelperClient,
	HelperScreenshot,
	HelperWindow,
	HelperWindowState,
} from "./helper-client.ts";
import { HelperError } from "./errors.ts";

export interface SkyOptions {
	helper: HelperClient;
	onImage?: (dataUrl: string) => void;
	maxScreenshotBytes?: number;
	maxTextBytes?: number;
	maxScreenshots?: number;
}

const MOUSE_BUTTONS = new Set(["left", "right", "middle", "l", "r", "m"]);
const BLOCKED_KEY_PARTS = new Set([
	"super_l", "super_r", "meta_l", "meta_r", "win", "win_l", "win_r",
	"windows", "os_l", "os_r",
]);
const BLOCKED_CHORDS = new Set([
	"control_l+alt_l+delete",
	"ctrl+alt+del",
	"control_l+alt_l+del",
	"alt_l+f4",
	"alt+f4",
	"control_l+shift_l+escape",
	"ctrl+shift+escape",
	"control_l+escape",
	"ctrl+escape",
	"control_l+shift_l+enter",
	"ctrl+shift+enter",
	"alt_l+tab",
	"alt+tab",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInteger(value: unknown, field: string, minimum = 0): number {
	const number = typeof value === "string" && value.trim() ? Number(value) : value;
	if (typeof number !== "number" || !Number.isInteger(number) || number < minimum) {
		throw new TypeError(`${field} must be an integer >= ${minimum}`);
	}
	return number;
}

function toFinite(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${field} must be a finite number`);
	}
	return Math.round(value);
}

function toText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
	return value;
}

export function toWindow(value: unknown): HelperWindow {
	if (!isRecord(value)) throw new TypeError("window must be an object");
	const app = value.app;
	if (typeof app !== "string" || !app.trim()) throw new TypeError("window.app must be a non-empty string");
	const id = toInteger(value.id, "window.id", 0);
	const window: HelperWindow = { app, id };
	if (typeof value.title === "string" && value.title) window.title = value.title;
	return window;
}

function toScreenshot(value: unknown, maxBytes: number): HelperScreenshot {
	if (!isRecord(value)) throw new HelperError("HELPER_ERROR", "helper returned an invalid screenshot");
	const url = value.url;
	if (typeof url !== "string" || !url.startsWith("data:image/")) {
		throw new HelperError("HELPER_ERROR", "helper returned a screenshot without an image data URL");
	}
	const comma = url.indexOf(",");
	const base64 = comma >= 0 ? url.slice(comma + 1) : "";
	const approximateBytes = Math.floor((base64.length * 3) / 4);
	const screenshot: HelperScreenshot = {
		id: typeof value.id === "string" && value.id ? value.id : "screenshot-0",
		zIndex: typeof value.zIndex === "number" && Number.isFinite(value.zIndex) ? value.zIndex : 0,
		url: approximateBytes <= maxBytes ? url : "",
	};
	if (!screenshot.url) screenshot.urlOmitted = "screenshot exceeds maxScreenshotBytes";
	if (typeof value.originX === "number" && Number.isFinite(value.originX)) screenshot.originX = value.originX;
	if (typeof value.originY === "number" && Number.isFinite(value.originY)) screenshot.originY = value.originY;
	if (typeof value.width === "number" && Number.isFinite(value.width)) screenshot.width = value.width;
	if (typeof value.height === "number" && Number.isFinite(value.height)) screenshot.height = value.height;
	return screenshot;
}

function truncateText(value: string | undefined, maxBytes: number): string | undefined {
	if (!value) return value;
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const buffer = Buffer.from(value, "utf8").subarray(0, maxBytes);
	const text = buffer.toString("utf8").replace(/�+$/, "");
	return `${text}\n...[truncated by codex-computer-use-mcp-win]`;
}

function toAccessibility(value: unknown, maxTextBytes: number): HelperAccessibilityState | null {
	if (value === null || value === undefined) return null;
	if (!isRecord(value)) throw new HelperError("HELPER_ERROR", "helper returned invalid accessibility state");
	if (typeof value.tree !== "string") throw new HelperError("HELPER_ERROR", "helper returned accessibility state without a tree");
	const state: HelperAccessibilityState = { tree: truncateText(value.tree, maxTextBytes) ?? "" };
	if (typeof value.focused_element === "string") state.focused_element = truncateText(value.focused_element, maxTextBytes);
	if (typeof value.selected_text === "string") state.selected_text = truncateText(value.selected_text, maxTextBytes);
	if (Array.isArray(value.selected_elements) && value.selected_elements.every((item) => typeof item === "string")) {
		state.selected_elements = value.selected_elements.map((item) => truncateText(item, maxTextBytes) ?? "");
	}
	if (typeof value.document_text === "string") state.document_text = truncateText(value.document_text, maxTextBytes);
	return state;
}

function assertSafeKey(key: string): void {
	if (/[\u0000-\u001f\u007f]/.test(key)) throw new TypeError("key contains control characters");
	const normalized = key.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
	if (normalized.length === 0) throw new TypeError("key is required");
	if (normalized.some((part) => BLOCKED_KEY_PARTS.has(part))) {
		throw new HelperError("HELPER_ERROR", "The Windows/Super key is blocked by this server's safety policy");
	}
	if (BLOCKED_CHORDS.has(normalized.join("+"))) {
		throw new HelperError("HELPER_ERROR", "That system-level key chord is blocked by this server's safety policy");
	}
}

function assertLaunchTarget(app: string): void {
	let value = app.trim();
	if (/^process:/i.test(value)) value = value.slice("process:".length).trim();
	if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1).trim();
	if (!value) throw new TypeError("app is required");
	const lower = value.toLowerCase();
	if (/^(?:https?|file|ms-|shell|javascript|vbscript):/i.test(value)) {
		throw new TypeError("launch_app does not accept URLs or shell/URI targets");
	}
	if (/\.(?:lnk|url|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|reg|scr|com|pif|hta)$/i.test(lower)) {
		throw new TypeError("launch_app accepts an app id or an absolute .exe path; scripts, shortcuts, installers, and documents are blocked");
	}
	if (/[\\/]/.test(value)) {
		if (/^[\\/]{2}/.test(value)) throw new TypeError("launch_app does not accept UNC or device paths");
		if (!lower.endsWith(".exe") || !path.win32.isAbsolute(value)) {
			throw new TypeError("launch_app path targets must be absolute .exe files");
		}
	}
}

export class Sky {
	readonly target = "windows" as const;
	private readonly helper: HelperClient;
	private readonly onImage?: (dataUrl: string) => void;
	private readonly maxScreenshotBytes: number;
	private readonly maxTextBytes: number;
	private readonly maxScreenshots: number;

	constructor(options: SkyOptions) {
		this.helper = options.helper;
		this.onImage = options.onImage;
		this.maxScreenshotBytes = options.maxScreenshotBytes ?? 8 * 1024 * 1024;
		this.maxTextBytes = options.maxTextBytes ?? 2 * 1024 * 1024;
		this.maxScreenshots = options.maxScreenshots ?? 8;
	}

	setImageSink(sink: ((dataUrl: string) => void) | undefined): void {
		this.imageSink = sink;
	}

	private imageSink?: (dataUrl: string) => void;

	private emitImage(url: string): void {
		if (!url) return;
		const sink = this.imageSink ?? this.onImage;
		sink?.(url);
	}

	async list_apps(): Promise<HelperApp[]> {
		const raw = await this.helper.listApps();
		if (!Array.isArray(raw)) throw new HelperError("HELPER_ERROR", "helper returned invalid list_apps output");
		const apps: HelperApp[] = [];
		for (const item of raw) {
			if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
			const windows = Array.isArray(item.windows)
				? item.windows.flatMap((window) => {
					try { return [toWindow(window)]; } catch { return []; }
				})
				: [];
			const app: HelperApp = { id: item.id, windows };
			if (typeof item.displayName === "string") app.displayName = item.displayName;
			if (typeof item.lastUsedDate === "string") app.lastUsedDate = item.lastUsedDate;
			if (typeof item.useCount === "number" && Number.isFinite(item.useCount)) app.useCount = item.useCount;
			if (typeof item.isRunning === "boolean") app.isRunning = item.isRunning;
			apps.push(app);
		}
		return apps;
	}

	async list_windows(): Promise<HelperWindow[]> {
		const raw = await this.helper.listWindows();
		if (!Array.isArray(raw)) throw new HelperError("HELPER_ERROR", "helper returned invalid list_windows output");
		return raw.flatMap((window) => {
			try { return [toWindow(window)]; } catch { return []; }
		});
	}

	async get_window(input: { id: number | string; app?: string }): Promise<HelperWindow> {
		if (!isRecord(input)) throw new TypeError("get_window input must be an object");
		const id = toInteger(input.id, "id", 0);
		const app = typeof input.app === "string" && input.app.trim() ? input.app : undefined;
		return toWindow(await this.helper.getWindow(app ? { id, app } : { id }));
	}

	async get_window_state(input: {
		window: unknown;
		include_screenshot?: boolean;
		include_text?: boolean;
	}): Promise<HelperWindowState> {
		if (!isRecord(input)) throw new TypeError("get_window_state input must be an object");
		const window = toWindow(input.window);
		const includeScreenshot = input.include_screenshot ?? true;
		const includeText = input.include_text ?? false;
		if (typeof includeScreenshot !== "boolean" || typeof includeText !== "boolean") {
			throw new TypeError("include_screenshot and include_text must be booleans");
		}
		if (!includeScreenshot && !includeText) {
			throw new TypeError("get_window_state must request include_text, include_screenshot, or both");
		}
		const raw = await this.helper.getWindowState({ window, include_screenshot: includeScreenshot, include_text: includeText });
		if (!isRecord(raw)) throw new HelperError("HELPER_ERROR", "helper returned invalid window state");
		const resultWindow = toWindow(raw.window ?? window);
		// Validate the whole batch before emitting anything: a malformed later
		// screenshot must not leave earlier images attached to a failed call.
		const screenshots = Array.isArray(raw.screenshots)
			? raw.screenshots.slice(0, this.maxScreenshots).map((screenshot) => toScreenshot(screenshot, this.maxScreenshotBytes))
			: [];
		for (const screenshot of screenshots) this.emitImage(screenshot.url);
		return {
			window: resultWindow,
			screenshots,
			accessibility: toAccessibility(raw.accessibility, this.maxTextBytes),
		};
	}

	async activate_window(input: { window: unknown }): Promise<void> {
		const window = toWindow(input?.window);
		await this.helper.activateWindow({ window });
	}

	async launch_app(input: { app: string }): Promise<void> {
		if (!isRecord(input)) throw new TypeError("launch_app input must be an object");
		const app = toText(input.app, "app");
		assertLaunchTarget(app);
		await this.helper.launchApp({ app });
	}

	async click(input: Record<string, unknown>): Promise<void> {
		const window = toWindow(input.window);
		const clickCount = input.click_count === undefined ? 1 : toInteger(input.click_count, "click_count", 1);
		const mouseButton = input.mouse_button === undefined ? "left" : String(input.mouse_button).toLowerCase();
		if (!MOUSE_BUTTONS.has(mouseButton)) throw new TypeError(`mouse_button must be one of ${[...MOUSE_BUTTONS].join(", ")}`);
		if (input.element_index !== undefined && input.element_index !== null) {
			const elementIndex = toInteger(input.element_index, "element_index", 0);
			await this.helper.click({ window, element_index: elementIndex, click_count: clickCount, mouse_button: mouseButton });
			return;
		}
		if (input.x === undefined || input.y === undefined) {
			throw new TypeError("click requires either element_index or finite x and y coordinates");
		}
		const x = toFinite(input.x, "x");
		const y = toFinite(input.y, "y");
		const params: Record<string, unknown> = { window, x, y, click_count: clickCount, mouse_button: mouseButton };
		if (typeof input.screenshotId === "string") params.screenshotId = input.screenshotId;
		await this.helper.click(params);
	}

	async press_key(input: { window: unknown; key: string }): Promise<void> {
		if (!isRecord(input)) throw new TypeError("press_key input must be an object");
		const window = toWindow(input.window);
		const key = toText(input.key, "key");
		assertSafeKey(key);
		await this.helper.pressKey({ window, key });
	}

	async type_text(input: { window: unknown; text: string }): Promise<void> {
		if (!isRecord(input)) throw new TypeError("type_text input must be an object");
		const window = toWindow(input.window);
		if (typeof input.text !== "string") throw new TypeError("text is required");
		if (input.text.length > 100_000) throw new TypeError("text is too long (maximum 100000 characters per call)");
		await this.helper.typeText({ window, text: input.text });
	}

	async scroll(input: Record<string, unknown>): Promise<void> {
		if (!isRecord(input)) throw new TypeError("scroll input must be an object");
		const window = toWindow(input.window);
		const params: Record<string, unknown> = {
			window,
			x: toFinite(input.x, "x"),
			y: toFinite(input.y, "y"),
			scrollX: toFinite(input.scrollX, "scrollX"),
			scrollY: toFinite(input.scrollY, "scrollY"),
		};
		if (typeof input.screenshotId === "string") params.screenshotId = input.screenshotId;
		await this.helper.scroll(params);
	}

	async set_value(input: { window: unknown; element_index: number; value: string }): Promise<void> {
		if (!isRecord(input)) throw new TypeError("set_value input must be an object");
		const window = toWindow(input.window);
		const elementIndex = toInteger(input.element_index, "element_index", 0);
		if (typeof input.value !== "string") throw new TypeError("value is required");
		await this.helper.setValue({ window, element_index: elementIndex, value: input.value });
	}

	async drag(input: Record<string, unknown>): Promise<void> {
		if (!isRecord(input)) throw new TypeError("drag input must be an object");
		const window = toWindow(input.window);
		const params: Record<string, unknown> = {
			window,
			from_x: toFinite(input.from_x, "from_x"),
			from_y: toFinite(input.from_y, "from_y"),
			to_x: toFinite(input.to_x, "to_x"),
			to_y: toFinite(input.to_y, "to_y"),
		};
		if (typeof input.screenshotId === "string") params.screenshotId = input.screenshotId;
		await this.helper.drag(params);
	}

	async perform_secondary_action(input: { window: unknown; element_index: number; action: string }): Promise<void> {
		if (!isRecord(input)) throw new TypeError("perform_secondary_action input must be an object");
		const window = toWindow(input.window);
		const elementIndex = toInteger(input.element_index, "element_index", 0);
		const action = toText(input.action, "action");
		await this.helper.performSecondaryAction({ window, element_index: elementIndex, action });
	}

	async close(): Promise<void> {
		await this.helper.close();
	}

	abort(reason?: string): void {
		this.helper.abort(reason);
	}
}
