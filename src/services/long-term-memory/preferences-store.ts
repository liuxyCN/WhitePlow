import * as fs from "fs/promises"
import * as path from "path"
import { Mutex } from "async-mutex"
import { safeWriteJson } from "../../utils/safeWriteJson"

const SUBDIR = "long-term-memory"
const FILE = "preferences.json"

export type PreferencesFile = {
	schemaVersion: 1
	entries: Record<string, string | number | boolean>
}

const emptyFile = (): PreferencesFile => ({ schemaVersion: 1, entries: {} })

export class LongTermMemoryPreferencesStore {
	private readonly filePath: string
	private readonly mutex = new Mutex()

	constructor(globalStoragePath: string) {
		this.filePath = path.join(globalStoragePath, SUBDIR, FILE)
	}

	/** Absolute path to `preferences.json` under global storage. */
	getFilePath(): string {
		return this.filePath
	}

	/** Create parent dir and an empty preferences file if missing (so the file can be opened in the editor). */
	async ensureFileExists(): Promise<void> {
		return this.mutex.runExclusive(async () => {
			try {
				await fs.access(this.filePath)
			} catch {
				await fs.mkdir(path.dirname(this.filePath), { recursive: true })
				await safeWriteJson(this.filePath, emptyFile())
			}
		})
	}

	private async read(): Promise<PreferencesFile> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8")
			const data = JSON.parse(raw) as PreferencesFile
			if (!data || typeof data.entries !== "object") {
				return emptyFile()
			}
			return { schemaVersion: 1, entries: data.entries ?? {} }
		} catch (e: unknown) {
			if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
				return emptyFile()
			}
			return emptyFile()
		}
	}

	async getAll(): Promise<Record<string, string | number | boolean>> {
		return this.mutex.runExclusive(async () => {
			const f = await this.read()
			return { ...f.entries }
		})
	}

	async upsertEntries(partial: Record<string, string | number | boolean>): Promise<void> {
		return this.mutex.runExclusive(async () => {
			const f = await this.read()
			Object.assign(f.entries, partial)
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await safeWriteJson(this.filePath, f)
		})
	}

	async removeKey(key: string): Promise<void> {
		return this.mutex.runExclusive(async () => {
			const f = await this.read()
			delete f.entries[key]
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await safeWriteJson(this.filePath, f)
		})
	}

	async clear(): Promise<void> {
		return this.mutex.runExclusive(async () => {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			await safeWriteJson(this.filePath, emptyFile())
		})
	}

	formatForInjection(maxChars: number = 4000): string {
		// sync read would need async - injection path uses getAll in manager
		return ""
	}

	async getKeyCount(): Promise<number> {
		const e = await this.getAll()
		return Object.keys(e).length
	}
}
