import type { ModelInfo } from "../model.js"

// ChinalifePE API
export type ChinalifePEModelId = keyof typeof chinalifePEModels

export const chinalifePEDefaultModelId: ChinalifePEModelId = "kimi-k2.6"

export const chinalifePEModels = {
	"kimi-k2.6": {
		maxTokens: 262_144, // 256K max output
		contextWindow: 262_144,
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: true,
		/** Gateway uses Kimi-style `thinking: { type: enabled|disabled }`; must be explicit when off. */
		supportsReasoningBinary: true,
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		isFree: true,
		description: `ChinalifePE Kimi K2.6 model`,
		supportsTemperature: true,
		preserveReasoning: true,
		defaultTemperature: 1.0
	},
} as const satisfies Record<string, ModelInfo>

export const CHINALIFEPE_DEFAULT_TEMPERATURE = 0.6
