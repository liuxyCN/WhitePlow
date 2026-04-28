import fs from "fs"
import path from "path"

export function parseAllowlistFromEnv(): string[] | undefined {
	const raw = process.env.ROO_WORKSPACE_ALLOWLIST?.trim()
	if (!raw) {
		return undefined
	}

	const parts = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
	return parts.length ? parts.map((p) => path.resolve(p)) : undefined
}

export function isPathUnderPrefixes(absRealPath: string, prefixes: string[]): boolean {
	for (const prefix of prefixes) {
		const rp = path.resolve(prefix)
		if (absRealPath === rp || absRealPath.startsWith(rp + path.sep)) {
			return true
		}
	}

	return false
}

export function validateWorkspacePath(
	rawWorkspace: string,
	cwd: string,
	allowlistPrefixes: string[] | undefined,
): { ok: true; absPath: string } | { ok: false; error: string } {
	const trimmed = rawWorkspace.trim()
	if (!trimmed) {
		return { ok: false, error: "workspace is required" }
	}

	const resolved = path.resolve(cwd, trimmed)

	let real: string
	try {
		real = fs.realpathSync(resolved)
	} catch {
		return { ok: false, error: "workspace path does not exist or is not accessible" }
	}

	let st: fs.Stats
	try {
		st = fs.statSync(real)
	} catch {
		return { ok: false, error: "workspace path is not readable" }
	}

	if (!st.isDirectory()) {
		return { ok: false, error: "workspace must be a directory" }
	}

	if (allowlistPrefixes?.length && !isPathUnderPrefixes(real, allowlistPrefixes)) {
		return { ok: false, error: "workspace is outside ROO_WORKSPACE_ALLOWLIST" }
	}

	return { ok: true, absPath: real }
}
