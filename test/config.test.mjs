import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
	configPath,
	DEFAULT_DENY_APPS,
	defaultStateRoot,
	effectiveDenyApps,
	loadConfig,
} from "../dist/config.js";

const tempDirs = [];

async function tempDir(prefix) {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

after(async () => {
	await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("config", () => {
	test("loads defaults when config.json is absent", async () => {
		const stateRoot = await tempDir("cua-config-defaults-");
		const config = await loadConfig(stateRoot);
		assert.equal(config.approval, "auto");
		assert.equal(config.elicitationFallback, "auto");
		assert.equal(config.verifySignatures, true);
		assert.equal(config.audit, true);
		assert.equal(config.helperTimeoutMs, 60_000);
		assert.equal(config.sessionIdleMs, 600_000);
		assert.deepEqual(config.denyApps, []);
		assert.deepEqual(config.allowApps, []);
		assert.equal(configPath(stateRoot), path.join(stateRoot, "config.json"));
	});

	test("loads explicit values and combines the deny list", async () => {
		const stateRoot = await tempDir("cua-config-values-");
		await writeFile(path.join(stateRoot, "config.json"), JSON.stringify({
			approval: "mcp",
			elicitationFallback: "deny",
			verifySignatures: false,
			denyApps: ["slack.exe"],
			allowApps: ["notepad.exe"],
			maxTextBytes: 4096,
			helperTimeoutMs: 12_000,
			audit: false,
		}));
		const config = await loadConfig(stateRoot);
		assert.equal(config.approval, "mcp");
		assert.equal(config.elicitationFallback, "deny");
		assert.equal(config.verifySignatures, false);
		assert.deepEqual(config.denyApps, ["slack.exe"]);
		assert.deepEqual(config.allowApps, ["notepad.exe"]);
		assert.equal(config.maxTextBytes, 4096);
		assert.equal(config.helperTimeoutMs, 12_000);
		assert.equal(config.audit, false);
		const deny = effectiveDenyApps(config);
		assert.ok(deny.includes("cmd.exe"));
		assert.ok(deny.includes("slack.exe"));
		assert.ok(deny.includes("codex-computer-use.exe"));
		assert.ok(DEFAULT_DENY_APPS.includes("windowsterminal.exe"));
	});

	test("rejects malformed JSON", async () => {
		const stateRoot = await tempDir("cua-config-invalid-");
		await writeFile(path.join(stateRoot, "config.json"), "{not json");
		await assert.rejects(() => loadConfig(stateRoot), (error) => error.code === "CONFIG_ERROR");
	});

	test("rejects invalid values", async () => {
		const stateRoot = await tempDir("cua-config-schema-");
		await writeFile(path.join(stateRoot, "config.json"), JSON.stringify({ approval: "always" }));
		await assert.rejects(() => loadConfig(stateRoot), (error) => error.code === "CONFIG_ERROR");
	});

	test("honors CODEX_COMPUTER_USE_HOME and otherwise uses a Windows state folder", () => {
		const previous = process.env.CODEX_COMPUTER_USE_HOME;
		try {
			process.env.CODEX_COMPUTER_USE_HOME = "C:\\custom state";
			assert.equal(defaultStateRoot(), "C:\\custom state");
			delete process.env.CODEX_COMPUTER_USE_HOME;
			assert.match(defaultStateRoot(), /codex-computer-use-mcp-win$/i);
		} finally {
			if (previous === undefined) delete process.env.CODEX_COMPUTER_USE_HOME;
			else process.env.CODEX_COMPUTER_USE_HOME = previous;
		}
	});
});
