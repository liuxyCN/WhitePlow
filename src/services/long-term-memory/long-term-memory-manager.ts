import * as vscode from "vscode"
import * as fs from "fs/promises"
import { createHash } from "crypto"

import {
	type GlobalState,
	type LongTermMemoryConfig,
	type LongTermMemoryContentsSnapshot,
	type LongTermMemoryInjectionResult,
	type LongTermMemoryStatus,
	type LongTermMemorySystemStatus,
	type ProviderSettings,
	resolveLongTermMemoryAutoInject,
} from "@roo-code/types"

import { singleCompletionHandler } from "../../utils/single-completion-handler"
import { readApiMessages } from "../../core/task-persistence/apiMessages"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import type { TaskHistoryStore } from "../../core/task-persistence/TaskHistoryStore"

import { LongTermMemoryPreferencesStore } from "./preferences-store"
import { LongTermMemorySyncStateStore } from "./sync-state-store"
import { buildExtractionUserContent, buildManualMemoryExtractionUserContent } from "./extraction-prompt"
import { buildMemorySelectionUserContent } from "./memory-inject-selection-prompt"
import { buildOptimizationUserContent } from "./optimization-prompt"

const RECENT_ERRORS_MAX = 30
const DEFAULT_INGEST_MAX_TASKS = 12
/** Debounce after a new task starts before scanning other tasks’ history (avoid racing first save). */
const INGEST_DEBOUNCE_MS = 8_000
const TRANSCRIPT_MAX_CHARS = 24_000
const STRUCTURED_INJECT_MAX_CHARS = 5000
/** Max chars of user text sent into the routing prompt. */
const ROUTING_USER_TEXT_MAX = 8_192
/** Max chars of JSON(memory) in the routing prompt (avoid huge prompts). */
const ROUTING_MEMORY_JSON_MAX = 512_000
/** Max items accepted from optimize-memory LLM output (after validation). */
const OPTIMIZE_MAX_ITEMS = 500
const MANUAL_MEMORY_NOTE_MAX_CHARS = 12_000

/** Smart-inject key selection only: auxiliary `completePrompt` should not use reasoning (latency/cost). */
function providerSettingsForMemoryInjectSelection(base: ProviderSettings): ProviderSettings {
	return {
		...base,
		enableReasoningEffort: false,
		reasoningEffort: "disable",
	}
}

type ExtractedItem = { key: string; value: string | number | boolean }

export interface LongTermMemoryManagerDeps {
	context: vscode.ExtensionContext
	globalStoragePath: string
	getWorkspacePath: () => string | undefined
	getTaskHistoryStore: () => TaskHistoryStore
	getApiConfiguration: () => Promise<ProviderSettings>
	getGlobalState: <K extends keyof GlobalState>(key: K) => GlobalState[K] | undefined
	updateGlobalState: (values: Partial<Pick<GlobalState, "longTermMemoryConfig">>) => Promise<void>
	postMessage: (
		msg:
			| { type: "longTermMemoryStatusUpdate"; values: LongTermMemoryStatus }
			| { type: "longTermMemoryContents"; values: LongTermMemoryContentsSnapshot },
	) => void
	log: (message: string) => void
}

export class LongTermMemoryManager {
	private readonly prefs: LongTermMemoryPreferencesStore
	private readonly syncState: LongTermMemorySyncStateStore

	private recentErrors: string[] = []
	/** At rest (no ingest running) we report Idle so the UI shows “ready” (green), not Standby (gray). */
	private status: LongTermMemorySystemStatus = "Idle"
	private ingestProcessed = 0
	private ingestTotal = 0

	private ingestTimer: ReturnType<typeof setTimeout> | null = null
	private ingestRunning = false
	/** When true, start another ingest pass after the current one finishes (e.g. user clicked rescan while running). */
	private ingestQueued = false

