import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	appCandidates,
	ApprovalController,
	buildApprovalElicitationParams,
	isAppAllowed,
} from "../dist/approval.js";
import { DEFAULT_DENY_APPS } from "../dist/config.js";
import { requestApprovalFromMcpClient } from "../dist/mcp-elicitation.js";

const APP = "process:C:\\Windows\\System32\\notepad.exe";

function controller(overrides = {}) {
	return new ApprovalController({
		mode: "auto",
		fallback: "auto",
		denyApps: [],
		allowApps: [],
		...overrides,
	});
}

describe("app matching", () => {
	test("normalizes process paths, basenames, and display names", () => {
		const candidates = appCandidates(APP, "Note Pad");
		assert.ok(candidates.includes("c:\\windows\\system32\\notepad.exe"));
		assert.ok(candidates.includes("notepad.exe"));
		assert.ok(candidates.includes("notepad"));
		assert.ok(candidates.includes("note pad"));
		assert.ok(candidates.includes("notepad"));
	});

	test("matches executable stems in both directions", () => {
		assert.equal(isAppAllowed("cmd", undefined, ["cmd.exe"], []), false);
		assert.equal(isAppAllowed("C:\\Windows\\System32\\CMD.EXE", undefined, ["cmd"], []), false);
		assert.equal(isAppAllowed(APP, "Notepad", DEFAULT_DENY_APPS, []), true);
		assert.equal(isAppAllowed("process:C:\\Windows\\System32\\WindowsTerminal.exe", "Terminal", DEFAULT_DENY_APPS, []), false);
		assert.equal(isAppAllowed("OpenAI.Codex_2p2nqsd0c76g0!App", undefined, DEFAULT_DENY_APPS, []), false);
	});

	test("deny wins over allow and allow restricts otherwise", () => {
		assert.equal(isAppAllowed(APP, "Notepad", ["notepad.exe"], ["notepad.exe"]), false);
		assert.equal(isAppAllowed(APP, "Notepad", [], ["notepad.exe"]), true);
		assert.equal(isAppAllowed("calc.exe", "Calculator", [], ["notepad.exe"]), false);
	});

	test("does not let a spoofed display name satisfy the allow list", () => {
		assert.equal(isAppAllowed("C:\\temp\\evil.exe", "notepad.exe", [], ["notepad.exe"]), false);
		assert.equal(isAppAllowed("C:\\temp\\evil.exe", "Notepad", ["notepad.exe"], []), false);
	});

	test("assertAllowed reports the actual reason", () => {
		const denied = controller({ denyApps: ["notepad.exe"] });
		assert.throws(() => denied.assertAllowed(APP, "Notepad"), (error) => {
			assert.equal(error.code, "APPROVAL_DENIED");
			assert.match(error.message, /deny list/);
			return true;
		});
		const notAllowed = controller({ allowApps: ["calculator.exe"] });
		assert.throws(() => notAllowed.assertAllowed(APP, "Notepad"), (error) => {
			assert.equal(error.code, "APPROVAL_DENIED");
			assert.match(error.message, /allow list/);
			return true;
		});
	});
});

