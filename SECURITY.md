# Security

This document describes the security model and known limitations of
`codex-computer-use-mcp-win`. It is an unofficial Windows port and is provided
under the MIT License, without warranty.

## What this server can do

When enabled, the server can:

- enumerate installed and running Windows apps and their windows;
- capture screenshots and UI Automation text from windows;
- activate windows, launch `.exe` files, click, type, scroll, drag, and send
  key chords through OpenAI's signed Computer Use helper;
- run JavaScript supplied by the MCP client inside a worker-thread sandbox;
- spawn and terminate the signed helper and its Codex CLI child;
- read the Codex state directory path and existence of `auth.json` (it does not
  read the file), and parse `config.toml` for three `node_repl` transport keys.

The user sees every action on the real foreground desktop. This is remote
control of the signed-in user's session, not a virtual desktop.

## Trust boundaries

1. **The MCP client and its model are trusted to decide actions.** A
   prompt-injected or malicious agent can ask for any action the user's Windows
   account can perform, subject to the controls below. Do not connect this
   server to an agent that reads untrusted web content without additional
   safeguards.
2. **Target applications are untrusted.** Window titles, accessibility text,
   display names, and screenshots can contain attacker-controlled text. Treat
   all of it as data, never as instructions.
3. **The OpenAI helper and Codex CLI are trusted only after Authenticode
   verification.** The default verifier requires a `Valid` signature whose
   subject contains `OpenAI`, and records a SHA-256. The helper is spawned from
   the installed runtime, with a minimal environment.
4. **The JavaScript sandbox is a guardrail, not a security boundary.** Node's
   `vm` module is explicitly not a security mechanism. The worker blocks Node
   globals, `eval`, `Function`, `import()`, `Buffer`, `fetch`, and
   `SharedArrayBuffer`, marshals RPC failures as primitive strings so host-realm
   constructors do not cross into the context, disables custom inspect hooks,
   and locks `Error.prepareStackTrace`. The worker still shares the server
   process id and file descriptors, and JavaScript can allocate memory up to the
   worker resource limits. A determined escape should be assumed possible. Run
   the server under a dedicated account and treat `js` as code execution by a
   trusted agent. The helper approval gate and the Windows account remain the
   real controls.

## Controls

### Binary discovery and signatures

- The helper and Codex CLI are discovered from installed, user-writable OpenAI
  runtime directories, the ChatGPT app bundle, and explicit configuration.
- With `verifySignatures: true` (default), `Get-AuthenticodeSignature` must
  return `Valid`, and the signer subject must contain `OpenAI`.
- The newest candidate that passes verification is selected; older valid
  runtimes are used if a newer one fails.
- SHA-256 hashes and versions are exposed in `computer_use_status`.
- Symlinked runtime candidates are ignored. Explicit `helperPath` /
  `codexPath` overrides are allowed (the signature check still applies).
- No OpenAI binary is bundled or redistributed. The server calls the local
  installation only.
- If `verifySignatures` is disabled, status emits a warning. Use this only for
  builds you control.

### Environment isolation

