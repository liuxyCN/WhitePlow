import fs from "fs/promises"
import path from "path"

/**
 * List workspace-relative paths (posix-style) for files under destAbs, capped at maxFiles.
 */
export async function collectExtractedRelFiles(
	destAbs: string,
	destWorkspaceRel: string,
	maxFiles: number,
): Promise<string[]> {
	const out: string[] = []

	async function walk(absDir: string, relFromDest: string): Promise<void> {
		let entries
		try {
			entries = await fs.readdir(absDir, { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			if (out.length >= maxFiles) {
				return
			}
			const childAbs = path.join(absDir, e.name)
			const childRel = relFromDest ? `${relFromDest}/${e.name}` : e.name
			if (e.isDirectory()) {
				await walk(childAbs, childRel)
			} else if (e.isFile()) {
				out.push(path.join(destWorkspaceRel, childRel).split(path.sep).join("/"))
			}
		}
	}

	await walk(destAbs, "")
	return out
}
