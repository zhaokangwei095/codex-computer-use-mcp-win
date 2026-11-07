import { appendFileSync } from "node:fs";

const logPath = process.env.FAKE_HELPER_LOG;
const approval = process.env.FAKE_HELPER_APPROVAL === "1";
const slowMs = Number(process.env.FAKE_HELPER_SLOW_MS || "0");
const crashOn = process.env.FAKE_HELPER_CRASH_ON || "";

const APP = "process:C:\\Windows\\System32\\notepad.exe";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==";

function windowFor(id = 101) {
	return { app: APP, id, title: "Untitled - Notepad" };
}

function log(record) {
	if (!logPath) return;
	try {
		appendFileSync(logPath, `${JSON.stringify(record)}\n`);
	} catch {
		// Logging is best effort.
	}
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function summarize(params) {
	const clean = { ...params };
	if (typeof clean.text === "string") {
		clean.textLength = clean.text.length;
		delete clean.text;
	}
	return clean;
}

function logRequest(method, params, meta) {
	log({
		method,
		params: summarize(params),
		meta,
		envKeys: Object.keys(process.env).sort(),
		envSubset: {
			CODEX_HOME: process.env.CODEX_HOME,
			CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
			SKY_CUA_NATIVE_PIPE: process.env.SKY_CUA_NATIVE_PIPE,
			SKY_ENABLE_AUDIO: process.env.SKY_ENABLE_AUDIO,
			SKY_CUA_NATIVE_PIPE_DIRECTORY: process.env.SKY_CUA_NATIVE_PIPE_DIRECTORY,
		},
		argv: process.argv.slice(1),
	});
}

async function handle(line) {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		return;
	}
	if (!request || typeof request !== "object") return;
	const { id, method, params = {}, meta } = request;
	if (typeof id !== "number" || typeof method !== "string") return;
	logRequest(method, params, meta);

	if (method === "close") {
		send({ id, ok: true, result: null });
		setTimeout(() => process.exit(0), 10);
		return;
	}
	if (method === "get_window" && (params.id === 500 || crashOn === "get_window")) {
		process.stderr.write("fake helper crash\n");
		setTimeout(() => process.exit(7), 20);
		return;
	}
	if (method === "get_window_state" && params.window && params.window.id === 202) {
		send({ id, ok: false, error: "window is minimized" });
		return;
	}
	if (slowMs > 0 && method === "list_windows") {
		await new Promise((resolve) => setTimeout(resolve, slowMs));
	}
	if (
		method === "get_window_state" &&
		approval &&
		(!meta || meta["x-oai-cua-approved-app"] !== APP)
	) {
		send({
			id,
			ok: false,
			approvalRequest: {
				app: APP,
				displayName: "Notepad",
				riskLevel: "low",
				allowPersistentApproval: true,
			},
		});
		return;
	}

	switch (method) {
		case "list_apps":
			send({
				id,
				ok: true,
				result: [{
					id: APP,
					displayName: "Notepad",
					windows: [windowFor()],
					lastUsedDate: "2026-11-07T00:00:00Z",
					useCount: 3,
					isRunning: true,
				}],
			});
			return;
		case "list_windows":
			send({ id, ok: true, result: [windowFor(101), windowFor(202)] });
			return;
		case "get_window":
			send({ id, ok: true, result: windowFor(typeof params.id === "number" ? params.id : 101) });
			return;
		case "get_window_state":
			send({
				id,
				ok: true,
				result: {
					window: windowFor(params.window?.id ?? 101),
					screenshots: [{
						id: "screenshot-1",
						zIndex: 0,
						url: PNG,
						originX: 0,
						originY: 0,
						width: 1,
						height: 1,
					}],
					accessibility: {
						tree: "- window \"Untitled - Notepad\"\n  - text \"Hello\"",
						focused_element: "text",
						selected_text: "Hello",
						selected_elements: ["text"],
						document_text: "Hello",
					},
				},
			});
			return;
		case "activate_window":
		case "launch_app":
		case "click":
		case "click_element":
		case "press_key":
		case "type_text":
		case "scroll":
		case "set_value":
		case "drag":
		case "perform_secondary_action":
		case "end_turn":
			send({ id, ok: true, result: null });
			return;
		default:
			send({ id, ok: false, error: `unknown method: ${method}` });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const index = buffer.indexOf("\n");
		if (index < 0) break;
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim()) void handle(line);
	}
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
