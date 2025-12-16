import type { ModelInfo } from "../model.js"

// ChinalifePE API
export type ChinalifePEModelId = keyof typeof chinalifePEModels

export const chinalifePEDefaultModelId: ChinalifePEModelId = "kimi-k2-thinking"

export const chinalifePEModels = {
	"deepseek-v3.1": {
		maxTokens: 131_072, // 128K max output
		contextWindow: 131_072,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: true,
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		isFree: true,
		description: `ChinalifePE DeepSeek V3.1 model`,
	},
	"kimi-k2-thinking": {
		maxTokens: 262_144, // 256K max output
		contextWindow: 262_144,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: true,
		requiredReasoningEffort: true,
		reasoningEffort: "medium",
		isFree: true,
		description: `ChinalifePE Kimi K2 Thinking model`,
		supportsTemperature: true,
		preserveReasoning: true,
		defaultTemperature: 1.0
	},
} as const satisfies Record<string, ModelInfo>

export const CHINALIFEPE_DEFAULT_TEMPERATURE = 0.6
