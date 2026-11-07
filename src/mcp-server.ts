#!/usr/bin/env node
import { Server, type ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { requestApprovalFromMcpClient } from "./mcp-elicitation.ts";
import { ComputerUseSession } from "./session.ts";
import {
	CUA_TOOL_DEFINITIONS,
	SERVER_INSTRUCTIONS,
	STATUS_TOOL_DEFINITION,
	isCuaReplTool,
	type CuaReplTool,
	type JsonObject,
} from "./tools.ts";
import { PACKAGE_VERSION } from "./version.ts";

const USAGE = `Usage: codex-computer-use-mcp-win [--status | --version | --help]

Runs a stdio MCP server that exposes OpenAI's signed Windows Computer Use
helper through a persistent, sandboxed JavaScript session.

Environment:
  CODEX_COMPUTER_USE_HOME  state directory (default: %LOCALAPPDATA%\\codex-computer-use-mcp-win)
  CODEX_HOME               Codex state directory (default: ~/.codex)

Configuration: <state>/config.json
  approval              "auto" | "mcp" | "deny" (default: auto)
  elicitationFallback   "auto" | "deny" (default: auto)
  verifySignatures      boolean (default: true)
  denyApps / allowApps  extra app patterns
  helperPath / codexPath / codexHome
  helperTimeoutMs / sessionIdleMs / maxScreenshotBytes / maxTextBytes
`;

function printAndExit(text: string, code = 0): void {
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`, () => process.exit(code));
}

async function printStatus(): Promise<void> {
	const session = new ComputerUseSession();
	const status = await session.status();
	await session.close().catch(() => undefined);
	printAndExit(JSON.stringify(status, null, 2), 0);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length > 0) {
		if (args.length === 1 && args[0] === "--status") {
			await printStatus();
			return;
		}
		if (args.length === 1 && args[0] === "--version") {
			printAndExit(PACKAGE_VERSION);
			return;
		}
		if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
			printAndExit(USAGE);
			return;
		}
		console.error(USAGE);
		process.exit(1);
	}

	const serverOptions: ServerOptions = {
		capabilities: { tools: {} },
		instructions: SERVER_INSTRUCTIONS,
	};
	const server = new Server(
		{ name: "codex-computer-use-mcp-win", version: PACKAGE_VERSION },
		serverOptions,
	);
	const session = new ComputerUseSession({
		onElicitation: (request, options) => requestApprovalFromMcpClient(
			{ elicitInput: (params, requestOptions) => server.elicitInput(params, requestOptions) },
			request,
			options?.signal,
		),
	});
	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		await session.close().catch((error) => {
			console.error(`[computer-use] close failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	server.onclose = () => { void close(); };

	server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
		tools: [...CUA_TOOL_DEFINITIONS, STATUS_TOOL_DEFINITION],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
		const name = request.params.name;
		if (name === STATUS_TOOL_DEFINITION.name) {
			const status = await session.status();
			return {
				content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
				structuredContent: status as unknown as Record<string, unknown>,
			};
		}
		if (!isCuaReplTool(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
		try {
			const args = z.record(z.string(), z.json()).parse(request.params.arguments ?? {}) as JsonObject;
			const response = await session.execute(name as CuaReplTool, args, { signal: extra.signal });
			const result: CallToolResult = {
				content: response.content as CallToolResult["content"],
				isError: response.isError,
			};
			if (response.structuredContent) result.structuredContent = response.structuredContent;
			return result;
		} catch (error) {
			return {
				content: [{ type: "text", text: error instanceof Error ? error.message : "Computer Use failed" }],
				isError: true,
			};
		}
	});

	const shutdown = (signal: string): void => {
		console.error(`[computer-use] received ${signal}; closing`);
		void close().finally(() => process.exit(0));
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
	process.once("SIGBREAK", () => shutdown("SIGBREAK"));

	await server.connect(new StdioServerTransport());
}

await main();
