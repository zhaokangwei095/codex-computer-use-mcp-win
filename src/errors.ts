export type CuaErrorCode =
	| "DISCOVERY_FAILED"
	| "SIGNATURE_INVALID"
	| "HELPER_START_FAILED"
	| "HELPER_EXITED"
	| "HELPER_TIMEOUT"
	| "HELPER_ERROR"
	| "APPROVAL_DENIED"
	| "APP_BLOCKED"
	| "JS_TIMEOUT"
	| "JS_ERROR"
	| "CONFIG_ERROR";

export class CuaError extends Error {
	readonly code: CuaErrorCode;

	constructor(code: CuaErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CuaError";
		this.code = code;
	}
}

export class DiscoveryError extends CuaError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("DISCOVERY_FAILED", message, options);
		this.name = "DiscoveryError";
	}
}

export class SignatureError extends CuaError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("SIGNATURE_INVALID", message, options);
		this.name = "SignatureError";
	}
}

export class HelperError extends CuaError {
	readonly helperMethod?: string;

	constructor(code: CuaErrorCode, message: string, options?: { cause?: unknown; helperMethod?: string }) {
		super(code, message, options);
		this.name = "HelperError";
		this.helperMethod = options?.helperMethod;
	}
}

export class ApprovalDeniedError extends CuaError {
	readonly app: string;
	readonly displayName: string;

	constructor(app: string, displayName: string, reason: string) {
		super("APPROVAL_DENIED", `Computer Use was not approved for ${displayName || app}: ${reason}`);
		this.name = "ApprovalDeniedError";
		this.app = app;
		this.displayName = displayName;
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function errorStack(error: unknown): string | undefined {
	return error instanceof Error ? error.stack : undefined;
}
