import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { appendAudit } from "../dist/audit.js";

const tempDirs = [];

async function tempDir(prefix) {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

after(async () => {
	await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(overrides = {}) {
	return {
		schemaVersion: 1,
		timestamp: "2026-11-07T00:00:00.000Z",
		runId: "run-1",
		method: "js",
		inputBytes: 10,
		outputBytes: 20,
		outcome: "ok",
		durationMs: 30,
		helperVersion: "1.2.3",
		resultContentTypes: ["text"],
		errorCode: null,
		...overrides,
	};
}

describe("audit", () => {
	test("appends bounded JSONL records without content fields", async () => {
		const stateRoot = await tempDir("cua-audit-");
		await appendAudit(stateRoot, record());
		await appendAudit(stateRoot, record({ runId: "run-2", method: "js_reset", outcome: "tool_error", errorCode: "JS_ERROR" }));
		const text = await readFile(path.join(stateRoot, "audit", "computer-use.jsonl"), "utf8");
		const lines = text.trim().split(/\r?\n/);
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]);
		assert.equal(first.runId, "run-1");
		assert.equal(first.schemaVersion, 1);
		assert.equal("code" in first, false);
		assert.equal("text" in first, false);
		assert.equal("screenshot" in first, false);
		const second = JSON.parse(lines[1]);
		assert.equal(second.runId, "run-2");
		assert.equal(second.outcome, "tool_error");
	});

	test("rejects a state root that is a file", async () => {
		const root = await tempDir("cua-audit-file-");
		const file = path.join(root, "not-a-directory");
		await writeFile(file, "x");
		await assert.rejects(
			() => appendAudit(file, record()),
			(error) => /non-symlink directory/.test(error.message),
		);
	});

	test("rejects an audit directory that is a file", async () => {
		const root = await tempDir("cua-audit-dirfile-");
		await writeFile(path.join(root, "audit"), "x");
		await assert.rejects(
			() => appendAudit(root, record()),
			(error) => /non-symlink directory/.test(error.message),
		);
	});
});
