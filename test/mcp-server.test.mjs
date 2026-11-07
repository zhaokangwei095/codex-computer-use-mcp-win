import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "dist", "mcp-server.js");

let client;
let transport;
let stateRoot;

before(async () => {
	stateRoot = await mkdtemp(path.join(os.tmpdir(), "cua-mcp-"));
	const codexHome = path.join(stateRoot, "codex-home");
	await writeFile(path.join(stateRoot, "config.json"), JSON.stringify({
		helperPath: path.join(stateRoot, "missing-helper.exe"),
		codexPath: path.join(stateRoot, "missing-codex.exe"),
		codexHome,
		verifySignatures: false,
	}));
	transport = new StdioClientTransport({
		command: process.execPath,
		args: [serverPath],
		env: { ...process.env, CODEX_COMPUTER_USE_HOME: stateRoot },
		cwd: stateRoot,
		stderr: "pipe",
	});
	client = new Client({ name: "cua-mcp-test", version: "1.0.0" }, { capabilities: {} });
	await client.connect(transport);
});

after(async () => {
	await client?.close().catch(() => undefined);
	await transport?.close().catch(() => undefined);
	await rm(stateRoot, { recursive: true, force: true });
});

describe("MCP server", () => {
	test("lists the Computer Use tools in order", async () => {
		const result = await client.listTools();
		assert.deepEqual(result.tools.map((tool) => tool.name), ["js", "js_reset", "computer_use_status"]);
		const js = result.tools[0];
		assert.equal(js.inputSchema.required[0], "code");
		assert.equal(js.annotations.destructiveHint, true);
		assert.equal(js.annotations.openWorldHint, true);
	});

	test("resets the JavaScript session without starting a helper", async () => {
		const result = await client.callTool({ name: "js_reset", arguments: {} });
		assert.equal(result.isError, false);
		assert.match(result.content[0].text, /reset/i);
	});

	test("rejects empty JavaScript", async () => {
		const result = await client.callTool({ name: "js", arguments: { code: "   " } });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /non-empty/);
	});

	test("reports discovery failures as a tool error", async () => {
		const result = await client.callTool({ name: "js", arguments: { code: "1 + 1" } });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Configured helperPath does not exist/);
	});

	test("returns structured status with the auto-approval warning", async () => {
		const result = await client.callTool({ name: "computer_use_status", arguments: {} });
		assert.notEqual(result.isError, true);
		const status = JSON.parse(result.content[0].text);
		assert.equal(status.route, "cua_repl");
		assert.equal(status.platform, "win32");
		assert.equal(status.ready, false);
		assert.match(status.error, /Configured helperPath does not exist/);
		assert.equal(status.approval, "auto");
		assert.ok(status.warnings.some((warning) => /approval is auto/.test(warning)));
		assert.equal(result.structuredContent.platform, "win32");
	});
});
