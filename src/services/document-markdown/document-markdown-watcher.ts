import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"

import type { DocumentMarkdownStatus, DocumentMarkdownTypeFilters } from "@roo-code/types"

import { t } from "../../i18n"
import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import { processFiles } from "../file-cool/client.js"
import { MAX_LIST_FILES_LIMIT_CODE_INDEX } from "../code-index/constants"
import { generateRelativeFilePath } from "../code-index/shared/get-relative-path"
import { listFiles } from "../glob/list-files"
import { isPathInIgnoredDirectory } from "../glob/ignore-utils"
import { isRooServeBridge } from "../../utils/serveBridgeWorkspaceGuard"
import { ContextProxy } from "../../core/config/ContextProxy"
import { CodeIndexManager } from "../code-index/manager"

const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"])
const PDF_EXTENSIONS = new Set([".pdf"])
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"])

const ALL_SUPPORTED_EXTENSIONS = new Set<string>([
	...OFFICE_EXTENSIONS,
	...PDF_EXTENSIONS,
	...IMAGE_EXTENSIONS,
])

const DEFAULT_TYPE_FILTERS: DocumentMarkdownTypeFilters = {
	office: true,
	pdf: true,
	images: false,
}

function isExtensionAllowedByTypeFilters(
	ext: string,
	filters: DocumentMarkdownTypeFilters,
): boolean {
	if (OFFICE_EXTENSIONS.has(ext)) {
		return filters.office
	}
	if (PDF_EXTENSIONS.has(ext)) {
		return filters.pdf
	}
	if (IMAGE_EXTENSIONS.has(ext)) {
		return filters.images
	}
	return false
}

const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024
const DEBOUNCE_MS = 500
const MAX_RECENT_ERRORS = 12

/** Office 编辑时产生的锁文件（如 `~$报告.docx`），不是真实文档，勿参与转换。 */
function isOfficeLockFile(fsPath: string): boolean {
	return path.basename(fsPath).startsWith("~$")
}

/**
 * Global default for **new** workspace folders when no per-workspace override is stored — mirrors
 * {@link CodeIndexManager}'s `codeIndexAutoEnableDefault`.
 */
export const DOCUMENT_MARKDOWN_AUTO_ENABLE_DEFAULT_KEY = "documentMarkdownAutoEnableDefault"

/** Same glob for `FileSystemWatcher` (CLI/shim: watcher is inert; discovery uses {@link listFiles} like code index). */
const SUPPORTED_DOCS_RELATIVE_PATTERN = "**/*.{doc,docx,ppt,pptx,xls,xlsx,pdf,jpg,jpeg,png}"

const GATEWAY_NOT_CONFIGURED_MESSAGE = "MCP Gateway URL or API Key is not configured."

type GatewayConfig = { apiUrl: string; apiKey: string }

/**
 * Maps file extension to file-cool tool name and request options (see gateway /file-cool/tools).
 * Excel uses xslx2md with ocr disabled; PDF uses ocr; Word → docx2md; PowerPoint → pptx2md.
 */
function getFileCoolConversionArgs(filePath: string): {
	functionType: string
	args: { inputs: string[]; [key: string]: unknown }
} | null {
	const ext = path.extname(filePath).toLowerCase()
	switch (ext) {
		case ".pdf":
			return {
				functionType: "ocr",
				args: baseDocConversionArgs(filePath),
			}
		case ".doc":
		case ".docx":
			return {
				functionType: "docx2md",
				args: baseDocConversionArgs(filePath),
			}
		case ".ppt":
		case ".pptx":
			return {
				functionType: "pptx2md",
				args: baseDocConversionArgs(filePath),
			}
		case ".xls":
		case ".xlsx":
			return {
				functionType: "xslx2md",
				args: {
					inputs: [filePath],
					ocr: false,
				},
			}
		case ".jpg":
		case ".jpeg":
		case ".png":
			return {
				functionType: "ocr",
				args: baseDocConversionArgs(filePath),
			}
		default:
			return null
	}
}

function baseDocConversionArgs(filePath: string): {
	inputs: string[]
	start: number
	end: number
} {
	return {
		inputs: [filePath],
		start: 1,
		end: 0,
	}
}

/**
 * Watches workspace for Office/PDF/image documents and queues conversion to Markdown via file-cool (MCP Gateway).
 */