The helper receives a minimal environment allow-list: Windows system paths,
user profile / app data / temp directories, locale-neutral identity variables,
`COMSPEC`/`PATHEXT`, and the required `CODEX_HOME`, `CODEX_CLI_PATH`,
`SKY_CUA_NATIVE_PIPE=0`, and `SKY_ENABLE_AUDIO=0`. It does not inherit
`NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, provider API keys, cloud credentials,
proxy passwords, or arbitrary parent-process variables.

The helper can still read `CODEX_HOME` because it needs Codex authentication.
That directory may contain `auth.json` and other secrets. The server itself
never reads `auth.json` and only extracts `CODEX_CLI_PATH`, `CODEX_HOME`, and
`NODE_REPL_NODE_MODULE_DIRS` from `config.toml`.

The default is the real Codex home, so the helper shares ChatGPT's state. The
signed helper may create its own state/sqlite files and maintain a
`notify = [... "turn-ended"]` hook in `config.toml`, as it does when ChatGPT
launches it. That also means Codex's own turn-ended notifications can reach the
helper. This port deliberately does not copy `auth.json` into an isolated
temporary home: copying refresh tokens would duplicate credentials and violate
the server's rule of never reading `auth.json`. If shared Codex state is
unacceptable, run the server under a dedicated Windows user or VM and sign in
there. Fixing the turn-ended condition requires restarting the server or waiting
for the idle timeout; the port does not implement Codex turn metadata or
`end_turn`.

### App approval and deny lists

- `approval: "deny"` refuses every app.
- `approval: "mcp"` asks the MCP client through an elicitation form. The form
  accepts only an explicit `approve: true`; decline, cancel, malformed output,
  timeout, or a client without elicitation follows `elicitationFallback`
  (`auto` or `deny`). For a fail-closed setup use
  `"approval": "mcp", "elicitationFallback": "deny"`.
- `approval: "auto"` approves any app that is not denied. This is the
  upstream-compatible default and is convenient for trusted local automation,
  but it is not an action-level safety gate.
- Deny checks run before prompts. Deny always wins over an allow list.
- Matching normalizes `process:` prefixes and package suffixes, lowercases,
  and compares full paths, basenames, executable stems, and display names.
  Display names are untrusted and may be spoofed; the elicitation message also
  includes the app id and risk level.
- The built-in deny list covers terminals and shells, the ChatGPT/Codex control
  plane, password managers, Windows security and administration tools, UAC and
  secure-desktop processes, and remote-control tools. It is a floor, not a
  complete classification of every dangerous app or web page. Browser password
  fields, IDE-integrated terminals, and login forms cannot be reliably
  classified; the tool instructions forbid them, but the model must comply.

### Transport-enforced action limits

- `press_key` rejects the Windows/Super key, `Ctrl+Alt+Del`, `Alt+F4`,
  `Alt+Tab`, `Ctrl+Shift+Esc`, `Ctrl+Esc`, and `Ctrl+Shift+Enter`, and rejects
  control characters in key names.
- `launch_app` accepts an app id or an absolute `.exe` path. URLs, `shell:` and
  `ms-` targets, scripts, shortcuts, installers, UNC/device paths, and relative
  paths are rejected. The deny list still applies to the resulting app id.
- `get_window_state` requires at least one of `include_screenshot` /
  `include_text`; the default is screenshot-only.
- Screenshots over `maxScreenshotBytes` are replaced with an empty URL plus
  `urlOmitted`. Accessibility text is truncated at `maxTextBytes`. The
  JavaScript kernel caps text output, per-image bytes, total image bytes, image
  count, code size, and queued runs.
- Timeouts terminate the worker and kill the helper. Treat the outcome as
  unknown and re-observe before retrying a mutating action; the server does not
  automatically retry clicks, typing, launches, or other actions.

### Audit

`<state>\audit\computer-use.jsonl` is append-only and stores metadata only:
timestamp, run id, method, byte counts, outcome, duration, helper version,
content types, and error code. It never stores JavaScript, typed text,
screenshots, accessibility trees, window titles, approval prompts, or
credentials.

Audit failures are logged but do not mask an action that already ran.

Windows file modes are not POSIX modes. The default state root is under the
per-user `%LOCALAPPDATA%`, which inherits the user's ACLs; the server checks for
symlinks/non-directories but does not install a custom DACL. Other processes
running as the same user (and administrators) can read or tamper with the audit
log. Do not treat it as a tamper-proof security log.

## Known limitations and risks

- **Foreground only.** Actions use the real desktop. A locked workstation,
  UAC secure desktop, Session 0, disconnected RDP session, or elevated target
  can break automation or expose the lock screen.
- **Elevation.** If the MCP client runs elevated, the helper and its actions run
  elevated. Run this server at normal integrity.
- **No action-level confirmation.** App approval does not confirm each click,
  purchase, deletion, message send, or credential entry. The agent is instructed
  to ask the user before destructive or irreversible actions; this is a policy,
  not a technical gate.
- **Session approvals.** Approvals are cached in server memory per exact app id;
  `js_reset` does not clear them. The helper can re-request approval on every
  call, and the server answers with its cached decision. Restart the server to
  clear all approvals.
- **Shared Codex home.** The helper uses the real `CODEX_HOME` by default. It may
  create state files and maintain ChatGPT's `notify` hook there, and Codex's
  turn-ended notifications can terminate the helper's current turn. The server
  does not isolate or copy `auth.json`.
- **No turn lifecycle.** This port does not send Codex turn metadata or
  `end_turn`, and does not track interrupt markers. A physical Escape stop
  surfaces as a helper error; recover by restarting the server or waiting for the
  idle timeout. Do not retry an action after a stop or timeout: its outcome is
  unknown.
- **Screenshots and text are sensitive.** They leave the machine through the MCP
  client and may be logged by the client or model provider. There is no reliable
  pixel redaction.
- **Multiple instances.** Two MCP clients can spawn two servers/helpers and
  fight over focus, cursor, and approvals. There is no global desktop mutex.
- **Undocumented protocol.** The helper protocol is not a stable public API.
  ChatGPT or Codex updates can change or break it.
- **Signature rotation.** Verification accepts any valid OpenAI-signed binary;
  it does not pin a certificate thumbprint or minimum version. Update the
  ChatGPT app to receive fixes.
- **Same-user malware.** A process running as the same user can read the state
  directory, tamper with the audit log, or replace files in user-writable
  runtime directories. Signature verification mitigates replacement of the
  helper/CLI, not same-user surveillance.

## Hardening recommendations

- Use `"approval": "mcp", "elicitationFallback": "deny"` and a narrow
  `allowApps` list when the MCP client supports elicitation.
- Keep the helper and Codex CLI updated and `verifySignatures` enabled.
- Do not run the MCP client or this server elevated.
- Use a dedicated Windows user or VM for sensitive automation.
- Do not connect the server to agents that ingest untrusted web or email content
  without a human review step.
- Review `computer_use_status` warnings and the audit log regularly.
- Remove the state directory when uninstalling if you no longer want local
  configuration and audit history.

## Reporting

Report security issues privately to the maintainer of your copy of this port.
Do not include screenshots, accessibility text, tokens, `auth.json`, or other
personal data in a report. If the issue is in the upstream macOS project,
report it to that project as well.
