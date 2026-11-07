import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "dist", "mcp-server.js");
const stateRoot = await mkdtemp(path.join(os.tmpdir(), "cua-mcp-live-"));
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [serverPath],
	env: { ...process.env, CODEX_COMPUTER_USE_HOME: stateRoot },
	cwd: stateRoot,
	stderr: "pipe",
});
const client = new Client({ name: "cua-live-probe", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
try {
	const statusResult = await client.callTool({ name: "computer_use_status", arguments: {} });
	const status = JSON.parse(statusResult.content[0].text);
	console.log("STATUS:", {
		ready: status.ready,
		error: status.error,
		approval: status.approval,
		helperSignature: status.helperSignature?.status ?? null,
		codexSignature: status.codexSignature?.status ?? null,
	});

	const code = `
const windows = await sky.list_windows();
const apps = await sky.list_apps();
const target = windows.find((w) => /notepad|calculator/i.test(w.app));
if (!target) {
  nodeRepl.write(JSON.stringify({ windows: windows.length, apps: apps.length, captured: false }));
} else {
  const state = await sky.get_window_state({ window: target, include_screenshot: true, include_text: false });
  nodeRepl.write(JSON.stringify({ windows: windows.length, apps: apps.length, captured: true, screenshots: state.screenshots.length }));
}
`;
	const jsResult = await client.callTool({ name: "js", arguments: { code, timeout_ms: 120000 } });
	console.log("JS_ERROR:", jsResult.isError ?? false);
	console.log("CONTENT:", jsResult.content.map((block) => block.type === "text"
		? { type: "text", length: block.text.length, text: block.text }
		: { type: "image", mimeType: block.mimeType, base64Length: block.data?.length ?? 0 }));
	console.log("STRUCTURED:", jsResult.structuredContent);

	const reset = await client.callTool({ name: "js_reset", arguments: {} });
	console.log("RESET_ERROR:", reset.isError ?? false);
} finally {
	await client.close().catch(() => undefined);
	await transport.close().catch(() => undefined);
	await rm(stateRoot, { recursive: true, force: true });
}
