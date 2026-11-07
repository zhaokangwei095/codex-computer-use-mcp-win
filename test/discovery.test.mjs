import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { discoverInstallation, readCodexToml } from "../dist/discovery.js";

const tempDirs = [];

async function tempDir(prefix) {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

after(async () => {
	await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeFake(file, timeMs) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, "fake binary");
	const date = new Date(timeMs);
	await utimes(file, date, date);
}

const VALID_SIGNATURE = {
	status: "Valid",
	subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"',
	version: "1.0.0",
	productVersion: "1.0.0",
};

async function makeFixture(prefix) {
	const root = await tempDir(prefix);
	const localAppData = path.join(root, "local");
	const codexHome = path.join(root, "codex-home");
	const runtimeRoot = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
	const helperA = path.join(runtimeRoot, "aaa", "bin", "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
	const helperB = path.join(runtimeRoot, "bbb", "bin", "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
	const codex = path.join(localAppData, "OpenAI", "Codex", "bin", "hashcodex", "codex.exe");
	const now = Date.now();
	await writeFake(helperA, now - 60_000);
	await writeFake(helperB, now - 1_000);
	await writeFake(codex, now);
	await mkdir(codexHome, { recursive: true });
	await writeFile(path.join(codexHome, "auth.json"), "{}");
	await writeFile(path.join(codexHome, "config.toml"), [
		"[mcp_servers.node_repl.env]",
		`CODEX_CLI_PATH = ${JSON.stringify(codex)}`,
		`CODEX_HOME = ${JSON.stringify(codexHome)}`,
		`NODE_REPL_NODE_MODULE_DIRS = ${JSON.stringify(path.join(runtimeRoot, "aaa", "bin", "node_modules"))}`,
		'OPENAI_API_KEY = "should-not-be-read"',
	].join("\n"));
	return { root, localAppData, codexHome, helperA, helperB, codex };
}

async function baseConfig(codexHome) {
	const stateRoot = await tempDir("cua-discovery-state-");
	return { ...(await loadConfig(stateRoot)), codexHome };
}

describe("readCodexToml", () => {
	test("extracts only the node_repl transport keys", async () => {
		const fixture = await makeFixture("cua-discovery-toml-");
		const info = await readCodexToml(fixture.codexHome);
		assert.equal(info.found, true);
		assert.equal(info.error, undefined);
		assert.deepEqual(Object.keys(info.env).sort(), ["CODEX_CLI_PATH", "CODEX_HOME", "NODE_REPL_NODE_MODULE_DIRS"]);
		assert.equal(info.env.CODEX_HOME, fixture.codexHome);
		assert.equal("OPENAI_API_KEY" in info.env, false);
	});

	test("reports parse failures without echoing config.toml contents", async () => {
		const root = await tempDir("cua-discovery-badtoml-");
		await writeFile(path.join(root, "config.toml"), [
			'tavily_api_key = "tvly-TOPSECRET"',
			"[broken",
			"key = ",
		].join("\n"));
		const info = await readCodexToml(root);
		assert.equal(info.found, true);
		assert.match(info.error, /Cannot parse/);
		assert.equal(info.error.includes("TOPSECRET"), false);
		assert.equal(info.error.includes("tavily"), false);
	});
});

describe("discoverInstallation", () => {
	test("chooses the newest runtime, verifies signatures, and records hashes", async () => {
		const fixture = await makeFixture("cua-discovery-basic-");
		const config = await baseConfig(fixture.codexHome);
		const installation = await discoverInstallation(config, {
			homeDir: fixture.root,
			localAppData: fixture.localAppData,
			programFiles: path.join(fixture.root, "program-files"),
			findApp: async () => undefined,
			pathCodex: async () => [],
			verifyFile: async () => ({ ...VALID_SIGNATURE }),
		});
		assert.equal(installation.helperPath, fixture.helperB);
		assert.equal(installation.codexPath, fixture.codex);
		assert.equal(installation.codexHome, fixture.codexHome);
		assert.equal(installation.helperSignature.status, "Valid");
		assert.equal(installation.codexSignature.status, "Valid");
		assert.match(installation.helperSignature.sha256, /^[0-9a-f]{64}$/);
		assert.match(installation.codexSignature.sha256, /^[0-9a-f]{64}$/);
		assert.ok(installation.warnings.some((warning) => /Multiple Computer Use runtimes/.test(warning)));
		assert.ok(installation.warnings.every((warning) => !warning.includes("should-not-be-read")));
	});

	test("falls back to an older runtime when the newest signature is invalid", async () => {
		const fixture = await makeFixture("cua-discovery-fallback-");
		const config = await baseConfig(fixture.codexHome);
		const installation = await discoverInstallation(config, {
			homeDir: fixture.root,
			localAppData: fixture.localAppData,
			findApp: async () => undefined,
			pathCodex: async () => [],
			verifyFile: async (file) => file.toLowerCase().includes("bbb")
				? { ...VALID_SIGNATURE, status: "NotSigned", subject: "" }
				: { ...VALID_SIGNATURE },
		});
		assert.equal(installation.helperPath, fixture.helperA);
	});

	test("rejects a runtime whose signature is not valid OpenAI", async () => {
		const fixture = await makeFixture("cua-discovery-invalid-");
		const config = await baseConfig(fixture.codexHome);
		await assert.rejects(
			() => discoverInstallation(config, {
				homeDir: fixture.root,
				localAppData: fixture.localAppData,
				findApp: async () => undefined,
				pathCodex: async () => [],
				verifyFile: async () => ({ ...VALID_SIGNATURE, subject: "CN=Someone Else" }),
			}),
			(error) => error.code === "SIGNATURE_INVALID" && /unexpected publisher/.test(error.message),
		);
	});

	test("discovers the helper and Codex from the app bundle", async () => {
		const root = await tempDir("cua-discovery-app-");
		const appPath = path.join(root, "ChatGPT");
		const helper = path.join(appPath, "app", "resources", "cua_node", "bin", "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
		const codex = path.join(appPath, "app", "resources", "codex.exe");
		await writeFake(helper, Date.now());
		await writeFake(codex, Date.now());
		const codexHome = path.join(root, "codex-home");
		await mkdir(codexHome, { recursive: true });
		const config = { ...(await baseConfig(codexHome)), verifySignatures: false };
		const installation = await discoverInstallation(config, {
			homeDir: root,
			localAppData: path.join(root, "local"),
			programFiles: path.join(root, "program-files"),
			findApp: async () => appPath,
			pathCodex: async () => [],
		});
		assert.equal(installation.helperPath, helper);
		assert.equal(installation.codexPath, codex);
		assert.ok(installation.warnings.some((warning) => /Signature verification is disabled/.test(warning)));
	});

	test("honors explicit helperPath and codexPath overrides", async () => {
		const fixture = await makeFixture("cua-discovery-override-");
		const config = {
			...(await baseConfig(fixture.codexHome)),
			helperPath: fixture.helperA,
			codexPath: fixture.codex,
			verifySignatures: false,
		};
		const installation = await discoverInstallation(config, {
			homeDir: fixture.root,
			localAppData: path.join(fixture.root, "empty"),
			findApp: async () => undefined,
			pathCodex: async () => [],
		});
		assert.equal(installation.helperPath, fixture.helperA);
		assert.equal(installation.codexPath, fixture.codex);
	});

	test("reports missing helper and missing Codex separately", async () => {
		const fixture = await makeFixture("cua-discovery-missing-");
		const cleanCodexHome = await tempDir("cua-discovery-empty-home-");
		const config = await baseConfig(cleanCodexHome);
		await assert.rejects(
			() => discoverInstallation(config, {
				homeDir: fixture.root,
				localAppData: path.join(fixture.root, "empty"),
				findApp: async () => undefined,
				pathCodex: async () => [],
			}),
			(error) => error.code === "DISCOVERY_FAILED" && /Computer Use helper/.test(error.message),
		);
		await assert.rejects(
			() => discoverInstallation({
				...config,
				helperPath: fixture.helperA,
				verifySignatures: false,
			}, {
				homeDir: fixture.root,
				localAppData: path.join(fixture.root, "empty"),
				findApp: async () => undefined,
				pathCodex: async () => [],
			}),
			(error) => error.code === "DISCOVERY_FAILED" && /Codex CLI/.test(error.message),
		);
	});

	test("rejects a configured path that does not exist", async () => {
		const fixture = await makeFixture("cua-discovery-badpath-");
		const config = {
			...(await baseConfig(fixture.codexHome)),
			helperPath: path.join(fixture.root, "missing.exe"),
			verifySignatures: false,
		};
		await assert.rejects(
			() => discoverInstallation(config, {
				homeDir: fixture.root,
				localAppData: fixture.localAppData,
				findApp: async () => undefined,
				pathCodex: async () => [],
			}),
			(error) => error.code === "DISCOVERY_FAILED" && /Configured helperPath does not exist/.test(error.message),
		);
	});
});
