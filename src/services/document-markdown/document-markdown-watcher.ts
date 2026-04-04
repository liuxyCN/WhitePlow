import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"

import type { DocumentMarkdownStatus } from "@roo-code/types"

import { t } from "../../i18n"
import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import { processFiles } from "../file-cool/client.js"
import { generateRelativeFilePath } from "../code-index/shared/get-relative-path"
import { isPathInIgnoredDirectory } from "../glob/ignore-utils"

const DOCUMENT_EXTENSIONS = new Set([
	".doc",
	".docx",
	".ppt",
	".pptx",
	".xls",
	".xlsx",
	".pdf",
])

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
const DEBOUNCE_MS = 500
const MAX_RECENT_ERRORS = 12

/**
 * Global default for **new** workspace folders when no per-workspace override is stored — mirrors
 * {@link CodeIndexManager}'s `codeIndexAutoEnableDefault`.
 */
export const DOCUMENT_MARKDOWN_AUTO_ENABLE_DEFAULT_KEY = "documentMarkdownAutoEnableDefault"

/** Same glob for `FileSystemWatcher` and `findFiles` (must stay in sync). */
const SUPPORTED_DOCS_RELATIVE_PATTERN = "**/*.{doc,docx,ppt,pptx,xls,xlsx,pdf}"

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
					includeImages: false,
					includeTables: true,
					ocr: false,
				},
			}
		default:
			return null
	}
}

function baseDocConversionArgs(filePath: string): {
	inputs: string[]
	includeImages: boolean
	includeTables: boolean
	start: number
	end: number
} {
	return {
		inputs: [filePath],
		includeImages: false,
		includeTables: true,
		start: 1,
		end: 0,
	}
}

/**
 * Watches workspace for Office/PDF documents and queues conversion to Markdown via file-cool (MCP Gateway).
 */
export class DocumentMarkdownWatcher implements vscode.Disposable {
	private static instances = new Map<string, DocumentMarkdownWatcher>()

	private readonly workspacePath: string
	private readonly _folderUri: vscode.Uri
	private readonly context: vscode.ExtensionContext
	private readonly getGatewayConfig: () => Promise<GatewayConfig | null>
	private readonly getFeatureEnabled: () => boolean

	private fileWatcher?: vscode.FileSystemWatcher
	/** When a workspace `.md` is deleted, debounce and run a scan to re-convert sources missing output. */
	private mdDeleteWatcher?: vscode.FileSystemWatcher
	private mdDeleteScanTimer?: NodeJS.Timeout
	/** Set while converting; cleared in `runQueue` finally, then one deferred scan runs if needed. */
	private pendingScanAfterMdDelete = false

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
	) {
		this.workspacePath = workspacePath
		this._folderUri = folderUri
		this.context = context
		this.getGatewayConfig = getGatewayConfig
		this.getFeatureEnabled = getFeatureEnabled
		this.ignoreController = new RooIgnoreController(workspacePath)
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
	): Promise<void> {
		const folders = vscode.workspace.workspaceFolders
		if (!folders?.length) {
			return
		}
		for (const folder of folders) {
			const w = DocumentMarkdownWatcher.getInstance(context, folder.uri.fsPath, getGatewayConfig, getFeatureEnabled)
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
			this.fileWatcher.onDidCreate((uri) => this.enqueue(uri.fsPath))
			this.fileWatcher.onDidChange((uri) => this.enqueue(uri.fsPath))
		}
		if (!this.mdDeleteWatcher) {
			const mdPattern = new vscode.RelativePattern(this.workspacePath, "**/*.md")
			this.mdDeleteWatcher = vscode.workspace.createFileSystemWatcher(mdPattern)
			this.mdDeleteWatcher.onDidDelete((uri) => this.onMarkdownFileDeleted(uri.fsPath))
		}
		this.status.systemStatus = "Idle"
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
		this.pendingScanAfterMdDelete = false
		this.pendingPaths.clear()
		this.processingQueue = []
		this.isProcessing = false
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
	 * Finds supported documents under the workspace and enqueues them for conversion (manual "scan" from UI).
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

		const pattern = new vscode.RelativePattern(this.workspacePath, SUPPORTED_DOCS_RELATIVE_PATTERN)
		const uris = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git}/**", 5000)
		for (const uri of uris) {
			const fsPath = uri.fsPath
			const ext = path.extname(fsPath).toLowerCase()
			if (!DOCUMENT_EXTENSIONS.has(ext)) {
				continue
			}
			const relativeFilePath = generateRelativeFilePath(fsPath, this.workspacePath)
			if (isPathInIgnoredDirectory(relativeFilePath)) {
				continue
			}
			if (!this.ignoreController.validateAccess(fsPath)) {
				continue
			}
			this.enqueue(fsPath)
		}
		this.emitStatus()
	}

	private enqueue(fsPath: string): void {
		if (!this.isEffectiveEnabled) {
			return
		}
		const ext = path.extname(fsPath).toLowerCase()
		if (!DOCUMENT_EXTENSIONS.has(ext)) {
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

	private async convertOne(filePath: string): Promise<void> {
		try {
			const relativeFilePath = generateRelativeFilePath(filePath, this.workspacePath)
			if (isPathInIgnoredDirectory(relativeFilePath)) {
				return
			}
			if (!this.ignoreController.validateAccess(filePath)) {
				return
			}

			let stat: { size: number }
			try {
				const s = await fs.stat(filePath)
				stat = { size: s.size }
			} catch {
				return
			}

			if (stat.size > MAX_DOCUMENT_BYTES) {
				this.pushError(`${path.basename(filePath)}: file too large`)
				return
			}

			if (await this.outputMarkdownExists(filePath)) {
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
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.pushError(`${path.basename(filePath)}: ${msg}`)
		}
	}

	/** Same directory, same basename with `.md` — if present, skip conversion (no overwrite). */
	private async outputMarkdownExists(sourcePath: string): Promise<boolean> {
		const base = path.basename(sourcePath, path.extname(sourcePath))
		const mdPath = path.join(path.dirname(sourcePath), `${base}.md`)
		try {
			await fs.access(mdPath)
			return true
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
