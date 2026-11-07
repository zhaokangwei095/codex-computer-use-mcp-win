import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { JsKernel } from "../dist/js-kernel.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==";
const APP = "process:C:\\Windows\\System32\\notepad.exe";

class FakeSky {
	constructor() {
		this.calls = [];
		this.sink = undefined;
		this.aborted = [];
	}

	setImageSink(sink) {
		this.sink = sink;
	}

	async list_windows() {
		this.calls.push(["list_windows"]);
		return [{ app: APP, id: 101, title: "Untitled - Notepad" }];
	}

	async list_apps() {
		this.calls.push(["list_apps"]);
		return [{
			id: APP,
			displayName: "Notepad",
			windows: [{ app: APP, id: 101, title: "Untitled - Notepad" }],
			isRunning: true,
		}];
	}

	async get_window_state(input) {
		this.calls.push(["get_window_state", input]);
		this.sink?.(PNG);
		return {
			window: input.window,
			screenshots: [{ id: "s1", zIndex: 0, url: PNG, width: 10, height: 10 }],
			accessibility: { tree: "- window\n  - button \"OK\"", selected_text: "OK" },
		};
	}

	async click(input) { this.calls.push(["click", input]); }
	async press_key(input) { this.calls.push(["press_key", input]); }
	async type_text(input) { this.calls.push(["type_text", input]); }
	async scroll(input) { this.calls.push(["scroll", input]); }
	async set_value(input) { this.calls.push(["set_value", input]); }
	async drag(input) { this.calls.push(["drag", input]); }
	async perform_secondary_action(input) { this.calls.push(["perform_secondary_action", input]); }
	async activate_window(input) { this.calls.push(["activate_window", input]); }
	async launch_app(input) { this.calls.push(["launch_app", input]); }

	abort(reason) {
		this.aborted.push(reason);
	}
}

function text(result) {
	return result.output.text.join("");
}

