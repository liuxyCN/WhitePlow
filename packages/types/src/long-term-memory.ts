import { z } from "zod"

export const longTermMemoryAutoInjectSchema = z.enum(["none", "smart", "all"])
export type LongTermMemoryAutoInjectMode = z.infer<typeof longTermMemoryAutoInjectSchema>

export const longTermMemoryConfigSchema = z.object({
	/** Master switch: retrieval + background ingest */
	longTermMemoryEnabled: z.boolean().optional(),
	/** Pause automatic history ingest */
	longTermMemoryPauseIngest: z.boolean().optional(),
	/** Max tasks to process per ingest run */
	longTermMemoryIngestMaxTasksPerRun: z.number().int().min(1).max(200).optional(),
	/**
	 * @deprecated Prefer `longTermMemoryAutoInject`. When absent, `false` maps to `"none"`, otherwise legacy default matches `"smart"`.
	 */
	longTermMemorySmartInject: z.boolean().optional(),
	/**
	 * How structured long-term memory is prepended to the user turn: none, LLM-selected subset (smart), or sorted full list within char budget (all).
	 */
	longTermMemoryAutoInject: longTermMemoryAutoInjectSchema.optional(),
})

export type LongTermMemoryConfig = z.infer<typeof longTermMemoryConfigSchema>

/** Resolve inject mode from stored config, including legacy `longTermMemorySmartInject`. */
export function resolveLongTermMemoryAutoInject(cfg: LongTermMemoryConfig): LongTermMemoryAutoInjectMode {
	const m = cfg.longTermMemoryAutoInject
	if (m === "none" || m === "smart" || m === "all") {
		return m
	}
	if (cfg.longTermMemorySmartInject === false) {
		return "none"
	}
	return "smart"
}

export type LongTermMemorySystemStatus =
	| "Standby"
	| "Idle"
	| "Processing"
	| "Ingesting"
	| "Optimizing"
	| "Error"

export interface LongTermMemoryStatus {
	featureEnabled: boolean
	systemStatus: LongTermMemorySystemStatus
	message?: string
	processedItems: number
	totalItems: number
	recentErrors: string[]
	structuredKeyCount: number
}

/** Payload for extension → webview when listing stored memories. */
export interface LongTermMemoryContentsSnapshot {
	structured: Record<string, string | number | boolean>
}

/** Result of building the `<long_term_memory>` user-message injection block. */
export interface LongTermMemoryInjectionResult {
	text: string
	/** Number of structured keys included in `text` (after char budget). */
	keysInjected: number
}

/** Extension → webview after `longTermMemoryAddFromText` (manual memory extraction). */
export interface LongTermMemoryAddFromTextResultPayload {
	ok: boolean
	error?: string
	/** Keys that were written (new or updated). */
	keys?: string[]
}
