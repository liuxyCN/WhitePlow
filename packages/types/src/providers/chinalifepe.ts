import type { ModelInfo } from "../model.js"

// ChinalifePE API
export type ChinalifePEModelId = keyof typeof chinalifePEModels

export const chinalifePEDefaultModelId: ChinalifePEModelId = "deepseek-v3.1"

export const chinalifePEModels = {
	"deepseek-v3.1": {
		maxTokens: 128_000, // 128K max output
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		supportsReasoningEffort: true,
		reasoningEffort: 'medium',
		isFree: true,
		description: `ChinalifePE DeepSeek V3.1 model`,
	}
} as const satisfies Record<string, ModelInfo>

export const CHINALIFEPE_DEFAULT_TEMPERATURE = 0.6

