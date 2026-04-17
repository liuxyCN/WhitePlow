import path from "path"
import fs from "fs/promises"

import type { ClineSayTool } from "@roo-code/types"
import type { RecordSource } from "../context-tracking/FileContextTrackerTypes"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { collectExtractedRelFiles } from "../../utils/archive/collectExtractedFiles"
import { detectArchiveKind } from "../../utils/archive/detectArchiveKind"
import { extractRarWithExternalTool } from "../../utils/archive/extractRarExternal"
import { extractTarWithLimits } from "../../utils/archive/extractTar"
import { extractZipWithLimits } from "../../utils/archive/extractZip"
import {
	EXTRACT_MAX_ARCHIVE_FILE_BYTES,
	EXTRACT_MAX_TRACKED_FILES,
} from "../../utils/archive/extractLimits"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

export interface ExtractArchiveParams {
	archive_path: string
	destination_path: string
}

function normalizeWorkspaceRelativePath(cwd: string, raw: string, label: string): string {
	const trimmed = raw.trim()
	if (!trimmed) {
		throw new Error(`${label} is required`)
	}
	if (trimmed.includes("\0")) {
		throw new Error(`Invalid ${label}`)
	}
	const abs = path.resolve(cwd, trimmed)
	const relToCwd = path.relative(cwd, abs)
	if (relToCwd.startsWith("..") || path.isAbsolute(relToCwd)) {
		throw new Error(`${label} must stay within the workspace (no .. or absolute paths).`)
	}
	return relToCwd.split(path.sep).join("/")
}

export class ExtractArchiveTool extends BaseTool<"extract_archive"> {
	readonly name = "extract_archive" as const

	async execute(params: ExtractArchiveParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks

		let archiveRel: string
		let destRel: string
		try {
			archiveRel = normalizeWorkspaceRelativePath(task.cwd, params.archive_path ?? "", "archive_path")
			destRel = normalizeWorkspaceRelativePath(task.cwd, params.destination_path ?? "", "destination_path")
		} catch (e) {
			task.consecutiveMistakeCount++
			task.recordToolError("extract_archive")
			pushToolResult(formatResponse.toolError(e instanceof Error ? e.message : "Invalid path."))
			return
		}

		const archiveAccess = task.rooIgnoreController?.validateAccess(archiveRel)
		if (!archiveAccess) {
			await task.say("rooignore_error", archiveRel)
			pushToolResult(formatResponse.rooIgnoreError(archiveRel))
			return
		}

		const destAccess = task.rooIgnoreController?.validateAccess(destRel)
		if (!destAccess) {
			await task.say("rooignore_error", destRel)
			pushToolResult(formatResponse.rooIgnoreError(destRel))
			return
		}

		const archiveAbs = path.resolve(task.cwd, archiveRel)
		const destAbs = path.resolve(task.cwd, destRel)

		const isWriteProtected =
			(task.rooProtectedController?.isWriteProtected(archiveRel) ||
				task.rooProtectedController?.isWriteProtected(destRel)) ||
			false

		const isOutsideWorkspace =
			isPathOutsideWorkspace(archiveAbs) || isPathOutsideWorkspace(destAbs)

		const readableArchive = getReadablePath(task.cwd, archiveRel)
		const readableDest = getReadablePath(task.cwd, destRel)

		const sharedMessageProps: ClineSayTool = {
			tool: "extractArchive",
			path: readableDest,
			archivePath: readableArchive,
			destinationPath: readableDest,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		try {
			task.consecutiveMistakeCount = 0

			let st
			try {
				st = await fs.stat(archiveAbs)
			} catch {
				task.consecutiveMistakeCount++
				task.recordToolError("extract_archive", "Archive not found")
				pushToolResult(formatResponse.toolError(`Archive not found: ${readableArchive}`))
				return
			}

			if (!st.isFile()) {
				task.consecutiveMistakeCount++
				task.recordToolError("extract_archive", "Not a file")
				pushToolResult(formatResponse.toolError(`Not a regular file: ${readableArchive}`))
				return
			}

			if (st.size > EXTRACT_MAX_ARCHIVE_FILE_BYTES) {
				task.consecutiveMistakeCount++
				task.recordToolError("extract_archive", "Archive too large")
				pushToolResult(
					formatResponse.toolError(
						`Archive file is too large (${st.size} bytes, max ${EXTRACT_MAX_ARCHIVE_FILE_BYTES}).`,
					),
				)
				return
			}

			const kind = detectArchiveKind(archiveRel)
			if (kind === "unknown") {
				task.consecutiveMistakeCount++
				task.recordToolError("extract_archive", "Unknown format")
				pushToolResult(
					formatResponse.toolError(
						"Unsupported or unknown archive extension. Use .zip, .tar, .tar.gz, .tgz, or .rar.",
					),
				)
				return
			}

			const approvalMessage = JSON.stringify(sharedMessageProps)
			const didApprove = await askApproval("tool", approvalMessage, undefined, isWriteProtected)
			if (!didApprove) {
				return
			}

			await fs.mkdir(destAbs, { recursive: true })

			if (kind === "zip") {
				await extractZipWithLimits(archiveAbs, destAbs)
			} else if (kind === "tar") {
				await extractTarWithLimits(archiveAbs, destAbs)
			} else {
				await extractRarWithExternalTool(archiveAbs, destAbs)
			}

			const tracked = await collectExtractedRelFiles(destAbs, destRel, EXTRACT_MAX_TRACKED_FILES)
			for (const rel of tracked) {
				const access = task.rooIgnoreController?.validateAccess(rel)
				if (access) {
					await task.fileContextTracker.trackFileContext(rel, "roo_edited" as RecordSource)
				}
			}
			task.didEditFile = tracked.length > 0

			const note =
				tracked.length >= EXTRACT_MAX_TRACKED_FILES
					? ` (tracked first ${EXTRACT_MAX_TRACKED_FILES} files for context)`
					: ""
			pushToolResult(
				formatResponse.toolResult(
					`Extracted ${kind === "rar" ? "rar (external tool)" : kind} archive to ${readableDest}: ${tracked.length} file(s)${note}.`,
				),
			)
		} catch (error) {
			task.consecutiveMistakeCount++
			task.recordToolError("extract_archive", (error as Error)?.message)
			await handleError("extracting archive", error as Error)
		}
	}

	override async handlePartial(_task: Task, _block: ToolUse<"extract_archive">): Promise<void> {
		return
	}
}

export const extractArchiveTool = new ExtractArchiveTool()