describe("sandboxed JavaScript", () => {
	let sky;
	let kernel;

	before(() => {
		sky = new FakeSky();
		kernel = new JsKernel({ sky, timeoutMs: 5_000, maxTextBytes: 100_000 });
	});

	after(async () => {
		await kernel.close();
	});

	test("persists top-level bindings and supports redeclaration across cells", async () => {
		const first = await kernel.run("const persistValue = 1; nodeRepl.write(String(persistValue));");
		assert.equal(first.ok, true, first.error);
		assert.equal(text(first), "1");

		const second = await kernel.run("persistValue += 1; nodeRepl.write(String(persistValue));");
		assert.equal(second.ok, true, second.error);
		assert.equal(text(second), "2");

		const third = await kernel.run("let persistValue = 3; nodeRepl.write(String(persistValue));");
		assert.equal(third.ok, true, third.error);
		assert.equal(text(third), "3");
	});

	test("supports destructuring, functions, classes, and top-level await", async () => {
		const result = await kernel.run(`
const { a, b: [c] } = { a: 1, b: [2] };
function add(x, y) { return x + y; }
class Box { constructor(value) { this.value = value; } get() { return this.value; } }
await new Promise((resolve) => setTimeout(resolve, 10));
nodeRepl.write(JSON.stringify({ a, c, sum: add(a, c), box: new Box(7).get() }));
`);
		assert.equal(result.ok, true, result.error);
		assert.deepEqual(JSON.parse(text(result)), { a: 1, c: 2, sum: 3, box: 7 });

		const later = await kernel.run("nodeRepl.write(String(add(4, 5)));");
		assert.equal(later.ok, true, later.error);
		assert.equal(text(later), "9");
	});

	test("returns the last expression and console output", async () => {
		const result = await kernel.run("console.log('hello'); 2 + 3");
		assert.equal(result.ok, true, result.error);
		assert.match(text(result), /hello/);
		assert.match(text(result), /5/);

		const object = await kernel.run("nodeRepl.write({ answer: 42 });");
		assert.equal(object.ok, true, object.error);
		assert.match(text(object), /answer/);
		assert.match(text(object), /42/);
	});

	test("bridges RPC calls to sky and emits images", async () => {
		const windows = await kernel.run("const windows = await sky.list_windows(); nodeRepl.write(windows[0].app);");
		assert.equal(windows.ok, true, windows.error);
		assert.equal(text(windows), APP);

		const image = await kernel.run(`nodeRepl.emitImage(${JSON.stringify(PNG)}); "image"`);
		assert.equal(image.ok, true, image.error);
		assert.equal(image.output.images.length, 1);
		assert.equal(image.output.images[0], PNG);
	});

	test("supports the cua facade", async () => {
		const result = await kernel.run(`
const app = await cua.getApp("Notepad");
const state = await app.getAXState();
await app.click(3);
await app.typeText("hi");
await app.pressKey("Return");
nodeRepl.write(JSON.stringify({ text: state.text, hasScreenshot: Boolean(state.screenshot) }));
`);
		assert.equal(result.ok, true, result.error);
		assert.deepEqual(JSON.parse(text(result)), { text: "- window\n  - button \"OK\"", hasScreenshot: true });
		assert.equal(sky.calls.some(([name]) => name === "click"), true);
		assert.equal(sky.calls.some(([name]) => name === "type_text"), true);
		assert.equal(sky.calls.some(([name]) => name === "press_key"), true);
	});

	test("does not expose Node internals", async () => {
		const result = await kernel.run("nodeRepl.write(JSON.stringify({ process: typeof process, require: typeof require, Buffer: typeof Buffer, fetch: typeof fetch }));");
		assert.equal(result.ok, true, result.error);
		assert.deepEqual(JSON.parse(text(result)), {
			process: "undefined",
			require: "undefined",
			Buffer: "undefined",
			fetch: "undefined",
		});
	});

	test("blocks eval, Function, static import, and dynamic import", async () => {
		const evalResult = await kernel.run("eval('1 + 1')");
		assert.equal(evalResult.ok, false);
		assert.match(evalResult.error, /EvalError|code generation/i);

		const functionResult = await kernel.run("new Function('return 1')()");
		assert.equal(functionResult.ok, false);
		assert.match(functionResult.error, /EvalError|code generation/i);

		const staticImport = await kernel.run("import fs from 'node:fs'; fs;");
		assert.equal(staticImport.ok, false);
		assert.match(staticImport.error, /import\/export is not available/);

		const dynamicImport = await kernel.run("await import('node:fs')");
		assert.equal(dynamicImport.ok, false);
		assert.match(dynamicImport.error, /import\(\) is disabled/);
	});

	test("blocks access to the bridge globals after bootstrap", async () => {
		const result = await kernel.run("nodeRepl.write(String(typeof __rpc) + ',' + String(typeof __write) + ',' + String(typeof __scope));");
		assert.equal(result.ok, true, result.error);
		assert.equal(text(result), "undefined,undefined,object");
	});

	test("evaluates the final declaration initializer exactly once", async () => {
		const sky = new FakeSky();
		const kernel = new JsKernel({ sky, timeoutMs: 5_000 });
		try {
			const before = sky.calls.filter(([name]) => name === "list_apps").length;
			const result = await kernel.run("const apps = await sky.list_apps();");
			assert.equal(result.ok, true, result.error);
			assert.equal(sky.calls.filter(([name]) => name === "list_apps").length - before, 1);
		} finally {
			await kernel.close();
		}
	});

	test("does not expose host constructors through RPC failures", async () => {
		const result = await kernel.run(`
try {
  await sky.get_window({ id: 101 });
  nodeRepl.write("no-error");
} catch (error) {
  let escaped = "none";
  try {
    const constructor = error && error.constructor && error.constructor.constructor;
    escaped = typeof constructor === "function" ? String(constructor("return typeof process")()) : "no-constructor";
  } catch {
    escaped = "blocked";
  }
  nodeRepl.write(JSON.stringify({ isError: error instanceof Error, escaped }));
}
`);
		assert.equal(result.ok, true, result.error);
		assert.deepEqual(JSON.parse(text(result)), { isError: true, escaped: "blocked" });
	});

	test("truncates oversized output", async () => {
		const small = new JsKernel({ sky: new FakeSky(), maxTextBytes: 100 });
		try {
			const result = await small.run("nodeRepl.write('x'.repeat(1000));");
			assert.equal(result.ok, true, result.error);
			assert.match(text(result), /output truncated/);
			assert.ok(Buffer.byteLength(text(result), "utf8") < 500);
		} finally {
			await small.close();
		}
	});

	test("caps total image bytes", async () => {
		const small = new JsKernel({ sky: new FakeSky(), maxImageBytes: 10, maxTotalImageBytes: 4 });
		try {
			const result = await small.run(`
nodeRepl.emitImage("data:image/png;base64,AAA=");
nodeRepl.emitImage("data:image/png;base64,BBB=");
nodeRepl.write("done");
`);
			assert.equal(result.ok, true, result.error);
			assert.equal(result.output.images.length, 1);
		} finally {
			await small.close();
		}
	});

	test("rejects oversized code", async () => {
		const small = new JsKernel({ sky: new FakeSky(), maxCodeBytes: 10 });
		try {
			const result = await small.run("nodeRepl.write('x'.repeat(20));");
			assert.equal(result.ok, false);
			assert.match(result.error, /too large/);
		} finally {
			await small.close();
		}
	});
});