	constructor(private readonly deps: LongTermMemoryManagerDeps) {
		this.prefs = new LongTermMemoryPreferencesStore(deps.globalStoragePath)
		this.syncState = new LongTermMemorySyncStateStore(deps.globalStoragePath)
	}

	private cfg(): LongTermMemoryConfig {
		return (this.deps.getGlobalState("longTermMemoryConfig") as LongTermMemoryConfig | undefined) ?? {}
	}

	isFeatureEnabled(): boolean {
		return this.cfg().longTermMemoryEnabled !== false
	}

	isIngestPaused(): boolean {
		return this.cfg().longTermMemoryPauseIngest === true
	}

	private pushError(msg: string): void {
		this.recentErrors = [...this.recentErrors.slice(-(RECENT_ERRORS_MAX - 1)), msg]
	}

	async getContentsSnapshot(): Promise<LongTermMemoryContentsSnapshot> {
		const structured = await this.prefs.getAll()
		return { structured }
	}

	/** Open the on-disk preferences JSON in the active editor (creates an empty file if it does not exist yet). */
	async openPreferencesFileInEditor(): Promise<void> {
		await this.prefs.ensureFileExists()
		const uri = vscode.Uri.file(this.prefs.getFilePath())
		const doc = await vscode.workspace.openTextDocument(uri)
		await vscode.window.showTextDocument(doc)
	}

	async getStatus(): Promise<LongTermMemoryStatus> {
		const structuredCount = await this.prefs.getKeyCount()
		return {
			featureEnabled: this.isFeatureEnabled(),
			systemStatus: this.status,
			processedItems: this.ingestProcessed,
			totalItems: this.ingestTotal,
			recentErrors: [...this.recentErrors],
			structuredKeyCount: structuredCount,
		}
	}

	/** Push current status to webview (e.g. when webview resolves after extension activation). */
	async postStatusToWebview(): Promise<void> {
		await this.broadcastStatus()
	}

	private async broadcastStatus(): Promise<void> {
		this.deps.postMessage({ type: "longTermMemoryStatusUpdate", values: await this.getStatus() })
	}

	private async broadcastContentsSnapshot(): Promise<void> {
		try {
			const values = await this.getContentsSnapshot()
			this.deps.postMessage({ type: "longTermMemoryContents", values })
		} catch (e) {
			this.deps.log(
				`[LongTermMemory] broadcastContentsSnapshot failed: ${e instanceof Error ? e.message : String(e)}`,
			)
			try {
				const structured = await this.prefs.getAll()
				this.deps.postMessage({ type: "longTermMemoryContents", values: { structured } })
			} catch {
				this.deps.postMessage({ type: "longTermMemoryContents", values: { structured: {} } })
			}
		}
	}

	/**
	 * First API turn: inject structured preferences as context.
	 * `none`: no injection. `all`: sorted keys within char budget (no routing LLM). `smart`: routing LLM when user text is present, else sorted fallback.
	 */
	async buildInjectionBlock(userMessageText?: string): Promise<LongTermMemoryInjectionResult> {
		const empty = (): LongTermMemoryInjectionResult => ({ text: "", keysInjected: 0 })
		if (!this.isFeatureEnabled()) {
			return empty()
		}
		const mode = resolveLongTermMemoryAutoInject(this.cfg())
		if (mode === "none") {
			return empty()
		}
		const entries = await this.prefs.getAll()
		const allKeys = Object.keys(entries)
		if (allKeys.length === 0) {
			return empty()
		}
		if (mode === "all") {
			return this.legacySortedInjection(entries)
		}

		const trimmedUser = userMessageText?.trim() ?? ""
		const useSmart = trimmedUser.length > 0

		if (useSmart) {
			const selected = await this.selectRelevantKeysWithLlm(trimmedUser.slice(0, ROUTING_USER_TEXT_MAX), entries)
			if (selected !== null) {
				if (selected.length === 0) {
					return empty()
				}
				const subset: Record<string, string | number | boolean> = {}
				for (const k of selected) {
					if (k in entries) {
						subset[k] = entries[k]
					}
				}
				if (Object.keys(subset).length === 0) {
					return this.legacySortedInjection(entries)
				}
				return this.formatInjectionBlock(subset, selected)
			}
		}

		return this.legacySortedInjection(entries)
	}

