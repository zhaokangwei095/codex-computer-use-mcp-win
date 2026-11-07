import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { AppConfig } from "./config.ts";
import { defaultCodexHome } from "./config.ts";
import { DiscoveryError, SignatureError, errorMessage } from "./errors.ts";

const execFileAsync = promisify(execFile);

const TOML_ENV_KEYS = [
	"CODEX_CLI_PATH",
	"CODEX_HOME",
	"NODE_REPL_NODE_MODULE_DIRS",
] as const;

export interface CodexTomlInfo {
	path: string;
	found: boolean;
	env: Partial<Record<typeof TOML_ENV_KEYS[number], string>>;
	error?: string;
}

export interface SignatureInfo {
	status: string;
	subject: string;
	version: string;
	productVersion: string;
	/** SHA-256 of the verified file, when it could be computed. */
	sha256?: string;
}

export interface Installation {
	helperPath: string;
	codexPath: string;
	codexHome: string;
	configTomlPath: string;
	chatGptAppPath?: string;
	helperSignature?: SignatureInfo;
	codexSignature?: SignatureInfo;
	warnings: string[];
}

export interface DiscoveryOptions {
	/** Test seam. Defaults to the real user profile. */
	homeDir?: string;
	localAppData?: string;
	programFiles?: string;
	/** Test seam for Authenticode verification. */
	verifyFile?: (file: string) => Promise<SignatureInfo>;
	/** Test seam for the MSIX lookup. */
	findApp?: () => Promise<string | undefined>;
	/** Test seam for looking up codex.exe on PATH. */
	pathCodex?: () => Promise<Array<{ path: string; mtimeMs: number }>>;
}

interface Candidate {
	path: string;
	mtimeMs: number;
}

function envValue(name: string): string | undefined {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : undefined;
}

export function defaultLocalAppData(homeDir = os.homedir()): string {
	return envValue("LOCALAPPDATA") || path.join(homeDir, "AppData", "Local");
}

export function defaultProgramFiles(): string {
	return envValue("ProgramFiles") || envValue("PROGRAMFILES") || "C:\\Program Files";
}

export async function readCodexToml(codexHome: string): Promise<CodexTomlInfo> {
	const file = path.join(codexHome, "config.toml");
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { path: file, found: false, env: {} };
		}
		return { path: file, found: false, env: {}, error: errorMessage(error) };
	}
	try {
		const parsed = parseToml(text) as Record<string, unknown>;
		const servers = parsed.mcp_servers;
		const nodeRepl = servers && typeof servers === "object" ? (servers as Record<string, unknown>).node_repl : undefined;
		const rawEnv = nodeRepl && typeof nodeRepl === "object" ? (nodeRepl as Record<string, unknown>).env : undefined;
		const env: CodexTomlInfo["env"] = {};
		if (rawEnv && typeof rawEnv === "object") {
			for (const key of TOML_ENV_KEYS) {
				const value = (rawEnv as Record<string, unknown>)[key];
				if (typeof value === "string" && value.trim()) env[key] = value.trim();
			}
		}
		return { path: file, found: true, env };
	} catch (error) {
		// smol-toml errors embed a snippet of the source document. config.toml can
		// contain API keys, so report only the position, never the parser message.
		const line = typeof (error as { line?: unknown }).line === "number" ? (error as { line: number }).line : undefined;
		const column = typeof (error as { column?: unknown }).column === "number" ? (error as { column: number }).column : undefined;
		const position = line !== undefined ? ` at line ${line}${column !== undefined ? `, column ${column}` : ""}` : "";
		return { path: file, found: true, env: {}, error: `Cannot parse ${file}${position}: invalid TOML. Fix the file or remove the node_repl block.` };
	}
}

