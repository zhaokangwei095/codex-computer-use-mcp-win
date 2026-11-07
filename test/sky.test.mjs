import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Sky } from "../dist/sky.js";

const APP = "process:C:\\Windows\\System32\\notepad.exe";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==";

class FakeHelper {
	constructor() {
		this.calls = [];
		this.windowState = {
			window: { app: APP, id: 101, title: "Untitled - Notepad" },
			screenshots: [{ id: "s1", zIndex: 0, url: PNG, originX: 0, originY: 0, width: 10, height: 10 }],
			accessibility: { tree: "- window\n  - button \"OK\"", selected_text: "OK" },
		};
	}

	async listApps() {
		return [{
			id: APP,
			displayName: "Notepad",
			windows: [{ app: APP, id: 101, title: "Untitled - Notepad" }],
			isRunning: true,
		}];
	}

	async listWindows() {
		return [
			{ app: APP, id: 101, title: "Untitled - Notepad" },
			{ id: 2 },
			{ app: "calc.exe", id: -1 },
			{ app: "calc.exe", id: 3 },
		];
	}

	async getWindow(input) {
		return { app: input.app ?? APP, id: input.id, title: "Untitled - Notepad" };
	}

	async getWindowState(input) {
		this.calls.push(["getWindowState", input]);
		return this.windowState;
	}

	async activateWindow(input) { this.calls.push(["activateWindow", input]); }
	async launchApp(input) { this.calls.push(["launchApp", input]); }
	async click(input) { this.calls.push(["click", input]); }
	async pressKey(input) { this.calls.push(["pressKey", input]); }
	async typeText(input) { this.calls.push(["typeText", input]); }
	async scroll(input) { this.calls.push(["scroll", input]); }
	async setValue(input) { this.calls.push(["setValue", input]); }
	async drag(input) { this.calls.push(["drag", input]); }
	async performSecondaryAction(input) { this.calls.push(["performSecondaryAction", input]); }
	async close() { this.calls.push(["close"]); }
	abort() { this.calls.push(["abort"]); }
}

function makeSky(options = {}) {
	const helper = new FakeHelper();
	const emitted = [];
	const sky = new Sky({ helper, ...options });
	sky.setImageSink((url) => emitted.push(url));
	return { helper, sky, emitted };
}

