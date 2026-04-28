/**
 * Path utilities for VSCode mock storage
 */

import * as fs from "fs"
import * as path from "path"

const STORAGE_BASE_DIR = ".vscode-mock"

/**
 * Get the base storage directory
 */
function getBaseStorageDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "."
	return path.join(homeDir, STORAGE_BASE_DIR)
}

/**
 * Hash a workspace path to create a unique directory name
 *
 * @param workspacePath - The workspace path to hash
 * @returns A hexadecimal hash string
 */
function hashString(s: string): string {
	let hash = 0
	for (let i = 0; i < s.length; i++) {
		const char = s.charCodeAt(i)
		hash = (hash << 5) - hash + char
		hash = hash & hash // Convert to 32-bit integer
	}
	return Math.abs(hash).toString(16)
}

export function hashWorkspacePath(workspacePath: string): string {
	return hashString(workspacePath)
}

/**
 * Stable hash for multi-root workspace storage (ordered folder list, extension parity).
 */
export function hashWorkspacePaths(orderedRoots: readonly string[]): string {
	if (orderedRoots.length === 0) {
		return hashString("")
	}
	if (orderedRoots.length === 1) {
		return hashString(orderedRoots[0]!)
	}
	return hashString(orderedRoots.join("\0"))
}

/**
 * CLI / VS Code multi-root: resolve each entry to an absolute normalized path, skip empties,
 * dedupe preserving first occurrence order (parity with ordered workspace folders).
 */
export function normalizeOrderedWorkspaceRoots(paths: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of paths) {
		const trimmed = String(raw).trim()
		if (!trimmed) {
			continue
		}
		const p = path.normalize(path.resolve(trimmed))
		if (!p || seen.has(p)) {
			continue
		}
		seen.add(p)
		out.push(p)
	}
	return out
}

/**
 * Ensure a directory exists, creating it if necessary
 *
 * @param dirPath - The directory path to ensure exists
 */
export function ensureDirectoryExists(dirPath: string): void {
	try {
		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true })
		}
	} catch (error) {
		console.warn(`Failed to create directory ${dirPath}:`, error)
	}
}

/**
 * Initialize workspace directories
 */
export function initializeWorkspace(workspacePath: string): void {
	const dirs = [getGlobalStorageDir(), getWorkspaceStorageDir(workspacePath), getLogsDir()]

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true })
		}
	}
}

/**
 * Get global storage directory
 */
export function getGlobalStorageDir(): string {
	return path.join(getBaseStorageDir(), "global-storage")
}

/**
 * Get workspace-specific storage directory
 */
export function getWorkspaceStorageDir(workspacePath: string): string {
	const hash = hashWorkspacePath(workspacePath)
	return path.join(getBaseStorageDir(), "workspace-storage", hash)
}

/**
 * Get logs directory
 */
export function getLogsDir(): string {
	return path.join(getBaseStorageDir(), "logs")
}

export const VSCodeMockPaths = {
	initializeWorkspace,
	getGlobalStorageDir,
	getWorkspaceStorageDir,
	getLogsDir,
}