function helperPathInModuleDir(moduleDir: string): string {
	return path.join(moduleDir, "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
}

function helperPathInRuntime(runtimeDir: string): string {
	return path.join(runtimeDir, "bin", "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
}

async function mtimeOf(file: string, allowSymlink = false): Promise<number | undefined> {
	try {
		const info = await lstat(file);
		if (info.isSymbolicLink() && !allowSymlink) return undefined;
		if (!info.isFile()) return undefined;
		return info.mtimeMs;
	} catch {
		return undefined;
	}
}

async function collectRuntimeHelpers(localAppData: string): Promise<Candidate[]> {
	const root = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const candidates: Candidate[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = helperPathInRuntime(path.join(root, entry.name));
		const mtimeMs = await mtimeOf(candidate);
		if (mtimeMs !== undefined) candidates.push({ path: candidate, mtimeMs });
	}
	return candidates;
}

async function collectModuleDirHelpers(moduleDirs: string | undefined): Promise<Candidate[]> {
	if (!moduleDirs) return [];
	const candidates: Candidate[] = [];
	for (const directory of moduleDirs.split(path.delimiter)) {
		const trimmed = directory.trim();
		if (!trimmed) continue;
		const candidate = helperPathInModuleDir(trimmed);
		const mtimeMs = await mtimeOf(candidate);
		if (mtimeMs !== undefined) candidates.push({ path: candidate, mtimeMs });
	}
	return candidates;
}

async function collectCodexBinaries(localAppData: string): Promise<Candidate[]> {
	const root = path.join(localAppData, "OpenAI", "Codex", "bin");
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const candidates: Candidate[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = path.join(root, entry.name, "codex.exe");
		const mtimeMs = await mtimeOf(candidate);
		if (mtimeMs !== undefined) candidates.push({ path: candidate, mtimeMs });
	}
	return candidates;
}

async function collectPathCodex(): Promise<Candidate[]> {
	try {
		const { stdout } = await execFileAsync("where.exe", ["codex.exe"], { timeout: 5_000, windowsHide: true });
		const candidates: Candidate[] = [];
		for (const line of stdout.split(/\r?\n/)) {
			const candidate = line.trim();
			if (!candidate) continue;
			const mtimeMs = await mtimeOf(candidate);
			if (mtimeMs !== undefined) candidates.push({ path: candidate, mtimeMs });
		}
		return candidates;
	} catch {
		return [];
	}
}

/**
 * Windows PowerShell 5.1 inherits PSModulePath from the parent process. When the
 * server is launched from PowerShell 7, that path can point at incompatible
 * PowerShell 7 modules and Windows PowerShell then fails to autoload
 * Microsoft.PowerShell.Security (`Get-AuthenticodeSignature`). Drop the variable
 * so powershell.exe uses its own default module paths.
 */
function windowsPowerShellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	delete env.PSModulePath;
	return env;
}

export async function findChatGptApp(): Promise<string | undefined> {
	const programFiles = defaultProgramFiles();
	const windowsApps = path.join(programFiles, "WindowsApps");
	try {
		const entries = await readdir(windowsApps, { withFileTypes: true });
		const apps = entries
			.filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_/i.test(entry.name))
			.map((entry) => path.join(windowsApps, entry.name))
			.sort()
			.reverse();
		if (apps.length > 0) return apps[0];
	} catch {
		// WindowsApps is usually not listable by a standard user; fall through.
	}
	try {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation"],
			{ timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024, env: windowsPowerShellEnv() },
		);
		const location = stdout.trim();
		return location && existsSync(location) ? location : undefined;
	} catch {
		return undefined;
	}
}

