import { readFile } from "fs/promises"
import { createHash } from "crypto"
import * as path from "path"
import { Node } from "web-tree-sitter"
import { LanguageParser, loadRequiredLanguageParsers } from "../../tree-sitter/languageParser"
import { parseMarkdown } from "../../tree-sitter/markdownParser"
import { ICodeParser, CodeBlock } from "../interfaces"
import { scannerExtensions, shouldUseFallbackChunking } from "../shared/supported-extensions"
import {
	MAX_BLOCK_CHARS,
	MAX_TABLE_BLOCK_CHARS,
	MAX_FENCED_CODE_BLOCK_CHARS,
	MIN_BLOCK_CHARS,
	MIN_CHUNK_REMAINDER_CHARS,
	MAX_CHARS_TOLERANCE_FACTOR,
} from "../constants"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import { sanitizeErrorMessage } from "../shared/validation-helpers"

/**
 * Implementation of the code parser interface
 */
export class CodeParser implements ICodeParser {
	private loadedParsers: LanguageParser = {}
	private pendingLoads: Map<string, Promise<LanguageParser>> = new Map()
	// Markdown files are now supported using the custom markdown parser
	// which extracts headers and sections for semantic indexing

	/**
	 * Parses a code file into code blocks
	 * @param filePath Path to the file to parse
	 * @param options Optional parsing options
	 * @returns Promise resolving to array of code blocks
	 */
	async parseFile(
		filePath: string,
		options?: {
			content?: string
			fileHash?: string
		},
	): Promise<CodeBlock[]> {
		// Get file extension
		const ext = path.extname(filePath).toLowerCase()

		// Skip if not a supported language
		if (!this.isSupportedLanguage(ext)) {
			return []
		}

		// Get file content
		let content: string
		let fileHash: string

		if (options?.content) {
			content = options.content
			fileHash = options.fileHash || this.createFileHash(content)
		} else {
			try {
				content = await readFile(filePath, "utf8")
				fileHash = this.createFileHash(content)
			} catch (error) {
				console.error(`Error reading file ${filePath}:`, error)
				TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
					error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
					stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
					location: "parseFile",
				})
				return []
			}
		}

		// Parse the file
		return this.parseContent(filePath, content, fileHash)
	}

	/**
	 * Checks if a language is supported
	 * @param extension File extension
	 * @returns Boolean indicating if the language is supported
	 */
	private isSupportedLanguage(extension: string): boolean {
		return scannerExtensions.includes(extension)
	}

	/**
	 * Creates a hash for a file
	 * @param content File content
	 * @returns Hash string
	 */
	private createFileHash(content: string): string {
		return createHash("sha256").update(content).digest("hex")
	}

	/**
	 * Parses file content into code blocks
	 * @param filePath Path to the file
	 * @param content File content
	 * @param fileHash File hash
	 * @returns Array of code blocks
	 */
	private async parseContent(filePath: string, content: string, fileHash: string): Promise<CodeBlock[]> {
		const ext = path.extname(filePath).slice(1).toLowerCase()
		const seenSegmentHashes = new Set<string>()

		// Handle markdown files specially
		if (ext === "md" || ext === "markdown") {
			return this.parseMarkdownContent(filePath, content, fileHash, seenSegmentHashes)
		}

		// Check if this extension should use fallback chunking
		if (shouldUseFallbackChunking(`.${ext}`)) {
			return this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
		}

		// Check if we already have the parser loaded
		if (!this.loadedParsers[ext]) {
			const pendingLoad = this.pendingLoads.get(ext)
			if (pendingLoad) {
				try {
					await pendingLoad
				} catch (error) {
					console.error(`Error in pending parser load for ${filePath}:`, error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
						stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
						location: "parseContent:loadParser",
					})
					return []
				}
			} else {
				const loadPromise = loadRequiredLanguageParsers([filePath])
				this.pendingLoads.set(ext, loadPromise)
				try {
					const newParsers = await loadPromise
					if (newParsers) {
						this.loadedParsers = { ...this.loadedParsers, ...newParsers }
					}
				} catch (error) {
					console.error(`Error loading language parser for ${filePath}:`, error)
					TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
						error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
						stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
						location: "parseContent:loadParser",
					})
					return []
				} finally {
					this.pendingLoads.delete(ext)
				}
			}
		}

		const language = this.loadedParsers[ext]
		if (!language) {
			console.warn(`No parser available for file extension: ${ext}`)
			return []
		}

		const tree = language.parser.parse(content)

		// We don't need to get the query string from languageQueries since it's already loaded
		// in the language object
		const captures = tree ? language.query.captures(tree.rootNode) : []

		// Check if captures are empty
		if (captures.length === 0) {
			if (content.length >= MIN_BLOCK_CHARS) {
				// Perform fallback chunking if content is large enough
				const blocks = this._performFallbackChunking(filePath, content, fileHash, seenSegmentHashes)
				return blocks
			} else {
				// Return empty if content is too small for fallback
				return []
			}
		}

		const results: CodeBlock[] = []

		// Process captures if not empty
		const queue: Node[] = Array.from(captures).map((capture) => capture.node)

		while (queue.length > 0) {
			const currentNode = queue.shift()!
			// const lineSpan = currentNode.endPosition.row - currentNode.startPosition.row + 1 // Removed as per lint error

			// Check if the node meets the minimum character requirement
			if (currentNode.text.length >= MIN_BLOCK_CHARS) {
				// If it also exceeds the maximum character limit, try to break it down
				if (currentNode.text.length > MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR) {
					if (currentNode.children.filter((child) => child !== null).length > 0) {
						// If it has children, process them instead
						queue.push(...currentNode.children.filter((child) => child !== null))
					} else {
						// If it's a leaf node, chunk it
						const chunkedBlocks = this._chunkLeafNodeByLines(
							currentNode,
							filePath,
							fileHash,
							seenSegmentHashes,
						)
						results.push(...chunkedBlocks)
					}
				} else {
					// Node meets min chars and is within max chars, create a block
					const identifier =
						currentNode.childForFieldName("name")?.text ||
						currentNode.children.find((c) => c?.type === "identifier")?.text ||
						null
					const type = currentNode.type
					const start_line = currentNode.startPosition.row + 1
					const end_line = currentNode.endPosition.row + 1
					const content = currentNode.text
					const contentPreview = content.slice(0, 100)
					const segmentHash = createHash("sha256")
						.update(`${filePath}-${start_line}-${end_line}-${content.length}-${contentPreview}`)
						.digest("hex")

					if (!seenSegmentHashes.has(segmentHash)) {
						seenSegmentHashes.add(segmentHash)
						results.push({
							file_path: filePath,
							identifier,
							type,
							start_line,
							end_line,
							content,
							segmentHash,
							fileHash,
						})
					}
				}
			}
			// Nodes smaller than minBlockChars are ignored
		}

		return results
	}

	/**
	 * Prepends parent section heading to prose chunk `raw` when needed (continuation chunks).
	 */
	private _applySectionHeadingPrefixToChunkBody(
		raw: string,
		headingPrefix: string,
		chunkStartLineIndexInSegment: number,
		segmentLines: string[],
	): string {
		if (!headingPrefix) {
			return raw
		}
		const prefixHeadingLine = headingPrefix.split("\n")[0]?.trimEnd() ?? ""
		if (chunkStartLineIndexInSegment > 0) {
			return headingPrefix + raw
		}
		const firstLineOfSegment = segmentLines[0]?.trimEnd() ?? ""
		if (prefixHeadingLine && firstLineOfSegment === prefixHeadingLine) {
			return raw
		}
		return headingPrefix + raw
	}

	/**
	 * Common helper function to chunk text by lines, avoiding tiny remainders.
	 * When `headingPrefix` is set (markdown section title), continuation chunks include it in `content`.
	 */
	private _chunkTextByLines(
		lines: string[],
		filePath: string,
		fileHash: string,
		chunkType: string,
		seenSegmentHashes: Set<string>,
		baseStartLine: number = 1, // 1-based start line of the *first* line in the `lines` array
		headingPrefix: string = "",
		/** When set (e.g. oversized fenced code), max raw chars per chunk instead of default ~1150 */
		lineChunkBudget?: number,
	): CodeBlock[] {
		const chunks: CodeBlock[] = []
		let currentChunkLines: string[] = []
		let currentChunkLength = 0
		let chunkStartLineIndex = 0 // 0-based index within the `lines` array
		const baseMaxChars =
			lineChunkBudget !== undefined
				? lineChunkBudget
				: MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR
		const prefixLen = headingPrefix.length

		const maxCharsForCurrentChunk = (): number => {
			if (!headingPrefix) {
				return baseMaxChars
			}
			if (chunkStartLineIndex > 0) {
				return Math.max(MIN_BLOCK_CHARS, baseMaxChars - prefixLen)
			}
			const headingLine = headingPrefix.split("\n")[0]?.trimEnd() ?? ""
			const firstLineOfSegment = lines[0]?.trimEnd() ?? ""
			if (headingLine && firstLineOfSegment === headingLine) {
				return baseMaxChars
			}
			return Math.max(MIN_BLOCK_CHARS, baseMaxChars - prefixLen)
		}

		const finalizeChunk = (endLineIndex: number) => {
			if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
				const raw = currentChunkLines.join("\n")
				const chunkContent = this._applySectionHeadingPrefixToChunkBody(
					raw,
					headingPrefix,
					chunkStartLineIndex,
					lines,
				)
				const startLine = baseStartLine + chunkStartLineIndex
				const endLine = baseStartLine + endLineIndex
				const contentPreview = chunkContent.slice(0, 100)
				const segmentHash = createHash("sha256")
					.update(`${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`)
					.digest("hex")

				if (!seenSegmentHashes.has(segmentHash)) {
					seenSegmentHashes.add(segmentHash)
					chunks.push({
						file_path: filePath,
						identifier: null,
						type: chunkType,
						start_line: startLine,
						end_line: endLine,
						content: chunkContent,
						segmentHash,
						fileHash,
					})
				}
			}
			currentChunkLines = []
			currentChunkLength = 0
			chunkStartLineIndex = endLineIndex + 1
		}

		const createSegmentBlock = (segment: string, originalLineNumber: number, startCharIndex: number) => {
			let content = segment
			if (headingPrefix) {
				const lineIdx = originalLineNumber - baseStartLine
				if (lineIdx > 0) {
					content = headingPrefix + segment
				}
			}
			const segmentPreview = content.slice(0, 100)
			const segmentHash = createHash("sha256")
				.update(
					`${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${content.length}-${segmentPreview}`,
				)
				.digest("hex")

			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash)
				chunks.push({
					file_path: filePath,
					identifier: null,
					type: `${chunkType}_segment`,
					start_line: originalLineNumber,
					end_line: originalLineNumber,
					content,
					segmentHash,
					fileHash,
				})
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			const lineLength = line.length + (i < lines.length - 1 ? 1 : 0) // +1 for newline, except last line
			const originalLineNumber = baseStartLine + i
			const lineMax = maxCharsForCurrentChunk()

			// Handle oversized lines (longer than current chunk budget)
			if (lineLength > lineMax) {
				// Finalize any existing normal chunk before processing the oversized line
				if (currentChunkLines.length > 0) {
					finalizeChunk(i - 1)
				}

				// Split the oversized line into segments
				let remainingLineContent = line
				let currentSegmentStartChar = 0
				while (remainingLineContent.length > 0) {
					const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS)
					remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS)
					createSegmentBlock(segment, originalLineNumber, currentSegmentStartChar)
					currentSegmentStartChar += MAX_BLOCK_CHARS
				}
				// Update chunkStartLineIndex to continue processing from the next line
				chunkStartLineIndex = i + 1
				continue
			}

			// Handle normally sized lines
			if (currentChunkLength > 0 && currentChunkLength + lineLength > maxCharsForCurrentChunk()) {
				// Re-balancing Logic
				let splitIndex = i - 1
				let remainderLength = 0
				for (let j = i; j < lines.length; j++) {
					remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0)
				}

				if (
					currentChunkLength >= MIN_BLOCK_CHARS &&
					remainderLength < MIN_CHUNK_REMAINDER_CHARS &&
					currentChunkLines.length > 1
				) {
					for (let k = i - 2; k >= chunkStartLineIndex; k--) {
						const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1)
						const potentialChunkLength = potentialChunkLines.join("\n").length + 1
						const potentialNextChunkLines = lines.slice(k + 1)
						const potentialNextChunkLength = potentialNextChunkLines.join("\n").length + 1

						if (
							potentialChunkLength >= MIN_BLOCK_CHARS &&
							potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS
						) {
							splitIndex = k
							break
						}
					}
				}

				finalizeChunk(splitIndex)

				if (i >= chunkStartLineIndex) {
					currentChunkLines.push(line)
					currentChunkLength += lineLength
				} else {
					i = chunkStartLineIndex - 1
					continue
				}
			} else {
				currentChunkLines.push(line)
				currentChunkLength += lineLength
			}
		}

		// Process the last remaining chunk
		if (currentChunkLines.length > 0) {
			finalizeChunk(lines.length - 1)
		}

		return chunks
	}

	private _performFallbackChunking(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = content.split("\n")
		return this._chunkTextByLines(lines, filePath, fileHash, "fallback_chunk", seenSegmentHashes)
	}

	private _chunkLeafNodeByLines(
		node: Node,
		filePath: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = node.text.split("\n")
		const baseStartLine = node.startPosition.row + 1
		return this._chunkTextByLines(
			lines,
			filePath,
			fileHash,
			node.type, // Use the node's type
			seenSegmentHashes,
			baseStartLine,
		)
	}

	/**
	 * Splits markdown lines into segments that respect fenced code blocks and tables
	 * as atomic (unsplittable) units. Returns an array of segments, each with its
	 * lines, starting line number (1-based), and whether it's an atomic block.
	 */
	private _splitMarkdownIntoSegments(
		lines: string[],
		baseStartLine: number,
	): Array<{ lines: string[]; startLine: number; atomic: boolean }> {
		const segments: Array<{ lines: string[]; startLine: number; atomic: boolean }> = []
		const fenceRegex = /^(\s*)(```|~~~)/

		let i = 0
		let normalStart = 0

		const flushNormal = (endExclusive: number) => {
			if (endExclusive > normalStart) {
				const slice = lines.slice(normalStart, endExclusive)
				if (slice.some((l) => l.trim().length > 0)) {
					segments.push({
						lines: slice,
						startLine: baseStartLine + normalStart,
						atomic: false,
					})
				}
			}
		}

		while (i < lines.length) {
			const fenceMatch = lines[i].match(fenceRegex)
			if (fenceMatch) {
				flushNormal(i)
				const fenceIndent = fenceMatch[1]
				const fenceChar = fenceMatch[2]
				const closingRegex = new RegExp(`^${fenceIndent}${fenceChar}{${fenceChar.length},}\\s*$`)
				const blockStart = i
				i++
				while (i < lines.length && !closingRegex.test(lines[i])) {
					i++
				}
				if (i < lines.length) {
					i++ // include the closing fence line
				}
				segments.push({
					lines: lines.slice(blockStart, i),
					startLine: baseStartLine + blockStart,
					atomic: true,
				})
				normalStart = i
				continue
			}

			if (this._isTableRow(lines[i])) {
				flushNormal(i)
				const tableStart = i
				while (i < lines.length && this._isTableRow(lines[i])) {
					i++
				}
				segments.push({
					lines: lines.slice(tableStart, i),
					startLine: baseStartLine + tableStart,
					atomic: true,
				})
				normalStart = i
				continue
			}

			i++
		}

		flushNormal(lines.length)
		return segments
	}

	private _isTableRow(line: string): boolean {
		const trimmed = line.trim()
		return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1
	}

	/**
	 * Prefix for table block text: parent section title (ATX line from section start, or `# title`).
	 */
	private _tableHeadingPrefix(lines: string[], identifier: string | null): string {
		if (!identifier?.trim()) {
			return ""
		}
		const first = lines[0]?.trimEnd() ?? ""
		if (/^#{1,6}\s/.test(first.trim())) {
			return `${first}\n\n`
		}
		return `# ${identifier.trim()}\n\n`
	}

	/**
	 * Chunks an oversized markdown table while preserving the header rows
	 * (first row + separator row) in every chunk for context completeness.
	 */
	private _chunkTableWithHeader(
		lines: string[],
		filePath: string,
		fileHash: string,
		type: string,
		seenSegmentHashes: Set<string>,
		baseStartLine: number,
		headingPrefix: string = "",
	): CodeBlock[] {
		const tableMax = MAX_TABLE_BLOCK_CHARS
		const results: CodeBlock[] = []

		let headerLines: string[] = []
		let headerLength = 0
		let dataStartIdx = 0

		if (lines.length >= 2 && /^\|\s*---/.test(lines[1].trim())) {
			headerLines = [lines[0], lines[1]]
			headerLength = headerLines.join("\n").length + 1
			dataStartIdx = 2
		} else if (lines.length >= 1) {
			headerLines = [lines[0]]
			headerLength = lines[0].length + 1
			dataStartIdx = 1
		}

		const prefixLen = headingPrefix.length
		const maxDataChars = tableMax - headerLength - prefixLen

		if (maxDataChars < MIN_BLOCK_CHARS || dataStartIdx >= lines.length) {
			return this._chunkTextByLines(lines, filePath, fileHash, type, seenSegmentHashes, baseStartLine, headingPrefix)
		}

		let chunkDataLines: string[] = []
		let chunkDataLength = 0
		let chunkDataStartIdx = dataStartIdx

		const finalizeTableChunk = (endIdx: number) => {
			if (chunkDataLines.length === 0) return
			const chunkLines = [...headerLines, ...chunkDataLines]
			const tableBody = chunkLines.join("\n")
			const chunkContent = headingPrefix + tableBody
			if (chunkContent.trim().length < MIN_BLOCK_CHARS) return

			const chunkStartLine = baseStartLine + chunkDataStartIdx
			const chunkEndLine = baseStartLine + endIdx
			const contentPreview = chunkContent.slice(0, 100)
			const segmentHash = createHash("sha256")
				.update(`${filePath}-${chunkStartLine}-${chunkEndLine}-${chunkContent.length}-${contentPreview}`)
				.digest("hex")

			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash)
				results.push({
					file_path: filePath,
					identifier: null,
					type,
					start_line: chunkStartLine,
					end_line: chunkEndLine,
					content: chunkContent,
					segmentHash,
					fileHash,
				})
			}
			chunkDataLines = []
			chunkDataLength = 0
			chunkDataStartIdx = endIdx + 1
		}

		for (let i = dataStartIdx; i < lines.length; i++) {
			const lineLen = lines[i].length + (i < lines.length - 1 ? 1 : 0)
			if (chunkDataLength > 0 && chunkDataLength + lineLen > maxDataChars) {
				finalizeTableChunk(i - 1)
			}
			chunkDataLines.push(lines[i])
			chunkDataLength += lineLen
		}

		if (chunkDataLines.length > 0) {
			finalizeTableChunk(lines.length - 1)
		}

		return results
	}

	/**
	 * Helper method to process markdown content sections with consistent chunking logic.
	 * Tables and fenced code blocks are kept intact as atomic units.
	 */
	private processMarkdownSection(
		lines: string[],
		filePath: string,
		fileHash: string,
		type: string,
		seenSegmentHashes: Set<string>,
		startLine: number,
		identifier: string | null = null,
	): CodeBlock[] {
		const content = lines.join("\n")

		if (content.trim().length < MIN_BLOCK_CHARS) {
			return []
		}

		const effectiveMax = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR
		const tableHeadingPrefix = this._tableHeadingPrefix(lines, identifier)

		const needsChunking =
			content.length > effectiveMax || lines.some((line) => line.length > effectiveMax)

		if (!needsChunking) {
			const endLine = startLine + lines.length - 1
			const contentPreview = content.slice(0, 100)
			const segmentHash = createHash("sha256")
				.update(`${filePath}-${startLine}-${endLine}-${content.length}-${contentPreview}`)
				.digest("hex")

			if (!seenSegmentHashes.has(segmentHash)) {
				seenSegmentHashes.add(segmentHash)
				return [
					{
						file_path: filePath,
						identifier,
						type,
						start_line: startLine,
						end_line: endLine,
						content,
						segmentHash,
						fileHash,
					},
				]
			}
			return []
		}

		const segments = this._splitMarkdownIntoSegments(lines, startLine)
		const results: CodeBlock[] = []

		for (const segment of segments) {
			const segContent = segment.lines.join("\n")

			if (segContent.trim().length < MIN_BLOCK_CHARS) {
				continue
			}

			if (segment.atomic) {
				const isTable = segment.lines.every((l) => this._isTableRow(l))
				const tableContent =
					isTable && tableHeadingPrefix ? tableHeadingPrefix + segContent : segContent
				if (isTable && tableContent.length <= MAX_TABLE_BLOCK_CHARS) {
					const endLine = segment.startLine + segment.lines.length - 1
					const contentPreview = tableContent.slice(0, 100)
					const segmentHash = createHash("sha256")
						.update(
							`${filePath}-${segment.startLine}-${endLine}-${tableContent.length}-${contentPreview}`,
						)
						.digest("hex")

					if (!seenSegmentHashes.has(segmentHash)) {
						seenSegmentHashes.add(segmentHash)
						results.push({
							file_path: filePath,
							identifier: null,
							type,
							start_line: segment.startLine,
							end_line: endLine,
							content: tableContent,
							segmentHash,
							fileHash,
						})
					}
				} else if (isTable && tableContent.length > MAX_TABLE_BLOCK_CHARS) {
					results.push(
						...this._chunkTableWithHeader(
							segment.lines,
							filePath,
							fileHash,
							type,
							seenSegmentHashes,
							segment.startLine,
							tableHeadingPrefix,
						),
					)
				} else if (!isTable) {
					const fencedContent = tableHeadingPrefix ? tableHeadingPrefix + segContent : segContent
					if (fencedContent.length <= MAX_FENCED_CODE_BLOCK_CHARS) {
						const endLine = segment.startLine + segment.lines.length - 1
						const contentPreview = fencedContent.slice(0, 100)
						const segmentHash = createHash("sha256")
							.update(
								`${filePath}-${segment.startLine}-${endLine}-${fencedContent.length}-${contentPreview}`,
							)
							.digest("hex")

						if (!seenSegmentHashes.has(segmentHash)) {
							seenSegmentHashes.add(segmentHash)
							results.push({
								file_path: filePath,
								identifier: null,
								type,
								start_line: segment.startLine,
								end_line: endLine,
								content: fencedContent,
								segmentHash,
								fileHash,
							})
						}
					} else {
						results.push(
							...this._chunkTextByLines(
								segment.lines,
								filePath,
								fileHash,
								type,
								seenSegmentHashes,
								segment.startLine,
								tableHeadingPrefix,
								MAX_FENCED_CODE_BLOCK_CHARS,
							),
						)
					}
				}
			} else {
				const chunks = this._chunkTextByLines(
					segment.lines,
					filePath,
					fileHash,
					type,
					seenSegmentHashes,
					segment.startLine,
					tableHeadingPrefix,
				)
				results.push(...chunks)
			}
		}

		if (identifier) {
			results.forEach((chunk) => {
				chunk.identifier = identifier
			})
		}

		return results
	}

	private parseMarkdownContent(
		filePath: string,
		content: string,
		fileHash: string,
		seenSegmentHashes: Set<string>,
	): CodeBlock[] {
		const lines = content.split("\n")
		const markdownCaptures = parseMarkdown(content) || []

		if (markdownCaptures.length === 0) {
			// No headers found, process entire content
			return this.processMarkdownSection(lines, filePath, fileHash, "markdown_content", seenSegmentHashes, 1)
		}

		const results: CodeBlock[] = []
		let lastProcessedLine = 0

		// Process content before the first header
		if (markdownCaptures.length > 0) {
			const firstHeaderLine = markdownCaptures[0].node.startPosition.row
			if (firstHeaderLine > 0) {
				const preHeaderLines = lines.slice(0, firstHeaderLine)
				const preHeaderBlocks = this.processMarkdownSection(
					preHeaderLines,
					filePath,
					fileHash,
					"markdown_content",
					seenSegmentHashes,
					1,
				)
				results.push(...preHeaderBlocks)
			}
		}

		// Process markdown captures (headers and sections)
		for (let i = 0; i < markdownCaptures.length; i += 2) {
			const nameCapture = markdownCaptures[i]
			// Ensure we don't go out of bounds when accessing the next capture
			if (i + 1 >= markdownCaptures.length) break
			const definitionCapture = markdownCaptures[i + 1]

			if (!definitionCapture) continue

			const startLine = definitionCapture.node.startPosition.row + 1
			const endLine = definitionCapture.node.endPosition.row + 1
			const sectionLines = lines.slice(startLine - 1, endLine)

			// Extract header level for type classification
			const headerMatch = nameCapture.name.match(/\.h(\d)$/)
			const headerLevel = headerMatch ? parseInt(headerMatch[1]) : 1
			const headerText = nameCapture.node.text

			const sectionBlocks = this.processMarkdownSection(
				sectionLines,
				filePath,
				fileHash,
				`markdown_header_h${headerLevel}`,
				seenSegmentHashes,
				startLine,
				headerText,
			)
			results.push(...sectionBlocks)

			lastProcessedLine = endLine
		}

		// Process any remaining content after the last header section
		if (lastProcessedLine < lines.length) {
			const remainingLines = lines.slice(lastProcessedLine)
			const remainingBlocks = this.processMarkdownSection(
				remainingLines,
				filePath,
				fileHash,
				"markdown_content",
				seenSegmentHashes,
				lastProcessedLine + 1,
			)
			results.push(...remainingBlocks)
		}

		return results
	}
}

// Export a singleton instance for convenience
export const codeParser = new CodeParser()
