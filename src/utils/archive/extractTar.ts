import * as tar from "tar"
import type { ReadEntry } from "tar"

import {
	EXTRACT_MAX_ENTRY_COUNT,
	EXTRACT_MAX_SINGLE_ENTRY_BYTES,
	EXTRACT_MAX_TOTAL_UNCOMPRESSED_BYTES,
} from "./extractLimits"

function isReadEntry(entry: ReadEntry | import("node:fs").Stats): entry is ReadEntry {
	return typeof (entry as ReadEntry).type === "string" && "header" in (entry as ReadEntry)
}

/**
 * Extract .tar / .tar.gz / .tgz using node-tar with symlink/hardlink entries skipped.
 */
export async function extractTarWithLimits(archivePath: string, destDir: string): Promise<void> {
	let entryCount = 0
	let totalDeclared = 0

	await tar.x({
		file: archivePath,
		cwd: destDir,
		strict: true,
		filter: (pathStr: string, entry: ReadEntry | import("node:fs").Stats) => {
			if (!isReadEntry(entry)) {
				return true
			}
			if (entry.type === "SymbolicLink" || entry.type === "Link") {
				return false
			}
			entryCount++
			if (entryCount > EXTRACT_MAX_ENTRY_COUNT) {
				throw new Error(
					`Archive has too many entries (>${EXTRACT_MAX_ENTRY_COUNT}). Refusing to extract further.`,
				)
			}
			const size = entry.size ?? 0
			if (size > EXTRACT_MAX_SINGLE_ENTRY_BYTES) {
				throw new Error(
					`Archive entry "${pathStr}" is too large (${size} bytes, max ${EXTRACT_MAX_SINGLE_ENTRY_BYTES}).`,
				)
			}
			totalDeclared += size
			if (totalDeclared > EXTRACT_MAX_TOTAL_UNCOMPRESSED_BYTES) {
				throw new Error(
					`Archive total uncompressed size exceeds limit (${EXTRACT_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes).`,
				)
			}
			return true
		},
	})
}
