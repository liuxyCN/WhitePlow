import * as fs from "fs/promises"
import * as path from "path"
import { Mutex } from "async-mutex"
import { v5 as uuidv5 } from "uuid"
import { IVectorStore } from "../interfaces/vector-store"
import { Payload, VectorStoreSearchResult } from "../interfaces"
import { DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_SEARCH_MIN_SCORE, QDRANT_CODE_BLOCK_NAMESPACE } from "../constants"
import { t } from "../../../i18n"

/** In-memory shape matches JSON embedded store for shared semantics. */
const STORE_VERSION = 1 as const
const COLLECTION_DIR = "doc-index"
const COLLECTION_FILE = "vec.bin"
/** Same directory as `vec.bin`; full write goes here first, then `rename` replaces the live file (atomic on POSIX). */
const COLLECTION_FILE_TMP = `${COLLECTION_FILE}.tmp`

/** On-disk format version (header); bump when binary layout changes. Not compatible with v1 (float32). */
const FILE_VERSION = 2 as const
/** 8-byte magic: ASCII `ROOVEC02` (float64 vectors). */
const MAGIC = Buffer.from("ROOVEC02", "ascii")

type PersistedPoint = {
	id: string
	vector: number[]
	payload: Record<string, unknown>
}

type PersistedStore = {
	version: typeof STORE_VERSION
	vectorSize: number
	points: PersistedPoint[]
}

/**
 * Binary embedded vector index: `<workspace>/.roo/doc-index/vec.bin`.
 * Vectors as float64 LE (same precision as JSON / JS `number`); payload as length-prefixed UTF-8 JSON per point.
 * Format v2 only; older `vec.bin` (v1 float32) is not read — delete and re-index.
 *
 * Persistence: writes complete content to `vec.bin.tmp` then `rename`s to `vec.bin` so a crash mid-write
 * leaves the previous `vec.bin` intact (or absent if first create failed before rename).
 */
export class EmbeddedVectorStoreBinary implements IVectorStore {
	private readonly vectorSize: number
	private readonly workspacePath: string
	private readonly collectionDir: string
	private readonly storePath: string
	private readonly storePathTmp: string
	private readonly mutex = new Mutex()
	private memory: PersistedStore | null = null
	private dimensionMismatchFromDisk = false

	constructor(workspacePath: string, vectorSize: number) {
		this.workspacePath = workspacePath
		this.vectorSize = vectorSize
		this.collectionDir = path.join(workspacePath, ".roo", COLLECTION_DIR)
		this.storePath = path.join(this.collectionDir, COLLECTION_FILE)
		this.storePathTmp = path.join(this.collectionDir, COLLECTION_FILE_TMP)
	}

	private get metadataId(): string {
		return uuidv5("__indexing_metadata__", QDRANT_CODE_BLOCK_NAMESPACE)
	}

	private enrichPayload(point: {
		id: string
		vector: number[]
		payload: Record<string, any>
	}): PersistedPoint {
		const payload = { ...point.payload }
		if (payload.filePath && typeof payload.filePath === "string") {
			const segments = payload.filePath.split(path.sep).filter(Boolean)
			const pathSegments = segments.reduce(
				(acc: Record<string, string>, segment: string, index: number) => {
					acc[index.toString()] = segment
					return acc
				},
				{},
			)
			return {
				id: point.id,
				vector: point.vector,
				payload: { ...payload, pathSegments },
			}
		}
		return { id: point.id, vector: point.vector, payload }
	}

