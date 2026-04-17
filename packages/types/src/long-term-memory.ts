import { z } from "zod"

export const longTermMemoryConfigSchema = z.object({
	/** Master switch: retrieval + background ingest */
	longTermMemoryEnabled: z.boolean().optional(),
	/** Pause automatic history ingest */
	longTermMemoryPauseIngest: z.boolean().optional(),
	/** Max tasks to process per ingest run */
	longTermMemoryIngestMaxTasksPerRun: z.number().int().min(1).max(200).optional(),
	/**
	 * When true (default), a lightweight API call selects which memory keys to inject from the user message.
	 * When false, no automatic injection of structured memory into the prompt.
	 */
	longTermMemorySmartInject: z.boolean().optional(),
})

export type LongTermMemoryConfig = z.infer<typeof longTermMemoryConfigSchema>

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
