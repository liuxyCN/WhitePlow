import path from "path"
import os from "os"

const CLI_USER_ID_MAX = 256
const SAFE_CLI_USER_ID = /^[a-zA-Z0-9_-]+$/

/**
 * Validates a tenant/user id for use in storage paths (no traversal, portable segment).
 */
export function parseCliUserId(raw: string | undefined): string | null {
	if (raw === undefined) {
		return null
	}

	const t = raw.trim()
	if (!t || t.length > CLI_USER_ID_MAX) {
		return null
	}

	if (!SAFE_CLI_USER_ID.test(t)) {
		return null
	}

	return t
}

/** Root directory for per-user CLI storage; override with ROO_CLI_STORAGE_ROOT. */
export function resolveCliUserStorageRootDir(): string {
	const fromEnv = process.env.ROO_CLI_STORAGE_ROOT?.trim()
	if (fromEnv) {
		return path.resolve(fromEnv)
	}

	return path.join(os.homedir(), "neontractor-storage")
}

/** Absolute base storage dir for one CLI user id (under {@link resolveCliUserStorageRootDir}). */
export function resolveCliUserStorageDir(userId: string): string {
	return path.join(resolveCliUserStorageRootDir(), userId)
}