export class DocumentMarkdownWatcher implements vscode.Disposable {
	private static instances = new Map<string, DocumentMarkdownWatcher>()

	private readonly workspacePath: string
	private readonly _folderUri: vscode.Uri
	private readonly context: vscode.ExtensionContext
	private readonly getGatewayConfig: () => Promise<GatewayConfig | null>
	private readonly getFeatureEnabled: () => boolean
	private readonly getTypeFilters: () => DocumentMarkdownTypeFilters

	private fileWatcher?: vscode.FileSystemWatcher
	/** Debounce batched source-document deletes before prompting to remove sidecar `.md` files. */
	private sourceDeleteDebounceTimer?: NodeJS.Timeout
	private readonly pendingDeletedSourcePaths = new Set<string>()
	/** When a workspace `.md` is deleted, debounce and run a scan to re-convert sources missing output. */
	private mdDeleteWatcher?: vscode.FileSystemWatcher
	private mdDeleteScanTimer?: NodeJS.Timeout
	/** Set while converting; cleared in `runQueue` finally, then one deferred scan runs if needed. */
	private pendingScanAfterMdDelete = false
	/** One automatic `findFiles` scan per enable cycle; reset in {@link disposeWatcherOnly} (mirrors codebase index startup). */
	private startupWorkspaceScanDone = false

	private ignoreController: RooIgnoreController
	private batchTimer?: NodeJS.Timeout
	private pendingPaths = new Set<string>()
	private processingQueue: string[] = []
	private isProcessing = false

	private readonly _onDidChangeStatus = new vscode.EventEmitter<DocumentMarkdownStatus>()
	readonly onDidChangeStatus = this._onDidChangeStatus.event

	private ignoreInitialized = false

	private status: DocumentMarkdownStatus = {
		enabled: false,
		systemStatus: "Standby",
		processedItems: 0,
		totalItems: 0,
		recentErrors: [],
	}

	public static getInstance(
		context: vscode.ExtensionContext,
		workspacePath?: string,
		getGatewayConfig?: () => Promise<GatewayConfig | null>,
		getFeatureEnabled?: () => boolean,
		getTypeFilters?: () => DocumentMarkdownTypeFilters,
	): DocumentMarkdownWatcher | undefined {
		let folder: vscode.WorkspaceFolder | undefined

		if (workspacePath) {
			folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === workspacePath)
		} else {
			const activeEditor = vscode.window.activeTextEditor
			if (activeEditor) {
				folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
			}
			if (!folder) {
				const workspaceFolders = vscode.workspace.workspaceFolders
				if (!workspaceFolders || workspaceFolders.length === 0) {
					return undefined
				}
				folder = workspaceFolders[0]
			}
			workspacePath = folder.uri.fsPath
		}

