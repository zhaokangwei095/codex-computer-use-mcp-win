import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

export interface AuditRecord {
	schemaVersion: 1;
	timestamp: string;
	runId: string;
	method: "js" | "js_reset" | "computer_use_status" | "helper_request" | "invalid_request";
	helperMethod?: string;
	inputBytes: number;
	outputBytes: number;
	outcome: "ok" | "tool_error" | "helper_error" | "timeout" | "cancelled" | "approval_denied" | "input_rejected" | "audit_error";
	durationMs: number;
	helperVersion?: string | null;
	appHash?: string | null;
	approval?: "accept" | "decline" | "cancel" | null;
	resultContentTypes: string[];
	errorCode?: string | null;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		const info = await lstat(directory);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error("Audit state path must be a non-symlink directory");
		}
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(directory, { recursive: true, mode: 0o700 });
	}
}

export async function appendAudit(stateRoot: string, record: AuditRecord): Promise<void> {
	await ensurePrivateDirectory(stateRoot);
	const auditDir = path.join(stateRoot, "audit");
	await ensurePrivateDirectory(auditDir);
	const auditPath = path.join(auditDir, "computer-use.jsonl");
	const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY;
	const handle = await open(auditPath, flags, 0o600);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Audit target must be a regular file");
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
	} finally {
		await handle.close();
	}
}