	private parseBuffer(buf: Buffer): PersistedStore {
		if (buf.length < 20) {
			throw new Error("invalid store")
		}
		if (!buf.subarray(0, 8).equals(MAGIC)) {
			throw new Error("invalid store")
		}
		const version = buf.readUInt32LE(8)
		const fileVectorSize = buf.readUInt32LE(12)
		const pointCount = buf.readUInt32LE(16)
		if (version !== FILE_VERSION) {
			throw new Error("invalid store")
		}
		if (fileVectorSize !== this.vectorSize) {
			this.dimensionMismatchFromDisk = true
			const empty: PersistedStore = {
				version: STORE_VERSION,
				vectorSize: this.vectorSize,
				points: [],
			}
			this.memory = empty
			return empty
		}

		let offset = 20
		const points: PersistedPoint[] = []
		const vecByteLen = fileVectorSize * 8

		for (let i = 0; i < pointCount; i++) {
			if (offset + 4 > buf.length) {
				throw new Error("invalid store")
			}
			const idLen = buf.readUInt32LE(offset)
			offset += 4
			if (idLen > buf.length || offset + idLen > buf.length) {
				throw new Error("invalid store")
			}
			const id = buf.subarray(offset, offset + idLen).toString("utf8")
			offset += idLen

			if (offset + vecByteLen > buf.length) {
				throw new Error("invalid store")
			}
			const vector: number[] = new Array(fileVectorSize)
			for (let j = 0; j < fileVectorSize; j++) {
				vector[j] = buf.readDoubleLE(offset + j * 8)
			}
			offset += vecByteLen

			if (offset + 4 > buf.length) {
				throw new Error("invalid store")
			}
			const payloadLen = buf.readUInt32LE(offset)
			offset += 4
			if (offset + payloadLen > buf.length) {
				throw new Error("invalid store")
			}
			let payload: Record<string, unknown>
			try {
				payload = JSON.parse(buf.subarray(offset, offset + payloadLen).toString("utf8")) as Record<
					string,
					unknown
				>
			} catch {
				throw new Error("invalid store")
			}
			offset += payloadLen
			points.push({ id, vector, payload })
		}

		if (offset !== buf.length) {
			throw new Error("invalid store")
		}

		const store: PersistedStore = {
			version: STORE_VERSION,
			vectorSize: fileVectorSize,
			points,
		}
		this.memory = store
		return store
	}

	private async load(): Promise<PersistedStore> {
		if (this.memory) {
			try {
				await fs.access(this.storePath)
			} catch (e: unknown) {
				const code = (e as NodeJS.ErrnoException)?.code
				if (code === "ENOENT") {
					this.memory = null
					this.dimensionMismatchFromDisk = false
				} else {
					throw e
				}
			}
			if (this.memory) {
				return this.memory
			}
		}
		try {
			const buf = await fs.readFile(this.storePath)
			return this.parseBuffer(buf)
		} catch (e: unknown) {
			const code = (e as NodeJS.ErrnoException)?.code
			if (code === "ENOENT") {
				const empty: PersistedStore = { version: STORE_VERSION, vectorSize: this.vectorSize, points: [] }
				this.memory = empty
				return empty
			}
			throw e
		}
	}

	private async save(data: PersistedStore): Promise<void> {
		await fs.mkdir(this.collectionDir, { recursive: true })
		// Remove leftover tmp from an earlier crash after full write but before rename.
		await fs.unlink(this.storePathTmp).catch((e: NodeJS.ErrnoException) => {
			if (e.code !== "ENOENT") {
				throw e
			}
		})

		const header = Buffer.allocUnsafe(20)
		MAGIC.copy(header, 0)
		header.writeUInt32LE(FILE_VERSION, 8)
		header.writeUInt32LE(this.vectorSize, 12)
		header.writeUInt32LE(data.points.length, 16)

		const fh = await fs.open(this.storePathTmp, "w")
		try {
			await fh.write(header, 0, 20, 0)
			let position = 20
			const idLenBuf = Buffer.allocUnsafe(4)
			const payloadLenBuf = Buffer.allocUnsafe(4)
			const vecBuf = Buffer.allocUnsafe(8 * this.vectorSize)

			for (const p of data.points) {
				const idBuf = Buffer.from(p.id, "utf8")
				idLenBuf.writeUInt32LE(idBuf.length, 0)
				await fh.write(idLenBuf, 0, 4, position)
				position += 4
				if (idBuf.length > 0) {
					await fh.write(idBuf, 0, idBuf.length, position)
					position += idBuf.length
				}

				for (let i = 0; i < this.vectorSize; i++) {
					vecBuf.writeDoubleLE(p.vector[i] ?? 0, i * 8)
				}
				await fh.write(vecBuf, 0, vecBuf.length, position)
				position += vecBuf.length

				const payloadBuf = Buffer.from(JSON.stringify(p.payload), "utf8")
				payloadLenBuf.writeUInt32LE(payloadBuf.length, 0)
				await fh.write(payloadLenBuf, 0, 4, position)
				position += 4
				if (payloadBuf.length > 0) {
					await fh.write(payloadBuf, 0, payloadBuf.length, position)
					position += payloadBuf.length
				}
			}
		} finally {
			await fh.close()
		}

		await fs.rename(this.storePathTmp, this.storePath)

		this.dimensionMismatchFromDisk = false
		this.memory = data
	}

