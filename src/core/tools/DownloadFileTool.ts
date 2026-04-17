import path from "path"
import fs from "fs/promises"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import {
	DOWNLOAD_FILE_MAX_BYTES,
	fetchWithSsrfSafeRedirects,
} from "../../utils/downloadUrlSafety"
import {
	defaultExtractDestinationFolderName,
	detectArchiveKind,
} from "../../utils/archive/detectArchiveKind"
import { t } from "../../i18n"
import { extractArchiveTool } from "./ExtractArchiveTool"

export interface DownloadFileParams {
	url: string
	filename: string
}

function formatByteSize(n: number): string {
	if (n < 1024) {
		return `${n} B`
	}
	if (n < 1024 * 1024) {
		return `${(n / 1024).toFixed(1)} KB`
	}
	return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Single-segment filename only; file is always written to the workspace root (task.cwd).
 */
export function assertWorkspaceRootFilename(raw: string): string {
	const name = raw.trim()
	if (!name) {
		throw new Error("filename is required")
	}
	if (name.includes("/") || name.includes("\\")) {
		throw new Error("filename must not contain path separators (downloads are only to the workspace root).")
	}
	if (name.includes("..")) {
		throw new Error("invalid filename")
	}
	if (name === "." || name === "..") {
		throw new Error("invalid filename")
	}
	if (name !== path.basename(name)) {
		throw new Error("filename must be a single path segment")
	}
	return name
}

const PROGRESS_THROTTLE_MS = 400
const PROGRESS_MIN_STEP_BYTES = 512 * 1024

async function readResponseBodyWithLimitAndProgress(
	res: Response,
	maxBytes: number,
	onProgress?: (received: number, total: number | undefined) => void | Promise<void>,
): Promise<Buffer> {
	const cl = res.headers.get("content-length")
	let contentLength: number | undefined
	if (cl) {
		const n = Number(cl)
		if (Number.isFinite(n) && n > maxBytes) {
			throw new Error(`Response too large (Content-Length ${n} bytes, max ${maxBytes} bytes).`)
		}
		if (Number.isFinite(n) && n >= 0) {
			contentLength = n
		}
	}

	const reader = res.body?.getReader()
	if (!reader) {
		const buf = Buffer.from(await res.arrayBuffer())
		if (buf.length > maxBytes) {
			throw new Error(`Response too large (${buf.length} bytes, max ${maxBytes} bytes).`)
		}
		await onProgress?.(buf.length, contentLength)
		return buf
	}

	const chunks: Buffer[] = []
	let received = 0
	let lastEmit = 0
	let lastEmittedBytes = 0

	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		if (value) {
			received += value.byteLength
			if (received > maxBytes) {
				await reader.cancel()
				throw new Error(`Response too large (exceeds ${maxBytes} bytes).`)
			}
			chunks.push(Buffer.from(value))

			if (onProgress) {
				const now = Date.now()
				const deltaBytes = received - lastEmittedBytes
				if (
					now - lastEmit >= PROGRESS_THROTTLE_MS ||
					deltaBytes >= PROGRESS_MIN_STEP_BYTES ||
					received === contentLength
				) {
					await onProgress(received, contentLength)
					lastEmit = now
					lastEmittedBytes = received
				}
			}
		}
	}
	if (onProgress && received !== lastEmittedBytes) {
		await onProgress(received, contentLength)
	}
	return Buffer.concat(chunks)
}

function isToolResponseErrorPayload(text: string): boolean {
	const trimmed = text.trim()
	if (!trimmed.startsWith("{")) {
		return false
	}
	try {
		const o = JSON.parse(trimmed) as { status?: string }
		return o.status === "error"
	} catch {
		return false
	}
}

export class DownloadFileTool extends BaseTool<"download_file"> {
	readonly name = "download_file" as const