function appHelperCandidate(appPath: string | undefined): Candidate[] {
	if (!appPath) return [];
	const candidate = path.join(appPath, "app", "resources", "cua_node", "bin", "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
	return existsSync(candidate) ? [{ path: candidate, mtimeMs: 0 }] : [];
}

function appCodexCandidate(appPath: string | undefined): Candidate[] {
	if (!appPath) return [];
	const candidate = path.join(appPath, "app", "resources", "codex.exe");
	return existsSync(candidate) ? [{ path: candidate, mtimeMs: 0 }] : [];
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
	const seen = new Set<string>();
	const result: Candidate[] = [];
	for (const candidate of candidates) {
		const key = path.resolve(candidate.path).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(candidate);
	}
	return result;
}

function pickNewest(candidates: Candidate[]): Candidate | undefined {
	return [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

function quoteSubject(subject: string): string {
	return subject.replace(/\s+/g, " ").trim();
}

export async function verifyAuthenticode(file: string): Promise<SignatureInfo> {
	if (process.platform !== "win32") {
		return { status: "Unsupported", subject: "", version: "", productVersion: "" };
	}
	const script = [
		"$s = Get-AuthenticodeSignature -LiteralPath $env:CUA_VERIFY_PATH",
		"$v = (Get-Item -LiteralPath $env:CUA_VERIFY_PATH).VersionInfo",
		"$subject = ''",
		"if ($s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }",
		"[pscustomobject]@{",
		"  Status = $s.Status.ToString()",
		"  Subject = $subject",
		"  Version = $v.FileVersion",
		"  ProductVersion = $v.ProductVersion",
		"} | ConvertTo-Json -Compress",
	].join("\n");
	const { stdout } = await execFileAsync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		{
			timeout: 30_000,
			windowsHide: true,
			maxBuffer: 1024 * 1024,
			env: windowsPowerShellEnv({ CUA_VERIFY_PATH: file }),
		},
	);
	const parsed = JSON.parse(stdout.trim()) as Record<string, unknown> | Array<Record<string, unknown>>;
	const value = Array.isArray(parsed) ? parsed[0] : parsed;
	return {
		status: typeof value?.Status === "string" ? value.Status : "Unknown",
		subject: typeof value?.Subject === "string" ? quoteSubject(value.Subject) : "",
		version: typeof value?.Version === "string" ? value.Version : "",
		productVersion: typeof value?.ProductVersion === "string" ? value.ProductVersion : "",
	};
}

const verificationCache = new Map<string, Promise<SignatureInfo>>();

async function sha256File(file: string): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = createReadStream(file);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

async function verifyCached(file: string, verifyFile: (file: string) => Promise<SignatureInfo>): Promise<SignatureInfo> {
	const info = await stat(file);
	const key = `${path.resolve(file).toLowerCase()}|${info.mtimeMs}|${info.size}`;
	let pending = verificationCache.get(key);
	if (!pending) {
		pending = (async () => {
			const signature = await verifyFile(file);
			if (signature.sha256) return signature;
			try {
				return { ...signature, sha256: await sha256File(file) };
			} catch {
				return signature;
			}
		})();
		verificationCache.set(key, pending);
		pending.catch(() => {
			if (verificationCache.get(key) === pending) verificationCache.delete(key);
		});
	}
	return pending;
}

async function chooseVerified(
	kind: string,
	candidates: Candidate[],
	verifyFile: (file: string) => Promise<SignatureInfo>,
): Promise<{ candidate: Candidate; signature: SignatureInfo }> {
	// Candidates are tried newest-first so a bad update can fall back to an older
	// signed runtime. If every candidate fails, report the newest failure: it is
	// the runtime that would have been used, and the most useful to diagnose.
	let firstError: unknown;
	for (const candidate of [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
		try {
			const signature = await verifyCached(candidate.path, verifyFile);
			assertOpenAiSignature(kind, candidate.path, signature);
			return { candidate, signature };
		} catch (error) {
			if (firstError === undefined) firstError = error;
		}
	}
	if (firstError instanceof SignatureError) throw firstError;
	throw new SignatureError(
		`Could not verify the ${kind} code signature: ${errorMessage(firstError ?? "no candidate files")}`,
		{ cause: firstError },
	);
}

function assertOpenAiSignature(kind: string, file: string, signature: SignatureInfo): void {
	if (signature.status !== "Valid") {
		throw new SignatureError(
			`${kind} at ${file} does not have a valid Authenticode signature (status: ${signature.status}). ` +
			"Reinstall the ChatGPT desktop app or update the Codex runtime, then retry. " +
			"If you intentionally use a local build, set verifySignatures to false in config.json.",
		);
	}
	if (!/\bOpenAI\b/i.test(signature.subject)) {
		throw new SignatureError(
			`${kind} at ${file} is signed by an unexpected publisher: ${signature.subject || "(none)"}. ` +
			"Only OpenAI-signed binaries are accepted.",
		);
	}
}

export async function discoverInstallation(config: AppConfig, options: DiscoveryOptions = {}): Promise<Installation> {
	const homeDir = options.homeDir ?? os.homedir();
	const localAppData = options.localAppData ?? defaultLocalAppData(homeDir);
	const warnings: string[] = [];
	const baseCodexHome = config.codexHome || envValue("CODEX_HOME") || defaultCodexHome();
	const toml = await readCodexToml(baseCodexHome);
	if (toml.error) warnings.push(toml.error);
	const codexHome = config.codexHome || toml.env.CODEX_HOME || envValue("CODEX_HOME") || baseCodexHome;
	if (codexHome !== baseCodexHome) {
		warnings.push(`Using CODEX_HOME from the node_repl configuration: ${codexHome}`);
	}
	const appPath = await (options.findApp ?? findChatGptApp)();

	let helperCandidates: Candidate[];
	if (config.helperPath) {
		const mtimeMs = await mtimeOf(config.helperPath, true);
		if (mtimeMs === undefined) {
			throw new DiscoveryError(`Configured helperPath does not exist: ${config.helperPath}`);
		}
		helperCandidates = [{ path: config.helperPath, mtimeMs }];
	} else {
		helperCandidates = dedupeCandidates([
			...(await collectModuleDirHelpers(toml.env.NODE_REPL_NODE_MODULE_DIRS)),
			...(await collectRuntimeHelpers(localAppData)),
			...appHelperCandidate(appPath),
		]);
	}

	let codexCandidates: Candidate[];
	if (config.codexPath) {
		const mtimeMs = await mtimeOf(config.codexPath, true);
		if (mtimeMs === undefined) {
			throw new DiscoveryError(`Configured codexPath does not exist: ${config.codexPath}`);
		}
		codexCandidates = [{ path: config.codexPath, mtimeMs }];
	} else {
		const configured = toml.env.CODEX_CLI_PATH;
		const configuredCandidates: Candidate[] = [];
		if (configured) {
			const mtimeMs = await mtimeOf(configured);
			if (mtimeMs !== undefined) configuredCandidates.push({ path: configured, mtimeMs });
			else warnings.push(`CODEX_CLI_PATH points to a missing file: ${configured}`);
		}
		codexCandidates = dedupeCandidates([
			...configuredCandidates,
			...(await collectCodexBinaries(localAppData)),
			...appCodexCandidate(appPath),
			...(await (options.pathCodex ?? collectPathCodex)()),
		]);
	}

	if (helperCandidates.length === 0) {
		throw new DiscoveryError(
			"Cannot find OpenAI's signed Computer Use helper (codex-computer-use.exe).\n" +
			"Install or update the ChatGPT desktop app, open it once, and make sure Codex is signed in.\n" +
			"Searched:\n" +
			`- ${path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node")}\\*\\${path.join("bin", "node_modules", "@oai", "sky", "bin", "windows")}\\codex-computer-use.exe\n` +
			`- NODE_REPL_NODE_MODULE_DIRS from ${toml.path}\n` +
			"- the ChatGPT app bundle\n" +
			"You can also set helperPath in config.json.",
		);
	}
	if (codexCandidates.length === 0) {
		throw new DiscoveryError(
			"Cannot find the signed Codex CLI (codex.exe), which the helper uses to authenticate.\n" +
			"Open the ChatGPT desktop app or Codex and sign in, then retry.\n" +
			`Searched ${path.join(localAppData, "OpenAI", "Codex", "bin")}, the ChatGPT app bundle, CODEX_CLI_PATH, and PATH.\n` +
			"You can also set codexPath in config.json.",
		);
	}

	let helper: Candidate;
	let codex: Candidate;
	let helperSignature: SignatureInfo | undefined;
	let codexSignature: SignatureInfo | undefined;
	if (config.verifySignatures) {
		const verifyFile = options.verifyFile ?? verifyAuthenticode;
		const verifiedHelper = await chooseVerified("Computer Use helper", helperCandidates, verifyFile);
		helper = verifiedHelper.candidate;
		helperSignature = verifiedHelper.signature;
		const verifiedCodex = await chooseVerified("Codex CLI", codexCandidates, verifyFile);
		codex = verifiedCodex.candidate;
		codexSignature = verifiedCodex.signature;
	} else {
		helper = pickNewest(helperCandidates)!;
		codex = pickNewest(codexCandidates)!;
		warnings.push("Signature verification is disabled in config.json. Only run binaries you trust.");
	}

	if (!existsSync(path.join(codexHome, "auth.json"))) {
		warnings.push(`No auth.json in ${codexHome}. Open the ChatGPT desktop app or Codex and sign in before using Computer Use.`);
	}
	if (!toml.found) {
		warnings.push(`No Codex config.toml at ${toml.path}. Helper discovery used the installed runtime directly.`);
	}
	if (helperCandidates.length > 1 && !config.helperPath) {
		warnings.push(`Multiple Computer Use runtimes found; using: ${helper.path}`);
	}

	return {
		helperPath: helper.path,
		codexPath: codex.path,
		codexHome,
		configTomlPath: toml.path,
		chatGptAppPath: appPath,
		helperSignature,
		codexSignature,
		warnings,
	};
}