	private async withStore<T>(fn: (store: PersistedStore) => Promise<T>): Promise<T> {
		return this.mutex.runExclusive(async () => {
			const store = await this.load()
			return fn(store)
		})
	}

	private static cosineScore(a: number[], b: number[]): number {
		let dot = 0
		let na = 0
		let nb = 0
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i]
			na += a[i] * a[i]
			nb += b[i] * b[i]
		}
		const denom = Math.sqrt(na) * Math.sqrt(nb)
		if (denom === 0) {
			return 0
		}
		const cos = dot / denom
		return Math.max(0, Math.min(1, (cos + 1) / 2))
	}

	private isMetadataPayload(p: Record<string, unknown>): boolean {
		return p.type === "metadata"
	}

	private isPayloadValid(payload: Record<string, unknown> | undefined): payload is Payload {
		if (!payload || this.isMetadataPayload(payload)) {
			return false
		}
		const validKeys = ["filePath", "codeChunk", "startLine", "endLine"]
		return validKeys.every((key) => key in payload)
	}

	private matchesDirectoryPrefix(payload: Record<string, unknown>, directoryPrefix: string | undefined): boolean {
		if (!directoryPrefix) {
			return true
		}
		const normalizedPrefix = path.posix.normalize(directoryPrefix.replace(/\\/g, "/"))
		if (normalizedPrefix === "." || normalizedPrefix === "./") {
			return true
		}
		const cleanedPrefix = path.posix.normalize(
			normalizedPrefix.startsWith("./") ? normalizedPrefix.slice(2) : normalizedPrefix,
		)
		const segments = cleanedPrefix.split("/").filter(Boolean)
		if (segments.length === 0) {
			return true
		}
		const ps = payload.pathSegments as Record<string, string> | undefined
		if (!ps) {
			return false
		}
		return segments.every((seg, i) => ps[i.toString()] === seg)
	}

	async initialize(): Promise<boolean> {
		try {
			return await this.withStore(async (store) => {
				let fileExisted = true
				try {
					await fs.access(this.storePath)
				} catch {
					fileExisted = false
				}
				if (!fileExisted) {
					await this.save({
						version: STORE_VERSION,
						vectorSize: this.vectorSize,
						points: [],
					})
					return true
				}
				if (this.dimensionMismatchFromDisk) {
					await this.save({
						version: STORE_VERSION,
						vectorSize: this.vectorSize,
						points: [],
					})
					return true
				}
				return false
			})
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			console.error(`[EmbeddedVectorStoreBinary] Failed to initialize at ${this.storePath}:`, errorMessage)
			throw new Error(
				t("embeddings:vectorStore.embeddedStoreLoadFailed", { path: this.storePath, errorMessage }),
			)
		}
	}

	async upsertPoints(
		points: Array<{ id: string; vector: number[]; payload: Record<string, any> }>,
	): Promise<void> {
		if (points.length === 0) {
			return
		}
		await this.withStore(async (store) => {
			const byId = new Map(store.points.map((p) => [p.id, p]))
			for (const p of points) {
				if (p.vector.length !== this.vectorSize) {
					continue
				}
				byId.set(p.id, this.enrichPayload(p))
			}
			store.points = Array.from(byId.values())
			await this.save(store)
		})
	}

	async search(
		queryVector: number[],
		directoryPrefix?: string,
		minScore?: number,
		maxResults?: number,
	): Promise<VectorStoreSearchResult[]> {
		if (queryVector.length !== this.vectorSize) {
			return []
		}
		const limit = maxResults ?? DEFAULT_MAX_SEARCH_RESULTS
		const threshold = minScore ?? DEFAULT_SEARCH_MIN_SCORE

		return this.withStore(async (store) => {
			const scored: VectorStoreSearchResult[] = []
			for (const p of store.points) {
				if (this.isMetadataPayload(p.payload)) {
					continue
				}
				if (!this.matchesDirectoryPrefix(p.payload, directoryPrefix)) {
					continue
				}
				if (p.vector.length !== this.vectorSize) {
					continue
				}
				const score = EmbeddedVectorStoreBinary.cosineScore(queryVector, p.vector)
				if (score < threshold) {
					continue
				}
				if (!this.isPayloadValid(p.payload)) {
					continue
				}
				scored.push({
					id: p.id,
					score,
					payload: {
						filePath: p.payload.filePath as string,
						codeChunk: p.payload.codeChunk as string,
						startLine: Number(p.payload.startLine),
						endLine: Number(p.payload.endLine),
					},
				})
			}
			scored.sort((a, b) => b.score - a.score)
			return scored.slice(0, limit)
		})
	}

	async deletePointsByFilePath(filePath: string): Promise<void> {
		return this.deletePointsByMultipleFilePaths([filePath])
	}

	async deletePointsByMultipleFilePaths(filePaths: string[]): Promise<void> {
		if (filePaths.length === 0) {
			return
		}
		await this.withStore(async (store) => {
			const workspaceRoot = this.workspacePath
			const shouldDelete = (payload: Record<string, unknown>) => {
				if (this.isMetadataPayload(payload)) {
					return false
				}
				const fp = payload.filePath as string | undefined
				if (!fp) {
					return false
				}
				return filePaths.some((filePath) => {
					const relativePath = path.isAbsolute(filePath) ? path.relative(workspaceRoot, filePath) : filePath
					const normalized = path.normalize(relativePath)
					return normalized === fp || path.normalize(fp) === normalized
				})
			}
			store.points = store.points.filter((p) => !shouldDelete(p.payload))
			await this.save(store)
		})
	}

	async clearCollection(): Promise<void> {
		await this.withStore(async (store) => {
			store.points = []
			await this.save(store)
		})
	}

	async deleteCollection(): Promise<void> {
		await this.mutex.runExclusive(async () => {
			for (const p of [this.storePath, this.storePathTmp]) {
				try {
					await fs.unlink(p)
				} catch (e: unknown) {
					const code = (e as NodeJS.ErrnoException)?.code
					if (code !== "ENOENT") {
						throw e
					}
				}
			}
			this.memory = null
		})
	}

	async collectionExists(): Promise<boolean> {
		try {
			await fs.access(this.storePath)
			return true
		} catch {
			return false
		}
	}

	async hasIndexedData(): Promise<boolean> {
		try {
			return await this.withStore(async (store) => {
				const codePoints = store.points.filter((p) => !this.isMetadataPayload(p.payload))
				if (codePoints.length === 0) {
					return false
				}
				const meta = store.points.find((p) => p.id === this.metadataId)
				if (meta && meta.payload.indexing_complete === true) {
					return true
				}
				return codePoints.length > 0
			})
		} catch (error) {
			console.warn("[EmbeddedVectorStoreBinary] Failed to check indexed data:", error)
			return false
		}
	}

	async markIndexingComplete(): Promise<void> {
		const metadataId = this.metadataId
		await this.withStore(async (store) => {
			const rest = store.points.filter((p) => p.id !== metadataId)
			rest.push({
				id: metadataId,
				vector: new Array(this.vectorSize).fill(0),
				payload: {
					type: "metadata",
					indexing_complete: true,
					completed_at: Date.now(),
				},
			})
			store.points = rest
			await this.save(store)
		})
	}

	async markIndexingIncomplete(): Promise<void> {
		const metadataId = this.metadataId
		await this.withStore(async (store) => {
			const rest = store.points.filter((p) => p.id !== metadataId)
			rest.push({
				id: metadataId,
				vector: new Array(this.vectorSize).fill(0),
				payload: {
					type: "metadata",
					indexing_complete: false,
					started_at: Date.now(),
				},
			})
			store.points = rest
			await this.save(store)
		})
	}
}