describe("Sky", () => {
	test("normalizes helper output and emits screenshots", async () => {
		const { sky, emitted } = makeSky();
		const apps = await sky.list_apps();
		assert.equal(apps.length, 1);
		assert.equal(apps[0].displayName, "Notepad");
		assert.equal(apps[0].windows[0].id, 101);
		const windows = await sky.list_windows();
		assert.equal(windows.length, 2);
		assert.deepEqual(windows[1], { app: "calc.exe", id: 3 });
		const state = await sky.get_window_state({
			window: { app: APP, id: 101 },
			include_screenshot: true,
			include_text: true,
		});
		assert.equal(state.screenshots.length, 1);
		assert.equal(state.accessibility.tree.includes("button"), true);
		assert.deepEqual(emitted, [PNG]);
	});

	test("omits screenshots over the size limit and caps screenshot count", async () => {
		const { helper, sky, emitted } = makeSky({ maxScreenshotBytes: 2 });
		const state = await sky.get_window_state({ window: { app: APP, id: 101 } });
		assert.equal(state.screenshots[0].url, "");
		assert.match(state.screenshots[0].urlOmitted, /maxScreenshotBytes/);
		assert.deepEqual(emitted, []);

		helper.windowState.screenshots = Array.from({ length: 5 }, (_, index) => ({
			id: `s${index}`, zIndex: index, url: PNG,
		}));
		const capped = makeSky({ maxScreenshots: 2 });
		capped.helper.windowState.screenshots = helper.windowState.screenshots;
		const cappedState = await capped.sky.get_window_state({ window: { app: APP, id: 101 } });
		assert.equal(cappedState.screenshots.length, 2);
		assert.equal(capped.emitted.length, 2);
	});

	test("validates every screenshot before emitting any of them", async () => {
		const { helper, sky, emitted } = makeSky();
		helper.windowState.screenshots = [
			{ id: "good", zIndex: 0, url: PNG },
			{ id: "bad", zIndex: 1, url: "not-an-image" },
		];
		await assert.rejects(
			() => sky.get_window_state({ window: { app: APP, id: 101 } }),
			/screenshot/,
		);
		assert.deepEqual(emitted, []);
	});

	test("requires at least one include flag", async () => {
		const { sky } = makeSky();
		await assert.rejects(
			() => sky.get_window_state({ window: { app: APP, id: 101 }, include_screenshot: false, include_text: false }),
			/at least one|must request/i,
		);
	});

	test("rejects system-level key chords but allows ordinary keys", async () => {
		const { helper, sky } = makeSky();
		const window = { app: APP, id: 101 };
		for (const key of ["Super_L", "Win+R", "Alt+F4", "Control_L+Alt_L+Delete", "Alt+Tab", "Ctrl+Shift+Enter"]) {
			await assert.rejects(() => sky.press_key({ window, key }), /blocked by this server's safety policy/);
		}
		await sky.press_key({ window, key: "Control_L+c" });
		await sky.press_key({ window, key: "Return" });
		assert.equal(helper.calls.filter(([name]) => name === "pressKey").length, 2);
		await assert.rejects(() => sky.press_key({ window, key: "Control_L+\u0000" }), /control characters/);
	});

	test("validates launch targets", async () => {
		const { helper, sky } = makeSky();
		await sky.launch_app({ app: "Notepad" });
		await sky.launch_app({ app: "C:\\Windows\\System32\\notepad.exe" });
		await sky.launch_app({ app: "process:C:\\Windows\\System32\\notepad.exe" });
		assert.equal(helper.calls.filter(([name]) => name === "launchApp").length, 3);
		for (const app of [
			"https://example.com",
			"shell:AppsFolder\\foo",
			"C:\\temp\\evil.bat",
			"C:\\temp\\evil.lnk",
			"\\\\server\\share\\app.exe",
			"..\\evil.exe",
		]) {
			await assert.rejects(() => sky.launch_app({ app }), /launch_app/);
		}
	});

	test("validates click, scroll, drag, and text inputs", async () => {
		const { helper, sky } = makeSky();
		const window = { app: APP, id: 101 };
		await sky.click({ window, element_index: 4, click_count: 2 });
		await sky.click({ window, x: 10, y: 20, mouse_button: "right" });
		assert.deepEqual(helper.calls.find(([name]) => name === "click")[1].element_index, 4);
		await assert.rejects(() => sky.click({ window }), /element_index or finite x and y/);
		await assert.rejects(() => sky.click({ window, x: 1, y: 2, mouse_button: "side" }), /mouse_button/);

		await sky.scroll({ window, x: 1, y: 2, scrollX: 0, scrollY: 100 });
		await assert.rejects(() => sky.scroll({ window, x: 1, y: 2, scrollX: 0 }), /scrollY/);
		await sky.drag({ window, from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
		await assert.rejects(() => sky.drag({ window, from_x: 1, from_y: 2, to_x: 3 }), /to_y/);
		await assert.rejects(() => sky.type_text({ window, text: "x".repeat(100_001) }), /too long/);
	});

	test("get_window accepts string ids and preserves app", async () => {
		const { sky } = makeSky();
		const window = await sky.get_window({ id: "101", app: APP });
		assert.equal(window.id, 101);
		assert.equal(window.app, APP);
	});

	test("surfaces helper close and abort", async () => {
		const { helper, sky } = makeSky();
		sky.abort("stop");
		await sky.close();
		assert.deepEqual(helper.calls.slice(-2), [["abort"], ["close"]]);
	});
});
