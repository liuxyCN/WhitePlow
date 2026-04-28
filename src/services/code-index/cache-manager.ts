import * as vscode from "vscode"
import { createHash } from "crypto"
import { ICacheManager } from "./interfaces/cache"
import debounce from "lodash.debounce"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"

/** Workspace-local doc index dir (shared in repo; same root as vec.bin). */
const DOC_INDEX_SEGMENTS = [".roo", "doc-index"] as const

/**
 * Manages the cache for code indexing
 */
export class CacheManager implements ICacheManager {
	/** Primary location: `<workspace>/.roo/doc-index/roo-index-cache-<hash>.json` */
	private cachePath: vscode.Uri
	/** Legacy per-machine location; read once and migrate into `cachePath`. */
	private legacyGlobalCacheUri: vscode.Uri
	private fileHashes: Record<string, string> = {}
	private _debouncedSaveCache: () => void

	private static cacheFileName(workspacePath: string): string {
		return `roo-index-cache-${createHash("sha256").update(workspacePath).digest("hex")}.json`
	}

	/**
	 * Creates a new cache manager
	 * @param context VS Code extension context
	 * @param workspacePath Path to the workspace
	 */
	constructor(
		private context: vscode.ExtensionContext,
		private workspacePath: string,
	) {
		const fileName = CacheManager.cacheFileName(workspacePath)
		this.legacyGlobalCacheUri = vscode.Uri.joinPath(context.globalStorageUri, fileName)
		this.cachePath = vscode.Uri.joinPath(vscode.Uri.file(workspacePath), ...DOC_INDEX_SEGMENTS, fileName)
		this._debouncedSaveCache = debounce(async () => {
			await this._performSave()
		}, 1500)
	}

	private async loadHashesFromUri(uri: vscode.Uri): Promise<Record<string, string>> {
		const cacheData = await vscode.workspace.fs.readFile(uri)
		// readFile returns Uint8Array; default .toString() is comma-separated byte values, not UTF-8 text.
		const raw = Buffer.from(cacheData).toString("utf8")
		return JSON.parse(raw) as Record<string, string>
	}

	/**
	 * Initializes the cache manager by loading the cache file
	 */
	async initialize(): Promise<void> {
		try {
			this.fileHashes = await this.loadHashesFromUri(this.cachePath)
			return
		} catch {
			// Missing or unreadable workspace cache — try legacy global storage.
		}

		let legacyHashes: Record<string, string>
		try {
			legacyHashes = await this.loadHashesFromUri(this.legacyGlobalCacheUri)
		} catch (error) {
			this.fileHashes = {}
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "initialize",
			})
			return
		}

		this.fileHashes = legacyHashes
		try {
			await safeWriteJson(this.cachePath.fsPath, this.fileHashes)
		} catch (writeError) {
			console.warn("Failed to persist migrated code index cache to workspace (legacy file kept):", writeError)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: writeError instanceof Error ? writeError.message : String(writeError),
				stack: writeError instanceof Error ? writeError.stack : undefined,
				location: "initialize_migrate_write",
			})
			return
		}

		try {
			await vscode.workspace.fs.delete(this.legacyGlobalCacheUri, { useTrash: false })
		} catch (deleteError) {
			console.warn("Failed to remove legacy code index cache after migration:", deleteError)
		}
	}

	/**
	 * Saves the cache to disk
	 */
	private async _performSave(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, this.fileHashes)
		} catch (error) {
			console.error("Failed to save cache:", error)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "_performSave",
			})
		}
	}

	/**
	 * Clears the cache file by writing an empty object to it
	 */
	async clearCacheFile(): Promise<void> {
		try {
			await safeWriteJson(this.cachePath.fsPath, {})
			this.fileHashes = {}
		} catch (error) {
			console.error("Failed to clear cache file:", error, this.cachePath)
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "clearCacheFile",
			})
		}
	}

	/**
	 * Gets the hash for a file path
	 * @param filePath Path to the file
	 * @returns The hash for the file or undefined if not found
	 */
	getHash(filePath: string): string | undefined {
		return this.fileHashes[filePath]
	}

	/**
	 * Updates the hash for a file path
	 * @param filePath Path to the file
	 * @param hash New hash value
	 */
	updateHash(filePath: string, hash: string): void {
		this.fileHashes[filePath] = hash
		this._debouncedSaveCache()
	}

	/**
	 * Deletes the hash for a file path
	 * @param filePath Path to the file
	 */
	deleteHash(filePath: string): void {
		delete this.fileHashes[filePath]
		this._debouncedSaveCache()
	}

	/**
	 * Flushes any pending debounced cache writes to disk immediately.
	 */
	async flush(): Promise<void> {
		await this._performSave()
	}

	/**
	 * Gets a copy of all file hashes
	 * @returns A copy of the file hashes record
	 */
	getAllHashes(): Record<string, string> {
		return { ...this.fileHashes }
	}
}