describe("ApprovalController", () => {
	test("auto approves once and caches per app", async () => {
		const approval = controller();
		assert.equal(await approval.approve({ app: APP, displayName: "Notepad" }), "accept");
		assert.equal(await approval.approve({ app: APP, displayName: "Notepad" }), "accept");
		assert.deepEqual(approval.approvedApps, [APP]);
	});

	test("deny refuses even when the app is otherwise allowed", async () => {
		const approval = controller({ mode: "deny" });
		await assert.rejects(
			() => approval.approve({ app: APP, displayName: "Notepad" }),
			(error) => error.code === "APPROVAL_DENIED" && /approval mode is deny/.test(error.message),
		);
	});

	test("mcp mode asks the client once per app", async () => {
		let calls = 0;
		const approval = controller({
			mode: "mcp",
			elicit: async () => {
				calls += 1;
				return "accept";
			},
		});
		assert.equal(await approval.approve({ app: APP, displayName: "Notepad" }), "accept");
		assert.equal(await approval.approve({ app: APP, displayName: "Notepad" }), "accept");
		assert.equal(calls, 1);
	});

	test("mcp mode maps decline and cancel to approval errors", async () => {
		for (const decision of ["decline", "cancel"]) {
			const approval = controller({ mode: "mcp", elicit: async () => decision });
			await assert.rejects(
				() => approval.approve({ app: APP, displayName: "Notepad" }),
				(error) => error.code === "APPROVAL_DENIED",
			);
		}
	});

	test("mcp mode falls back according to configuration", async () => {
		const fallbackAuto = controller({
			mode: "mcp",
			fallback: "auto",
			elicit: async () => { throw new Error("no elicitation"); },
		});
		assert.equal(await fallbackAuto.approve({ app: APP, displayName: "Notepad" }), "accept");

		const fallbackDeny = controller({
			mode: "mcp",
			fallback: "deny",
			elicit: async () => { throw new Error("no elicitation"); },
		});
		await assert.rejects(
			() => fallbackDeny.approve({ app: APP, displayName: "Notepad" }),
			(error) => error.code === "APPROVAL_DENIED",
		);
	});

	test("no elicitation support follows the fallback", async () => {
		const auto = controller({ mode: "mcp", fallback: "auto" });
		assert.equal(await auto.approve({ app: APP, displayName: "Notepad" }), "accept");
		const deny = controller({ mode: "mcp", fallback: "deny" });
		await assert.rejects(
			() => deny.approve({ app: APP, displayName: "Notepad" }),
			(error) => error.code === "APPROVAL_DENIED" && /does not support approval prompts/.test(error.message),
		);
	});

	test("markApproved and clearApprovals manage the cache", async () => {
		const approval = controller({ mode: "mcp", fallback: "deny" });
		approval.markApproved(APP);
		assert.equal(await approval.approve({ app: APP, displayName: "Notepad" }), "accept");
		approval.clearApprovals();
		await assert.rejects(() => approval.approve({ app: APP, displayName: "Notepad" }));
	});
});

describe("elicitation", () => {
	test("builds a form that includes the app id and sanitizes display text", () => {
		const params = buildApprovalElicitationParams({
			app: APP,
			displayName: "Evil\nName\u0000With\u0007Controls",
			riskLevel: "high",
		});
		assert.ok(params);
		assert.equal(params.mode, "form");
		assert.match(params.message, /Evil Name With Controls/);
		assert.match(params.message, /App id:/);
		assert.match(params.message, /Risk level: high/);
		assert.equal(params.requestedSchema.required[0], "approve");
	});

	test("accepts only an explicit approve=true response", async () => {
		const client = (response) => ({ elicitInput: async () => response });
		assert.equal(await requestApprovalFromMcpClient(client({ action: "accept", content: { approve: true } }), {
			app: APP, displayName: "Notepad",
		}), "accept");
		assert.equal(await requestApprovalFromMcpClient(client({ action: "accept", content: { approve: false } }), {
			app: APP, displayName: "Notepad",
		}), "decline");
		assert.equal(await requestApprovalFromMcpClient(client({ action: "accept", content: null }), {
			app: APP, displayName: "Notepad",
		}), "decline");
		assert.equal(await requestApprovalFromMcpClient(client({ action: "decline" }), {
			app: APP, displayName: "Notepad",
		}), "decline");
		assert.equal(await requestApprovalFromMcpClient(client({ action: "cancel" }), {
			app: APP, displayName: "Notepad",
		}), "cancel");
		assert.equal(await requestApprovalFromMcpClient({ elicitInput: async () => { throw new Error("nope"); } }, {
			app: APP, displayName: "Notepad",
		}), "cancel");
	});
});
