import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CuaError, errorMessage } from "./errors.ts";

export const CONFIG_FILENAME = "config.json";

/**
 * Apps the server never drives, even in `auto` approval mode. Matching is
 * case-insensitive and accepts either an executable basename, an app id, or a
 * display name. Keep this list boring: it is a floor, not a complete security
 * boundary.
 */
export const DEFAULT_DENY_APPS = [
	// Shells and terminals.
	"windowsterminal.exe", "wt.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
	"conhost.exe", "openconsole.exe", "wsl.exe", "bash.exe", "ubuntu.exe",
	"debian.exe", "kali.exe", "mintty.exe", "cygwin.exe",
	// The Computer Use control plane itself. Driving it can recurse or loop.
	"chatgpt.exe", "codex.exe", "codex-computer-use.exe", "cua-driver.exe",
	"cua-driver-uia.exe", "openai.codex",
	// Credential stores.
	"1password.exe", "1password7.exe", "keepass.exe", "keepassxc.exe",
	"bitwarden.exe", "lastpass.exe", "dashlane.exe", "nordpass.exe",
	"enpass.exe", "roboform.exe",
	// Security and system administration surfaces.
	"securityhealthsystray.exe", "msmpeng.exe", "nissrv.exe", "mpcmdrun.exe",
	"taskmgr.exe", "regedit.exe", "gpedit.msc", "mmc.exe", "services.msc",
	"eventvwr.msc", "lockapp.exe", "winlogon.exe", "logonui.exe",
	"credentialui.exe", "consent.exe", "useraccountcontrolsettings.exe",
	// Remote-control surfaces.
	"mstsc.exe", "quickassist.exe", "teamviewer.exe", "anydesk.exe",
] as const;

const configSchema = z.object({
	/** Absolute path to the signed OpenAI Computer Use helper. */
	helperPath: z.string().min(1).optional(),
	/** Absolute path to the signed Codex CLI executable used for helper auth. */
	codexPath: z.string().min(1).optional(),
	/** Codex state directory containing auth.json. Defaults to CODEX_HOME or ~/.codex. */
	codexHome: z.string().min(1).optional(),
	/** auto: approve non-denied apps. mcp: ask the MCP client. deny: refuse all. */
	approval: z.enum(["auto", "mcp", "deny"]).default("auto"),
	/** Used when approval is "mcp" but the client has no elicitation support. */
	elicitationFallback: z.enum(["auto", "deny"]).default("auto"),
	/** Verify Authenticode signatures before running the helper or Codex. */
	verifySignatures: z.boolean().default(true),
	/** Extra app patterns to deny. Combined with DEFAULT_DENY_APPS. */
	denyApps: z.array(z.string().min(1)).default([]),
	/** If non-empty, only these app patterns may be driven. */
	allowApps: z.array(z.string().min(1)).default([]),
	/** Maximum single screenshot accepted from the helper, after base64 decoding. */
	maxScreenshotBytes: z.number().int().min(0).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
	/** Maximum accessibility text returned by one call. */
	maxTextBytes: z.number().int().min(0).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
	/** Timeout for one helper request. */
	helperTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
	/** Close the helper and JS session after this much inactivity. */
	sessionIdleMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
	/** Append bounded metadata records to <stateRoot>/audit/. */
	audit: z.boolean().default(true),
});

export type AppConfig = z.infer<typeof configSchema>;

export function defaultStateRoot(): string {
	const override = process.env.CODEX_COMPUTER_USE_HOME;
	if (override && override.trim()) return override.trim();
	const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
	return path.join(localAppData, "codex-computer-use-mcp-win");
}

export function configPath(stateRoot = defaultStateRoot()): string {
	return path.join(stateRoot, CONFIG_FILENAME);
}

export function defaultCodexHome(): string {
	return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export async function loadConfig(stateRoot = defaultStateRoot()): Promise<AppConfig> {
	const file = configPath(stateRoot);
	let raw: unknown = {};
	try {
		raw = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
		throw new CuaError("CONFIG_ERROR", `Cannot read ${file}: ${errorMessage(error)}`, { cause: error });
	}
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		throw new CuaError("CONFIG_ERROR", `Invalid ${file}: ${parsed.error.message}`);
	}
	return parsed.data;
}

export function effectiveDenyApps(config: AppConfig): string[] {
	return [...DEFAULT_DENY_APPS, ...config.denyApps];
}
