export type ArchiveKind = "zip" | "tar" | "rar" | "unknown"

/** Folder name (single segment) for extracting a workspace-root archive next to the file. */
export function defaultExtractDestinationFolderName(filename: string): string {
	const lower = filename.toLowerCase()
	let base: string
	if (lower.endsWith(".tar.gz")) {
		base = filename.slice(0, -".tar.gz".length)
	} else if (lower.endsWith(".tgz")) {
		base = filename.slice(0, -".tgz".length)
	} else if (lower.endsWith(".tar")) {
		base = filename.slice(0, -".tar".length)
	} else if (lower.endsWith(".zip")) {
		base = filename.slice(0, -".zip".length)
	} else if (lower.endsWith(".rar")) {
		base = filename.slice(0, -".rar".length)
	} else {
		base = filename
	}
	const trimmed = base.trim()
	return trimmed || "extracted"
}

export function detectArchiveKind(filePath: string): ArchiveKind {
	const lower = filePath.replace(/\\/g, "/").toLowerCase()
	if (lower.endsWith(".zip")) {
		return "zip"
	}
	if (lower.endsWith(".rar")) {
		return "rar"
	}
	if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
		return "tar"
	}
	if (lower.endsWith(".tar")) {
		return "tar"
	}
	return "unknown"
}