	async execute(params: DownloadFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const urlRaw = params.url
		let filename: string

		try {
			filename = assertWorkspaceRootFilename(params.filename ?? "")
		} catch (e) {
			task.consecutiveMistakeCount++
			task.recordToolError("download_file")
			pushToolResult(
				formatResponse.toolError(e instanceof Error ? e.message : "Invalid filename."),
			)
			return
		}

		if (!urlRaw || !urlRaw.trim()) {
			task.consecutiveMistakeCount++
			task.recordToolError("download_file")
			pushToolResult(await task.sayAndCreateMissingParamError("download_file", "url"))
			return
		}

		const relPath = filename
		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false
		const fullPath = path.resolve(task.cwd, relPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

		const readablePath = getReadablePath(task.cwd, relPath)
		const trimmedUrl = urlRaw.trim()

		const sharedMessageProps = {
			tool: "downloadFile" as const,
			path: readablePath,
			url: trimmedUrl,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		let progressRowActive = false

		const pushProgress = async (
			partial: boolean,
			phase: string,
			opts: {
				bytesReceived?: number
				totalBytes?: number
				statusKey: "connecting" | "downloading" | "downloadingOf" | "writing" | "done" | "failed"
			},
		) => {
			const { bytesReceived, totalBytes, statusKey } = opts
			let line: string
			switch (statusKey) {
				case "connecting":
					line = t("tools:downloadFile.progressConnecting")
					break
				case "downloading": {
					const received = formatByteSize(bytesReceived ?? 0)
					line = t("tools:downloadFile.progressDownloading", { received })
					break
				}
				case "downloadingOf": {
					const received = formatByteSize(bytesReceived ?? 0)
					const total = formatByteSize(totalBytes ?? 0)
					const pct =
						totalBytes && totalBytes > 0
							? Math.min(100, Math.floor(((bytesReceived ?? 0) / totalBytes) * 100))
							: 0
					line = t("tools:downloadFile.progressDownloadingOf", {
						received,
						total,
						percent: String(pct),
					})
					break
				}
				case "writing":
					line = t("tools:downloadFile.progressWriting")
					break
				case "done":
					line = t("tools:downloadFile.progressDone")
					break
				case "failed":
					line = t("tools:downloadFile.progressFailed")
					break
				default:
					line = ""
			}

			const icon =
				statusKey === "done" ? "check" : statusKey === "failed" ? "error" : "cloud-download"

			await task.say(
				"tool",
				JSON.stringify({
					tool: "downloadFileProgress",
					path: readablePath,
					url: trimmedUrl,
					phase,
					...(bytesReceived !== undefined ? { bytesReceived } : {}),
					...(totalBytes !== undefined ? { totalBytes } : {}),
				}),
				undefined,
				partial,
				undefined,
				{ icon, text: line },
			)
		}

		try {
			task.consecutiveMistakeCount = 0

			const approvalMessage = JSON.stringify(sharedMessageProps)
			const didApprove = await askApproval("tool", approvalMessage, undefined, isWriteProtected)
			if (!didApprove) {
				return
			}

			await pushProgress(true, "connecting", { statusKey: "connecting" })
			progressRowActive = true

			const res = await fetchWithSsrfSafeRedirects(trimmedUrl, {
				method: "GET",
				headers: { Accept: "*/*" },
				timeoutMs: 120_000,
			})

			if (!res.ok) {
				await pushProgress(false, "error", { statusKey: "failed" })
				progressRowActive = false
				const errText = `Download failed: HTTP ${res.status} ${res.statusText}`
				task.consecutiveMistakeCount++
				task.recordToolError("download_file", errText)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(errText))
				return
			}

			const cl = res.headers.get("content-length")
			const totalFromHeader = cl && Number.isFinite(Number(cl)) ? Number(cl) : undefined

			const buffer = await readResponseBodyWithLimitAndProgress(
				res,
				DOWNLOAD_FILE_MAX_BYTES,
				async (received, total) => {
					await pushProgress(true, "downloading", {
						bytesReceived: received,
						totalBytes: total,
						statusKey:
							total !== undefined && total > 0 ? "downloadingOf" : "downloading",
					})
				},
			)

			await pushProgress(true, "writing", { statusKey: "writing" })
			await fs.writeFile(fullPath, buffer)

			await pushProgress(false, "done", { statusKey: "done", bytesReceived: buffer.length, totalBytes: totalFromHeader })
			progressRowActive = false

			await task.fileContextTracker.trackFileContext(relPath, "roo_edited")
			task.didEditFile = true

			if (detectArchiveKind(relPath) !== "unknown") {
				const destFolder = defaultExtractDestinationFolderName(filename)
				const readableDest = getReadablePath(task.cwd, destFolder)

				const pushExtractProgress = async (
					partial: boolean,
					phase: string,
					statusKey: "extracting" | "done" | "failed",
				) => {
					let line: string
					switch (statusKey) {
						case "extracting":
							line = t("tools:extractArchive.progressExtracting")
							break
						case "done":
							line = t("tools:extractArchive.progressDone")
							break
						case "failed":
							line = t("tools:extractArchive.progressFailed")
							break
					}
					const icon =
						statusKey === "done" ? "check" : statusKey === "failed" ? "error" : "package"

					await task.say(
						"tool",
						JSON.stringify({
							tool: "extractArchiveProgress",
							path: readableDest,
							archivePath: readablePath,
							destinationPath: readableDest,
							phase,
						}),
						undefined,
						partial,
						undefined,
						{ icon, text: line },
					)
				}

				await pushExtractProgress(true, "extracting", "extracting")

				let extractEmittedViaPush = false
				let capturedExtractText: string | undefined
				await extractArchiveTool.execute(
					{ archive_path: relPath, destination_path: destFolder },
					task,
					{
						...callbacks,
						askApproval: async () => true,
						pushToolResult: (msg) => {
							extractEmittedViaPush = true
							capturedExtractText = typeof msg === "string" ? msg : undefined
						},
						handleError: async (action, err) => {
							extractEmittedViaPush = true
							await callbacks.handleError(action, err)
						},
					},
				)

				if (extractEmittedViaPush) {
					if (capturedExtractText !== undefined) {
						if (isToolResponseErrorPayload(capturedExtractText)) {
							await pushExtractProgress(false, "error", "failed")
						} else {
							await pushExtractProgress(false, "done", "done")
						}
						pushToolResult(
							formatResponse.toolResult(
								`Downloaded ${readablePath}. ${capturedExtractText}`,
							),
						)
					} else {
						await pushExtractProgress(false, "error", "failed")
					}
				} else {
					await pushExtractProgress(false, "error", "failed")
					pushToolResult(formatResponse.toolResult(readablePath))
				}
			} else {
				pushToolResult(formatResponse.toolResult(readablePath))
			}
		} catch (error) {
			if (progressRowActive) {
				try {
					await pushProgress(false, "error", { statusKey: "failed" })
				} catch {
					// best-effort close progress row
				}
				progressRowActive = false
			}
			task.consecutiveMistakeCount++
			task.recordToolError("download_file", (error as Error)?.message)
			await handleError("downloading file", error as Error)
		}
	}

	override async handlePartial(_task: Task, _block: ToolUse<"download_file">): Promise<void> {
		return
	}
}

export const downloadFileTool = new DownloadFileTool()