		if (!DocumentMarkdownWatcher.instances.has(workspacePath)) {
			const folderUri =
				folder?.uri ??
				({
					fsPath: workspacePath,
					scheme: "file",
					authority: "",
					path: workspacePath,
					toString: () => `file://${workspacePath}`,
				} as unknown as vscode.Uri)
			DocumentMarkdownWatcher.instances.set(
				workspacePath,
				new DocumentMarkdownWatcher(
					workspacePath,
					folderUri,
					context,
					getGatewayConfig ?? (async () => null),
					getFeatureEnabled ?? (() => true),
					getTypeFilters ?? (() => DEFAULT_TYPE_FILTERS),
				),
			)
		}
		return DocumentMarkdownWatcher.instances.get(workspacePath)!
	}

	public static disposeAll(): void {
		for (const w of DocumentMarkdownWatcher.instances.values()) {
			w.dispose()
		}
		DocumentMarkdownWatcher.instances.clear()
	}

	private constructor(
		workspacePath: string,
		folderUri: vscode.Uri,
		context: vscode.ExtensionContext,
		getGatewayConfig: () => Promise<GatewayConfig | null>,
		getFeatureEnabled: () => boolean,
		getTypeFilters: () => DocumentMarkdownTypeFilters,
	) {
		this.workspacePath = workspacePath
		this._folderUri = folderUri
		this.context = context
		this.getGatewayConfig = getGatewayConfig
		this.getFeatureEnabled = getFeatureEnabled
		this.getTypeFilters = getTypeFilters
		this.ignoreController = new RooIgnoreController(workspacePath)
	}

	private shouldConvertExtension(ext: string): boolean {
		if (!ALL_SUPPORTED_EXTENSIONS.has(ext)) {
			return false
		}
		return isExtensionAllowedByTypeFilters(ext, this.getTypeFilters())
	}

	private workspaceEnabledKey(): string {
		return "documentMarkdownAutoConvert:" + this._folderUri.toString(true)
	}

	/** When unset, new workspaces inherit this (default `true`, same idea as code index auto-enable). */
	static getAutoEnableDefault(context: vscode.ExtensionContext): boolean {
		return context.globalState.get(DOCUMENT_MARKDOWN_AUTO_ENABLE_DEFAULT_KEY, true)
	}

	/**
	 * Re-run `initialize()` on every open folder watcher so global auto-default changes take effect.
	 */
	static async reapplyAllWorkspaceFolders(
		context: vscode.ExtensionContext,
		getGatewayConfig: () => Promise<GatewayConfig | null>,
		getFeatureEnabled?: () => boolean,
		getTypeFilters?: () => DocumentMarkdownTypeFilters,
	): Promise<void> {
		const folders = vscode.workspace.workspaceFolders
		if (!folders?.length) {
			return
		}
		for (const folder of folders) {
			const w = DocumentMarkdownWatcher.getInstance(
				context,
				folder.uri.fsPath,
				getGatewayConfig,
				getFeatureEnabled,
				getTypeFilters,
			)
			if (!w) {
				continue
			}
			try {
				await w.initialize()
			} catch (e) {
				console.error(
					`[DocumentMarkdownWatcher] reapplyAllWorkspaceFolders ${folder.uri.fsPath}:`,
					e instanceof Error ? e.message : e,
				)
			}
		}
	}

	private getAutoEnableDefault(): boolean {
		return DocumentMarkdownWatcher.getAutoEnableDefault(this.context)
	}

	/**
	 * Per-workspace explicit value wins; if never set, use {@link getAutoEnableDefault} (global), like
	 * {@link CodeIndexManager.isWorkspaceEnabled}.
	 */
	get isWorkspaceEnabled(): boolean {
		const explicit = this.context.workspaceState.get<boolean | undefined>(this.workspaceEnabledKey(), undefined)
		if (explicit !== undefined) {
			return explicit
		}
		return this.getAutoEnableDefault()
	}

	get isEffectiveEnabled(): boolean {
		return this.getFeatureEnabled() && this.isWorkspaceEnabled
	}

	async setWorkspaceEnabled(enabled: boolean): Promise<void> {
		await this.context.workspaceState.update(this.workspaceEnabledKey(), enabled)
		await this.applyEnabledState()
		this.emitStatus()
	}

	/** Clears accumulated conversion error lines and resets status when appropriate. */
	clearRecentErrors(): void {
		this.status.recentErrors = []
		if (this.isProcessing) {
			this.emitStatus()
			return
		}
		if (!this.isEffectiveEnabled) {
			this.status.systemStatus = "Standby"
			this.emitStatus()
			return
		}
		if (!this.status.gatewayConfigured) {
			this.status.systemStatus = "Error"
		} else {
			this.status.systemStatus = "Idle"
		}
		this.emitStatus()
	}

	getCurrentStatus(): DocumentMarkdownStatus {
		const featureEnabled = this.getFeatureEnabled()
		const workspaceEnabled = this.isWorkspaceEnabled
		return {
			...this.status,
			enabled: featureEnabled && workspaceEnabled,
			featureEnabled,
			workspaceEnabled,
			autoEnableDefault: this.getAutoEnableDefault(),
			recentErrors: [...this.status.recentErrors],
			workspacePath: this.workspacePath,
		}
	}

	/**
	 * Starts or stops the file watcher according to workspace enable flag.
	 */
	async initialize(): Promise<void> {
		if (!this.ignoreInitialized) {
			await this.ignoreController.initialize()
			this.ignoreInitialized = true
		}
		await this.applyEnabledState()
		this.emitStatus()
	}

	/** Updates `status.gatewayConfigured`; returns config when URL+key are set, otherwise `null`. */
	private async refreshGatewayConfigured(): Promise<GatewayConfig | null> {
		const gateway = await this.getGatewayConfig()
		const ok = !!(gateway?.apiUrl && gateway?.apiKey)
		this.status.gatewayConfigured = ok
		return ok && gateway ? gateway : null
	}

	private async applyEnabledState(): Promise<void> {
		this.status.enabled = this.isEffectiveEnabled
		if (!this.isEffectiveEnabled) {
			this.disposeWatcherOnly()
			this.status.systemStatus = "Standby"
			this.status.message = undefined
			this.status.processedItems = 0
			this.status.totalItems = 0
			this.status.currentFile = undefined
			await this.refreshGatewayConfigured()
			return
		}

		const gatewayReady = await this.refreshGatewayConfigured()
		if (!gatewayReady) {
			this.status.systemStatus = "Error"
			this.status.message = GATEWAY_NOT_CONFIGURED_MESSAGE
			this.pushError(this.status.message)
			return
		}

		if (!this.fileWatcher) {
			const pattern = new vscode.RelativePattern(this.workspacePath, SUPPORTED_DOCS_RELATIVE_PATTERN)
			this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern)
			this.fileWatcher.onDidCreate((uri) => void this.maybeEnqueue(uri.fsPath))
			this.fileWatcher.onDidChange((uri) => void this.maybeEnqueue(uri.fsPath))
			this.fileWatcher.onDidDelete((uri) => this.onSourceDocumentDeleted(uri.fsPath))
		}
		if (!this.mdDeleteWatcher) {
			const mdPattern = new vscode.RelativePattern(this.workspacePath, "**/*.md")
			this.mdDeleteWatcher = vscode.workspace.createFileSystemWatcher(mdPattern)
			this.mdDeleteWatcher.onDidDelete((uri) => this.onMarkdownFileDeleted(uri.fsPath))
		}
		this.status.systemStatus = "Idle"
		if (!this.startupWorkspaceScanDone) {
			this.startupWorkspaceScanDone = true
			void this.scanWorkspaceDocuments().catch((error) => {
				console.error(
					`[DocumentMarkdownWatcher] Startup workspace scan failed (${this.workspacePath}):`,
					error instanceof Error ? error.message : error,
				)
			})
		}
	}

	private disposeWatcherOnly(): void {
		this.fileWatcher?.dispose()
		this.fileWatcher = undefined
		this.mdDeleteWatcher?.dispose()
		this.mdDeleteWatcher = undefined
		if (this.batchTimer) {
			clearTimeout(this.batchTimer)
			this.batchTimer = undefined
		}
		if (this.mdDeleteScanTimer) {
			clearTimeout(this.mdDeleteScanTimer)
			this.mdDeleteScanTimer = undefined
		}
		if (this.sourceDeleteDebounceTimer) {
			clearTimeout(this.sourceDeleteDebounceTimer)
			this.sourceDeleteDebounceTimer = undefined
		}
		this.pendingDeletedSourcePaths.clear()
		this.pendingScanAfterMdDelete = false
		this.startupWorkspaceScanDone = false
		this.pendingPaths.clear()
		this.processingQueue = []
		this.isProcessing = false
	}

	private onSourceDocumentDeleted(deletedFsPath: string): void {
		if (!this.isEffectiveEnabled) {
			return
		}
		if (isOfficeLockFile(deletedFsPath)) {
			return
		}
		const ext = path.extname(deletedFsPath).toLowerCase()
		if (!ALL_SUPPORTED_EXTENSIONS.has(ext)) {
			return
		}
		const relative = generateRelativeFilePath(deletedFsPath, this.workspacePath)
		if (isPathInIgnoredDirectory(relative)) {
			return
		}
		if (!this.ignoreController.validateAccess(deletedFsPath)) {
			return
		}
		this.pendingDeletedSourcePaths.add(deletedFsPath)
		if (this.sourceDeleteDebounceTimer) {
			clearTimeout(this.sourceDeleteDebounceTimer)
		}
		this.sourceDeleteDebounceTimer = setTimeout(() => {
			this.sourceDeleteDebounceTimer = undefined
			void this.flushPendingDeletedSourceSidecars()
		}, DEBOUNCE_MS)
	}

	/**
	 * After supported source files are removed, if the sidecar `{name}.md` still exists, ask whether to delete it.
	 */
	private async flushPendingDeletedSourceSidecars(): Promise<void> {
		const sourcePaths = [...this.pendingDeletedSourcePaths]
		this.pendingDeletedSourcePaths.clear()
		if (!this.isEffectiveEnabled || sourcePaths.length === 0) {
			return
		}

		const candidates: { mdUri: vscode.Uri; sourceBase: string }[] = []
		const seenMd = new Set<string>()
		for (const sourcePath of sourcePaths) {
			const mdPath = this.getOutputMarkdownPath(sourcePath)
			if (seenMd.has(mdPath)) {
				continue
			}
			try {
				await fs.stat(mdPath)
			} catch {
				continue
			}
			seenMd.add(mdPath)
			candidates.push({
				mdUri: vscode.Uri.file(mdPath),
				sourceBase: path.basename(sourcePath),
			})
		}
		if (candidates.length === 0) {
			return
		}

		const deleteLabel = t("embeddings:documentMarkdown.deleteSidecarConfirmDelete")
		const keepLabel = t("embeddings:documentMarkdown.deleteSidecarConfirmKeep")

		let choice: string | undefined
		if (candidates.length === 1) {
			const one = candidates[0]!
			choice = await vscode.window.showWarningMessage(
				t("embeddings:documentMarkdown.deleteSidecarConfirmSingle", {
					fileName: one.sourceBase,
					mdName: path.basename(one.mdUri.fsPath),
				}),
				{ modal: true },
				keepLabel,
				deleteLabel,
			)
		} else {
			choice = await vscode.window.showWarningMessage(
				t("embeddings:documentMarkdown.deleteSidecarConfirmMultiple", {
					count: candidates.length,
				}),
				{ modal: true },
				keepLabel,
				deleteLabel,
			)
		}

		if (choice !== deleteLabel) {
			return
		}

		for (const { mdUri } of candidates) {
			try {
				await vscode.workspace.fs.delete(mdUri, { useTrash: true })
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				this.pushError(`${path.basename(mdUri.fsPath)}: ${msg}`)
				this.emitStatus()
			}
		}
	}

	private onMarkdownFileDeleted(deletedFsPath: string): void {
		if (!this.isEffectiveEnabled) {
			return
		}
		const relative = generateRelativeFilePath(deletedFsPath, this.workspacePath)
		if (isPathInIgnoredDirectory(relative)) {
			return
		}
		if (this.mdDeleteScanTimer) {
			clearTimeout(this.mdDeleteScanTimer)
		}
		this.mdDeleteScanTimer = setTimeout(() => {
			this.mdDeleteScanTimer = undefined
			void this.runScanAfterMarkdownDeletion()
		}, DEBOUNCE_MS)
	}

	private async runScanAfterMarkdownDeletion(): Promise<void> {
		if (!this.isEffectiveEnabled) {
			return
		}
		if (this.isProcessing) {
			this.pendingScanAfterMdDelete = true
			return
		}
		try {
			await this.scanWorkspaceDocuments()
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.pushError(`Markdown delete → scan: ${msg}`)
			this.emitStatus()
		}
	}

	dispose(): void {
		this.disposeWatcherOnly()
		this.ignoreController.dispose()
		this._onDidChangeStatus.dispose()
		DocumentMarkdownWatcher.instances.delete(this.workspacePath)
	}

	/**
	 * Finds supported documents under the workspace and enqueues them for conversion (UI "scan", startup sync, or md-delete recovery).
	 */
	async scanWorkspaceDocuments(): Promise<void> {
		if (!this.isEffectiveEnabled) {
			return
		}
		if (!this.ignoreInitialized) {
			await this.ignoreController.initialize()
			this.ignoreInitialized = true
		}

		const gatewayReady = await this.refreshGatewayConfigured()
		if (!gatewayReady) {
			this.status.systemStatus = "Error"
			this.status.message = GATEWAY_NOT_CONFIGURED_MESSAGE
			this.pushError(this.status.message)
			this.emitStatus()
			return
		}

		const [allPaths] = await listFiles(this.workspacePath, true, MAX_LIST_FILES_LIMIT_CODE_INDEX)
		const filePaths = allPaths.filter((p) => !p.endsWith("/"))
		const allowedPaths = this.ignoreController.filterPaths(filePaths)

		for (const fsPath of allowedPaths) {
			const ext = path.extname(fsPath).toLowerCase()
			if (!this.shouldConvertExtension(ext)) {
				continue
			}
			const relativeFilePath = generateRelativeFilePath(fsPath, this.workspacePath)
			if (isPathInIgnoredDirectory(relativeFilePath)) {
				continue
			}
			await this.maybeEnqueue(fsPath)
		}
		this.emitStatus()
	}

	/**
	 * Enqueue only if the file still needs conversion (same pre-checks as {@link convertOne} for skip cases),
	 * so progress `total` reflects pending work rather than every matched document.
	 */
	private async maybeEnqueue(fsPath: string): Promise<void> {
		if (!this.isEffectiveEnabled) {
			return
		}
		if (isOfficeLockFile(fsPath)) {
			return
		}
		const ext = path.extname(fsPath).toLowerCase()
		if (!this.shouldConvertExtension(ext)) {
			return
		}
		const relativeFilePath = generateRelativeFilePath(fsPath, this.workspacePath)
		if (isPathInIgnoredDirectory(relativeFilePath)) {
			return
		}
		if (!this.ignoreController.validateAccess(fsPath)) {
			return
		}
		let sourceMtimeMs: number
		try {
			const s = await fs.stat(fsPath)
			if (s.size > MAX_DOCUMENT_BYTES) {
				return
			}
			sourceMtimeMs = s.mtimeMs
		} catch {
			return
		}
		if (await this.shouldSkipConversion(fsPath, sourceMtimeMs)) {
			return
		}
		this.enqueue(fsPath)
	}

	private enqueue(fsPath: string): void {
		if (!this.isEffectiveEnabled) {
			return
		}
		if (isOfficeLockFile(fsPath)) {
			return
		}
		const ext = path.extname(fsPath).toLowerCase()
		if (!this.shouldConvertExtension(ext)) {
			return
		}
		this.pendingPaths.add(fsPath)
		if (this.batchTimer) {
			clearTimeout(this.batchTimer)
		}
		this.batchTimer = setTimeout(() => void this.flushPending(), DEBOUNCE_MS)
	}

	private mergePendingIntoQueue(): void {
		for (const p of this.pendingPaths) {
			if (!this.processingQueue.includes(p)) {
				this.processingQueue.push(p)
			}
		}
		this.pendingPaths.clear()
	}

	private async flushPending(): Promise<void> {
		this.batchTimer = undefined
		this.mergePendingIntoQueue()
		void this.runQueue()
	}

	private async runQueue(): Promise<void> {
		if (this.isProcessing) {
			return
		}
		this.isProcessing = true
		this.mergePendingIntoQueue()
		this.status.processedItems = 0
		this.status.totalItems = this.processingQueue.length
		try {
			// Strictly serial: one `convertOne` → one `processFiles` at a time (no parallel gateway calls).
			while (this.processingQueue.length > 0) {
				this.status.systemStatus = "Processing"
				const filePath = this.processingQueue.shift()!
				this.status.currentFile = path.basename(filePath)
				// Total = 已完成 + 队列剩余 + 当前正在处理的 1 个（与 code index 队列语义一致）
				this.status.totalItems =
					this.status.processedItems + this.processingQueue.length + 1
				this.status.message = t("embeddings:documentMarkdown.queueProgress", {
					processed: this.status.processedItems,
					total: this.status.totalItems,
					current: this.status.currentFile,
				})
				this.emitStatus()
				await this.convertOne(filePath)
				this.status.processedItems += 1
				this.mergePendingIntoQueue()
				if (this.processingQueue.length > 0) {
					this.status.totalItems = this.status.processedItems + this.processingQueue.length + 1
				}
				this.emitStatus()
			}
			this.status.currentFile = undefined
		} finally {
			this.isProcessing = false
			const hadErrors = this.status.recentErrors.length > 0
			this.status.processedItems = 0
			this.status.totalItems = 0
			this.status.currentFile = undefined
			this.status.systemStatus = hadErrors
				? "Error"
				: this.isEffectiveEnabled
					? "Idle"
					: "Standby"
			this.status.message = undefined
			this.emitStatus()
			if (this.pendingScanAfterMdDelete) {
				this.pendingScanAfterMdDelete = false
				await this.runScanAfterMarkdownDeletion()
			}
		}
	}

	/**
	 * Under `roo serve` / CLI shim, `createFileSystemWatcher` does not emit real FS events, so code index
	 * cannot auto-ingest new sidecar `.md` files. After a successful conversion, explicitly kick indexing.
	 */
	private requestServeBridgeCodeIndexAfterMarkdownWrite(sourcePath: string): void {
		if (!isRooServeBridge()) {
			return
		}
		const mdPath = this.getOutputMarkdownPath(sourcePath)
		void (async () => {
			try {
				await fs.access(mdPath)
			} catch {
				return
			}
			const manager = CodeIndexManager.getInstance(this.context, this.workspacePath)
			if (!manager) {
				return
			}
			try {
				const contextProxy = await ContextProxy.getInstance(this.context)
				await manager.initialize(contextProxy)
				if (!manager.isFeatureEnabled || !manager.isFeatureConfigured || !manager.isWorkspaceEnabled) {
					return
				}
				if (!manager.isInitialized) {
					return
				}
				const currentState = manager.state
				if (currentState === "Standby" || currentState === "Error" || currentState === "Indexed") {
					void manager.startIndexing()
					if (
						(currentState === "Standby" || currentState === "Error") &&
						!manager.isInitialized
					) {
						await manager.initialize(contextProxy)
						if (manager.state === "Standby" || manager.state === "Error") {
							void manager.startIndexing()
						}
					}
				}
			} catch (error) {
				console.warn(
					`[DocumentMarkdownWatcher] serve-bridge code index after markdown write failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		})()
	}

	private async convertOne(filePath: string): Promise<void> {
		try {
			if (isOfficeLockFile(filePath)) {
				return
			}
			const ext = path.extname(filePath).toLowerCase()
			if (!this.shouldConvertExtension(ext)) {
				return
			}
			const relativeFilePath = generateRelativeFilePath(filePath, this.workspacePath)
			if (isPathInIgnoredDirectory(relativeFilePath)) {
				return
			}
			if (!this.ignoreController.validateAccess(filePath)) {
				return
			}

			let sourceMtimeMs: number
			try {
				const s = await fs.stat(filePath)
				if (s.size > MAX_DOCUMENT_BYTES) {
					this.pushError(`${path.basename(filePath)}: file too large`)
					return
				}
				sourceMtimeMs = s.mtimeMs
			} catch {
				return
			}

			if (await this.shouldSkipConversion(filePath, sourceMtimeMs)) {
				return
			}

			const gateway = await this.refreshGatewayConfigured()
			if (!gateway) {
				this.pushError(GATEWAY_NOT_CONFIGURED_MESSAGE)
				return
			}

			const plan = getFileCoolConversionArgs(filePath)
			if (!plan) {
				return
			}

			await processFiles(plan.args, plan.functionType, gateway)
			this.requestServeBridgeCodeIndexAfterMarkdownWrite(filePath)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.pushError(`${path.basename(filePath)}: ${msg}`)
		}
	}

	/** Same directory as source: `{sourceBaseName}.md` (e.g. `abc.pdf` → `abc.pdf.md`). */
	private getOutputMarkdownPath(sourcePath: string): string {
		const name = path.basename(sourcePath)
		return path.join(path.dirname(sourcePath), `${name}.md`)
	}

	/**
	 * Skip conversion when the sidecar markdown exists and is at least as new as the source
	 * (same mtime or newer). If the source was edited after the `.md` was generated, re-convert.
	 */
	private async shouldSkipConversion(sourcePath: string, sourceMtimeMs: number): Promise<boolean> {
		const mdPath = this.getOutputMarkdownPath(sourcePath)
		try {
			const mdStat = await fs.stat(mdPath)
			return mdStat.mtimeMs >= sourceMtimeMs
		} catch {
			return false
		}
	}

	private pushError(message: string): void {
		const next = [...this.status.recentErrors, message]
		if (next.length > MAX_RECENT_ERRORS) {
			next.splice(0, next.length - MAX_RECENT_ERRORS)
		}
		this.status.recentErrors = next
	}

	private emitStatus(): void {
		const gatewayConfigured = this.status.gatewayConfigured
		const featureEnabled = this.getFeatureEnabled()
		const workspaceEnabled = this.isWorkspaceEnabled
		this._onDidChangeStatus.fire({
			...this.status,
			enabled: featureEnabled && workspaceEnabled,
			featureEnabled,
			workspaceEnabled,
			autoEnableDefault: this.getAutoEnableDefault(),
			workspacePath: this.workspacePath,
			gatewayConfigured,
		})
	}
}