	private legacySortedInjection(entries: Record<string, string | number | boolean>): LongTermMemoryInjectionResult {
		const keys = Object.keys(entries).sort()
		return this.formatInjectionBlock(
			Object.fromEntries(keys.map((k) => [k, entries[k]])),
			keys,
		)
	}

	/** Build XML block from a subset of entries; `keyOrder` controls iteration order; enforces STRUCTURED_INJECT_MAX_CHARS. */
	private formatInjectionBlock(
		entries: Record<string, string | number | boolean>,
		keyOrder: string[],
	): LongTermMemoryInjectionResult {
		let structured = "# 长期记忆（基础偏好）\n"
		let n = 0
		for (const k of keyOrder) {
			if (!(k in entries)) {
				continue
			}
			const line = `- \`${k}\`: ${String(entries[k])}\n`
			if (structured.length + line.length > STRUCTURED_INJECT_MAX_CHARS) {
				break
			}
			structured += line
			n++
		}
		if (n === 0) {
			return { text: "", keysInjected: 0 }
		}
		return {
			text: `<long_term_memory>\n${structured.trimEnd()}\n</long_term_memory>\n\n`,
			keysInjected: n,
		}
	}

	private truncateEntriesJsonForRouting(entries: Record<string, string | number | boolean>): string {
		const keys = Object.keys(entries).sort()
		const acc: Record<string, string | number | boolean> = {}
		for (const k of keys) {
			const next = { ...acc, [k]: entries[k] }
			if (JSON.stringify(next).length > ROUTING_MEMORY_JSON_MAX) {
				break
			}
			acc[k] = entries[k]
		}
		if (Object.keys(acc).length > 0) {
			return JSON.stringify(acc)
		}
		// Single entry may exceed budget alone — truncate string representation for routing only
		const k0 = keys[0]
		const v = entries[k0]
		const budget = ROUTING_MEMORY_JSON_MAX - 64
		const asWire =
			typeof v === "string"
				? v.length > budget
					? `${v.slice(0, budget)}…`
					: v
				: (() => {
						const s = JSON.stringify(v)
						return s.length > budget ? `${s.slice(0, budget)}…` : s
					})()
		return JSON.stringify({ [k0]: asWire })
	}

	private parseSelectionKeys(
		raw: string,
		validKeys: Set<string>,
	): { keys: string[] } | "invalid" | "fallback" {
		let s = raw.trim()
		const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(s)
		if (fence) {
			s = fence[1].trim()
		}
		try {
			const data = JSON.parse(s) as { keys?: unknown }
			if (!Array.isArray(data.keys)) {
				return "invalid"
			}
			const requested = data.keys.filter((k): k is string => typeof k === "string")
			const matched = requested.filter((k) => validKeys.has(k))
			if (requested.length > 0 && matched.length === 0) {
				return "fallback"
			}
			const seen = new Set<string>()
			const deduped: string[] = []
			for (const k of matched) {
				if (!seen.has(k)) {
					seen.add(k)
					deduped.push(k)
				}
			}
			return { keys: deduped }
		} catch {
			return "invalid"
		}
	}

