import * as fs from "fs/promises"
import * as path from "path"
import { Mutex } from "async-mutex"
import { safeWriteJson } from "../../utils/safeWriteJson"

const SUBDIR = "long-term-memory"
const FILE = "sync-state.json"

export type ProcessedTaskRecord = {
	processedAt: number
	historyFingerprint: string
}

export type SyncStateFile = {
	version: 1
	processedTasks: Record<string, ProcessedTaskRecord>
	lastIngestRunAt?: number
}

const empty = (): SyncStateFile => ({ version: 1, processedTasks: {} })

export class LongTermMemorySyncStateStore {
	private readonly filePath: string
	private readonly mutex = new Mutex()

	constructor(globalStoragePath: string) {
		this.filePath = path.join(globalStoragePath, SUBDIR, FILE)
	}

	private async read(): Promise<SyncStateFile> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8")
			const data = JSON.parse(raw) as SyncStateFile
			if (!data || typeof data.processedTasks !== "object") {
				return empty()
			}
			return { version: 1, processedTasks: data.processedTasks ?? {}, lastIngestRunAt: data.lastIngestRunAt }
		} catch (e: unknown) {
			if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
				return empty()
			}
			return empty()
		}
	}

	async getProcessedFingerprint(taskId: string): Promise<string | undefined> {
		return this.mutex.runExclusive(async () => {
			const f = await this.read()
			return f.processedTasks[taskId]?.historyFingerprint
		})
	}

	async markProcessed(taskId: string, fingerprint: string): Promise<void> {
		return this.mutex.runExclusive(async () => {
			const f = await this.read()
			f.processedTasks[taskId] = { processedAt: Date.now(), historyFingerprint: fingerprint }
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await safeWriteJson(this.filePath, f)
		})
	}

	async setLastIngestRunAt(ts: number): Promise<void> {
		return this.mutex.runExclusive(async () => {
			const f = await this.read()
			f.lastIngestRunAt = ts
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await safeWriteJson(this.filePath, f)
		})
	}

	async clearAllProcessed(): Promise<void> {
		return this.mutex.runExclusive(async () => {
			const f = await this.read()
			f.processedTasks = {}
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await safeWriteJson(this.filePath, f)
		})
	}
}