describe("sandbox lifecycle", () => {
	test("terminates an infinite loop and starts a fresh worker", async () => {
		const sky = new FakeSky();
		const kernel = new JsKernel({ sky, timeoutMs: 5_000 });
		try {
			const before = await kernel.run("const timedOutValue = 1;");
			assert.equal(before.ok, true, before.error);
			const timeout = await kernel.run("while (true) {}", 60);
			assert.equal(timeout.ok, false);
			assert.equal(timeout.timedOut, true);
			assert.ok(sky.aborted.length >= 1);
			const after = await kernel.run("nodeRepl.write(String(typeof timedOutValue));");
			assert.equal(after.ok, true, after.error);
			assert.equal(text(after), "undefined");
		} finally {
			await kernel.close();
		}
	});

	test("honors AbortSignal cancellation", async () => {
		const sky = new FakeSky();
		const kernel = new JsKernel({ sky, timeoutMs: 5_000 });
		try {
			const controller = new AbortController();
			const pending = kernel.run("await new Promise((resolve) => setTimeout(resolve, 5000));", 5_000, controller.signal);
			setTimeout(() => controller.abort(), 50);
			const result = await pending;
			assert.equal(result.ok, false);
			assert.equal(result.aborted, true);
			assert.ok(sky.aborted.length >= 1);
		} finally {
			await kernel.close();
		}
	});

	test("does not attribute late output to a later run", async () => {
		const kernel = new JsKernel({ sky: new FakeSky(), timeoutMs: 5_000 });
		try {
			const first = await kernel.run("setTimeout(() => nodeRepl.write('LATE-OUTPUT'), 50); 'first'");
			assert.equal(first.ok, true, first.error);
			// The timer fires while the second run is active; it must still be
			// attributed to the first run and dropped.
			const second = await kernel.run("await new Promise((resolve) => setTimeout(resolve, 200)); nodeRepl.write('SECOND');");
			assert.equal(second.ok, true, second.error);
			assert.equal(text(second), "SECOND");
		} finally {
			await kernel.close();
		}
	});

	test("does not hang when the worker exits before becoming ready", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "cua-bad-worker-"));
		const workerPath = path.join(directory, "bad-worker.mjs");
		await writeFile(workerPath, "process.exit(7);\n");
		const kernel = new JsKernel({ sky: new FakeSky(), workerPath, timeoutMs: 1_000 });
		try {
			const result = await kernel.run("1 + 1");
			assert.equal(result.ok, false);
			assert.match(result.error, /worker exited|exited/i);
		} finally {
			await kernel.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("limits queued runs", async () => {
		const sky = new FakeSky();
		const kernel = new JsKernel({ sky, timeoutMs: 5_000, maxPendingRuns: 1 });
		try {
			const first = kernel.run("await new Promise((resolve) => setTimeout(resolve, 200));", 5_000);
			const second = await kernel.run("1");
			assert.equal(second.ok, false);
			assert.match(second.error, /Too many/);
			const firstResult = await first;
			assert.equal(firstResult.ok, true, firstResult.error);
		} finally {
			await kernel.close();
		}
	});
});