	private async selectRelevantKeysWithLlm(
		userText: string,
		entries: Record<string, string | number | boolean>,
	): Promise<string[] | null> {
		try {
			const api = providerSettingsForMemoryInjectSelection(await this.deps.getApiConfiguration())
			const memoriesJson = this.truncateEntriesJsonForRouting(entries)
			const prompt = buildMemorySelectionUserContent(userText, memoriesJson)
			const raw = await singleCompletionHandler(api, prompt)
			const valid = new Set(Object.keys(entries))
			const parsed = this.parseSelectionKeys(raw, valid)
			if (parsed === "invalid") {
				this.deps.log("[LongTermMemory] smart inject: invalid JSON, using sorted fallback")
				return null
			}
			if (parsed === "fallback") {
				this.deps.log("[LongTermMemory] smart inject: no matching keys in response, using sorted fallback")
				return null
			}
			return parsed.keys
		} catch (e) {
			this.deps.log(
				`[LongTermMemory] smart inject failed: ${e instanceof Error ? e.message : String(e)}; using sorted fallback`,
			)
			return null
		}
	}

	/** After a new task is created, debounce then ingest all tasks with new/changed API history (sync-state dedupes). */
	scheduleIngestAfterNewTask(): void {
		if (!this.isFeatureEnabled() || this.isIngestPaused()) {
			return
		}
		if (this.ingestTimer) {
			clearTimeout(this.ingestTimer)
		}
		this.ingestTimer = setTimeout(() => {
			this.ingestTimer = null
			void this.runIngestBatch()
		}, INGEST_DEBOUNCE_MS)
	}

	private async historyFingerprint(globalStoragePath: string, taskId: string): Promise<string | null> {
		try {
			const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
			const fp = `${taskDir}/${GlobalFileNames.apiConversationHistory}`
			const buf = await fs.readFile(fp)
			return createHash("sha256").update(buf).digest("hex")
		} catch {
			return null
		}
	}

