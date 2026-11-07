import { readFileSync } from "node:fs";

function readVersion(): string {
	try {
		const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
		return typeof metadata.version === "string" ? metadata.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export const PACKAGE_VERSION = readVersion();
