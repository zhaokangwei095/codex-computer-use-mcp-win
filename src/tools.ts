import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

export const CUA_REPL_TOOLS = ["js", "js_reset"] as const;
export type CuaReplTool = typeof CUA_REPL_TOOLS[number];
const cuaReplToolSchema = z.enum(CUA_REPL_TOOLS);

export function isCuaReplTool(value: string): value is CuaReplTool {
	return cuaReplToolSchema.safeParse(value).success;
}

export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint?: boolean;
		openWorldHint: boolean;
	};
}

export const CUA_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "js",
		title: "Computer Use",
		description:
			"Run JavaScript in a persistent Computer Use worker with a vm guardrail. The session exposes `sky` (OpenAI's Windows Computer Use API: list_apps, list_windows, get_window_state, click, press_key, type_text, scroll, set_value, drag, perform_secondary_action, activate_window, launch_app) and `cua` (a compatibility facade: `await cua.getApp(\"Notepad\")`). Top-level await works, and top-level let/const/function/class bindings survive between calls. Use `nodeRepl.write(...)` to return text and `nodeRepl.emitImage(...)` to return an image. Timeouts reset the session. Node APIs, eval, Function, and import() are blocked. The worker shares the server process id and file descriptors, so this is a guardrail against accidental Node access, not a security boundary for untrusted code.",
		inputSchema: {
			type: "object",
			properties: {
				code: {
					type: "string",
					description: "JavaScript to execute in the Computer Use session.",
				},
				timeout_ms: {
					type: "integer",
					minimum: 1,
					maximum: 600_000,
					description: "Optional execution timeout in milliseconds. Defaults to 30000 (30 seconds).",
				},
				title: {
					type: "string",
					minLength: 1,
					maxLength: 80,
					description: "Optional short title shown by some clients for this execution.",
				},
				completion_summary: {
					type: "string",
					minLength: 1,
					maxLength: 80,
					description: "Optional one-line summary of what the execution did.",
				},
			},
			required: ["code"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
	},
	{
		name: "js_reset",
		title: "Computer Use reset",
		description: "Reset the persistent Computer Use JavaScript session. All JavaScript bindings are discarded. The helper's per-app approval cache may survive.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
];

export const STATUS_TOOL_DEFINITION: ToolDefinition = {
	name: "computer_use_status",
	title: "Computer Use Status",
	description: "Show Computer Use discovery, helper, approval, and session status.",
	inputSchema: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const SERVER_INSTRUCTIONS = `This server controls native Windows applications through OpenAI's signed Computer Use helper. It uses UI Automation, SendInput, and Windows Graphics Capture on the real foreground desktop: the user sees every click, key, and scroll.

The tools run JavaScript in a persistent worker with a vm guardrail (Node APIs are blocked, but this is not a security boundary for untrusted code). The globals are:
- sky: OpenAI's Windows Computer Use API.
- cua: a small compatibility facade for code written against the macOS runtime.
- nodeRepl: write(text), emitImage(dataUrl), cwd, homeDir, tmpDir.

Start by inspecting, not acting:
  const apps = await sky.list_apps();
  const windows = await sky.list_windows();
  nodeRepl.write(JSON.stringify(windows, null, 2));

Or use the facade:
  const app = await cua.getApp("Notepad");
  const state = await app.getAXState();
  nodeRepl.write(state.accessibility.tree);
  await app.click(12);
  await app.typeText("hello");
  await app.pressKey("Return");

sky API (all methods return Promises):
- sky.list_apps(): running and installed apps.
- sky.list_windows(): open windows as { app, id, title }.
- sky.get_window({ id, app? }): refresh one window descriptor.
- sky.get_window_state({ window, include_screenshot?, include_text? }): returns { window, accessibility, screenshots }. At least one include flag must be true. The default is screenshot only. Screenshots are also emitted automatically as images.
- sky.activate_window({ window }).
- sky.launch_app({ app }): app id, display name, or executable path.
- sky.click({ window, element_index } | { window, x, y }): prefer element_index from the latest state. Optional click_count and mouse_button.
- sky.press_key({ window, key }): X keysym-style names, e.g. "Return", "Tab", "Control_L+c" (the helper splits on "+").
- sky.type_text({ window, text }): literal text.
- sky.scroll({ window, x, y, scrollX, scrollY }).
- sky.set_value({ window, element_index, value }).
- sky.drag({ window, from_x, from_y, to_x, to_y }).
- sky.perform_secondary_action({ window, element_index, action }).

Element indexes are valid only for the most recent state of that window. Inspect again after any action that changes the UI. Prefer element indexes over coordinates. Keep the target window in the foreground.

Privacy: screenshots and accessibility text can contain passwords, one-time codes, private messages, and other sensitive data. They are returned to your MCP client and may be logged by it. Capture only the windows you need, avoid password managers and authentication surfaces, and do not persist this content.

Safety rules enforced by this server:
- Terminals, shells, security tools, password managers, Windows security dialogs, remote-control tools, and the ChatGPT/Codex control plane are denied. Do not try to work around the deny list.
- Do not press the Windows key, Ctrl+Alt+Del, Alt+F4, Alt+Tab, Ctrl+Shift+Enter, or other system-level shortcuts.
- Do not enter credentials, handle authentication prompts, or accept security dialogs. Stop and ask the user.
- Do not automate destructive or irreversible actions (purchases, deletions, sending messages) without the user's explicit confirmation.
- launch_app accepts an app id or an absolute .exe path. Scripts, shortcuts, installers, URLs, UNC paths, and shell targets are blocked.
- In the default "auto" approval mode, apps that are not on the deny list can be controlled without a separate prompt. The user can switch to "mcp" or "deny" in config.json.

Execution:
- 'js' defaults to a 30 second timeout. A timed-out execution terminates the worker and loses its bindings. Its outcome is unknown; re-observe before retrying any action.
- Use short polls rather than one long sleep. 'js_reset' clears bindings.
- Errors are returned as tool errors with the helper's message. If discovery or authentication fails, run 'computer_use_status' and show the user the recovery hint.`;