	private apiMessagesToTranscript(messages: import("../../core/task-persistence/apiMessages").ApiMessage[]): string {
		let out = ""
		for (const m of messages) {
			if (m.role !== "user" && m.role !== "assistant") {
				continue
			}
			const c = m.content
			if (typeof c === "string") {
				out += `\n${m.role}: ${c}\n`
			} else if (Array.isArray(c)) {
				for (const block of c) {
					if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
						out += `\n${m.role}: ${String((block as { text: string }).text)}\n`
					}
				}
			}
			if (out.length > TRANSCRIPT_MAX_CHARS) {
				break
			}
		}
		return out.slice(0, TRANSCRIPT_MAX_CHARS)
	}

	private parseStructuredItemsFromLlm(raw: string, maxItems: number): ExtractedItem[] {
		let s = raw.trim()
		const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(s)
		if (fence) {
			s = fence[1].trim()
		}
		try {
			const data = JSON.parse(s) as { items?: unknown[] }
			if (!Array.isArray(data.items)) {
				return []
			}
			const out: ExtractedItem[] = []
			for (const it of data.items) {
				if (!it || typeof it !== "object") {
					continue
				}
				const o = it as Record<string, unknown>
				if (typeof o.key === "string" && /^[a-zA-Z0-9_.]+$/.test(o.key)) {
					const v = o.value
					if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
						if (!this.looksLikeSecret(String(v))) {
							out.push({ key: o.key, value: v })
						}
					}
				}
			}
			return out.slice(0, maxItems)
		} catch {
			return []
		}
	}

	private parseExtractionJson(raw: string): ExtractedItem[] {
		return this.parseStructuredItemsFromLlm(raw, 15)
	}

	private looksLikeSecret(s: string): boolean {
		return /sk-[A-Za-z0-9]{20,}/.test(s) || /api[_-]?key\s*[:=]\s*\S{8,}/i.test(s)
	}

	async runIngestBatch(): Promise<void> {
		if (!this.isFeatureEnabled() || this.isIngestPaused()) {
			// e.g. user clicked rescan while ingest is paused — still push snapshot so UI loading clears
			await this.broadcastContentsSnapshot()
			return
		}
		if (this.ingestRunning) {
			this.ingestQueued = true
			return
		}
		this.ingestRunning = true
		this.status = "Ingesting"
		this.ingestProcessed = 0
		await this.broadcastStatus()

		try {
			let api: ProviderSettings
			try {
				api = await this.deps.getApiConfiguration()
			} catch (e) {
				this.pushError(`无法读取 API 配置：${e instanceof Error ? e.message : String(e)}`)
				this.status = "Error"
				await this.broadcastStatus()
				return
			}

			const maxTasks = this.cfg().longTermMemoryIngestMaxTasksPerRun ?? DEFAULT_INGEST_MAX_TASKS
			const items = this.deps.getTaskHistoryStore().getAll()
			const candidates: { id: string; fp: string }[] = []
			for (const h of items) {
				if (!h.task) {
					continue
				}
				const fp = await this.historyFingerprint(this.deps.globalStoragePath, h.id)
				if (!fp) {
					continue
				}
				const prev = await this.syncState.getProcessedFingerprint(h.id)
				if (prev === fp) {
					continue
				}
				candidates.push({ id: h.id, fp })
				if (candidates.length >= maxTasks) {
					break
				}
			}

			this.ingestTotal = candidates.length
			await this.broadcastStatus()

			for (const { id: taskId, fp } of candidates) {
				try {
					const messages = await readApiMessages({
						taskId,
						globalStoragePath: this.deps.globalStoragePath,
					})
					const transcript = this.apiMessagesToTranscript(messages)
					if (transcript.trim().length < 20) {
						await this.syncState.markProcessed(taskId, fp)
						this.ingestProcessed++
						await this.broadcastStatus()
						continue
					}
					const prompt = buildExtractionUserContent(taskId, transcript)
					const raw = await singleCompletionHandler(api, prompt)
					const extracted = this.parseExtractionJson(raw)
					const structured: Record<string, string | number | boolean> = {}
					for (const it of extracted) {
						structured[it.key] = it.value
					}
					if (Object.keys(structured).length > 0) {
						await this.prefs.upsertEntries(structured)
					}
					await this.syncState.markProcessed(taskId, fp)
				} catch (e) {
					this.pushError(`任务 ${taskId}: ${e instanceof Error ? e.message : String(e)}`)
				}
				this.ingestProcessed++
				await this.broadcastStatus()
			}

			await this.syncState.setLastIngestRunAt(Date.now())
			this.status = "Idle"
		} finally {
			this.ingestRunning = false
			if (this.status === "Ingesting") {
				this.status = "Idle"
			}
			await this.broadcastStatus()
			await this.broadcastContentsSnapshot()
			const runAgain = this.ingestQueued
			this.ingestQueued = false
			if (runAgain) {
				void this.runIngestBatch()
			}
		}
	}

	async clearRecentErrors(): Promise<void> {
		this.recentErrors = []
		await this.broadcastStatus()
	}

	async clearStructuredMemory(): Promise<void> {
		await this.prefs.clear()
		await this.broadcastStatus()
		await this.broadcastContentsSnapshot()
	}

	/**
	 * Remove one structured memory key. Key must match stored keys (`[a-zA-Z0-9_.]+`).
	 */
	/**
	 * Same LLM JSON schema as background ingest (`parseExtractionJson`), driven by user-typed note from the webview.
	 */
	async addMemoryFromUserNote(
		text: string,
	): Promise<{ ok: true; keys: string[] } | { ok: false; error: string }> {
		if (!this.isFeatureEnabled()) {
			return { ok: false, error: "长期记忆已关闭。" }
		}
		const trimmed = text.trim()
		if (trimmed.length < 5) {
			return { ok: false, error: "请输入至少几个字的说明。" }
		}
		const note = trimmed.slice(0, MANUAL_MEMORY_NOTE_MAX_CHARS)
		try {
			let api: ProviderSettings
			try {
				api = await this.deps.getApiConfiguration()
			} catch (e) {
				return { ok: false, error: `无法读取 API 配置：${e instanceof Error ? e.message : String(e)}` }
			}
			const prompt = buildManualMemoryExtractionUserContent(note)
			const raw = await singleCompletionHandler(api, prompt)
			const extracted = this.parseExtractionJson(raw)
			const structured: Record<string, string | number | boolean> = {}
			for (const it of extracted) {
				structured[it.key] = it.value
			}
			const keys = Object.keys(structured)
			if (keys.length === 0) {
				return { ok: false, error: "未能提取到可保存的结构化记忆，请改写后重试。" }
			}
			await this.prefs.upsertEntries(structured)
			await this.broadcastStatus()
			await this.broadcastContentsSnapshot()
			return { ok: true, keys }
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.pushError(`手动添加记忆失败：${msg}`)
			return { ok: false, error: msg }
		}
	}

	async deleteStructuredKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const k = key.trim()
		if (!this.isFeatureEnabled()) {
			return { ok: false, error: "长期记忆已关闭。" }
		}
		if (!/^[a-zA-Z0-9_.]+$/.test(k)) {
			return { ok: false, error: "无效的记忆键。" }
		}
		const entries = await this.prefs.getAll()
		if (!(k in entries)) {
			return { ok: false, error: `不存在键：${k}` }
		}
		await this.prefs.removeKey(k)
		await this.broadcastStatus()
		await this.broadcastContentsSnapshot()
		return { ok: true }
	}

	/**
	 * Send all structured memories to the model to dedupe and rewrite, then replace the store.
	 */
	async optimizeStructuredMemory(
		userFocus?: string,
	): Promise<{ ok: true; beforeCount: number; afterCount: number } | { ok: false; error: string }> {
		if (!this.isFeatureEnabled()) {
			return { ok: false, error: "长期记忆已关闭。" }
		}
		const entries = await this.prefs.getAll()
		const beforeCount = Object.keys(entries).length
		if (beforeCount === 0) {
			return { ok: false, error: "没有可优化的结构化记忆。" }
		}

		const prevStatus = this.status
		this.status = "Optimizing"
		await this.broadcastStatus()

		try {
			let api: ProviderSettings
			try {
				api = await this.deps.getApiConfiguration()
			} catch (e) {
				return { ok: false, error: `无法读取 API 配置：${e instanceof Error ? e.message : String(e)}` }
			}

			const memoriesJson = this.truncateEntriesJsonForRouting(entries)
			const focus =
				userFocus && userFocus.trim().length > 0 ? userFocus.trim() : undefined
			const prompt = buildOptimizationUserContent(memoriesJson, focus)
			const raw = await singleCompletionHandler(api, prompt)
			const extracted = this.parseStructuredItemsFromLlm(raw, OPTIMIZE_MAX_ITEMS)
			const structured: Record<string, string | number | boolean> = {}
			for (const it of extracted) {
				structured[it.key] = it.value
			}
			if (Object.keys(structured).length === 0) {
				return { ok: false, error: "优化未产生有效条目，请稍后重试。" }
			}
			await this.prefs.clear()
			await this.prefs.upsertEntries(structured)
			const afterCount = Object.keys(structured).length
			return { ok: true, beforeCount, afterCount }
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.pushError(`优化记忆失败：${msg}`)
			return { ok: false, error: msg }
		} finally {
			this.status = prevStatus
			await this.broadcastStatus()
			// Always push contents so webview can clear loading state (requestLongTermMemoryContents flow).
			await this.broadcastContentsSnapshot()
		}
	}

	/** Clear incremental sync markers and run ingest immediately (not debounced). */
	async rescanAllHistory(): Promise<void> {
		if (this.ingestTimer) {
			clearTimeout(this.ingestTimer)
			this.ingestTimer = null
		}
		await this.syncState.clearAllProcessed()
		if (this.ingestRunning) {
			this.ingestQueued = true
		} else {
			void this.runIngestBatch()
		}
		await this.broadcastStatus()
	}
}
