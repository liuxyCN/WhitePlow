import axios from "axios"

import { 
	chinalifePEDefaultModelId, 
	chinalifePEModels, 
	CHINALIFEPE_DEFAULT_TEMPERATURE,
	type ChinalifePEModelId,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { DEFAULT_HEADERS } from "./constants"

export class ChinalifePEHandler extends BaseOpenAiCompatibleProvider<ChinalifePEModelId> {
	constructor(options: ApiHandlerOptions) {
		const baseURL = options.openAiBaseUrl 
			? `${options.openAiBaseUrl.replace(/\/$/, "")}/v1`
			: "https://ai.chinalifepe.com/v1"

		// Map openAiModelId to apiModelId for BaseOpenAiCompatibleProvider
		const mappedOptions = {
			...options,
			apiModelId: options.openAiModelId ?? options.apiModelId,
		}

		super({
			...mappedOptions,
			providerName: "ChinalifePE",
			baseURL,
			apiKey: options.openAiApiKey ?? "not-provided",
			defaultProviderModelId: chinalifePEDefaultModelId,
			providerModels: chinalifePEModels,
			defaultTemperature: CHINALIFEPE_DEFAULT_TEMPERATURE,
		})
	}
}

/**
 * Get ChinalifePE models from the API endpoint
 * @param baseUrl - Base URL for the ChinalifePE API
 * @param apiKey - API key for authentication
 * @returns Array of model IDs
 */
export async function getChinalifePEModels(baseUrl?: string, apiKey?: string): Promise<string[]> {
	try {
		if (!baseUrl) {
			return []
		}

		// Trim whitespace from baseUrl to handle cases where users accidentally include spaces
		const trimmedBaseUrl = baseUrl.trim()

		if (!URL.canParse(trimmedBaseUrl)) {
			return []
		}

		// Ensure baseUrl ends with /v1
		const normalizedBaseUrl = trimmedBaseUrl.endsWith("/v1")
			? trimmedBaseUrl
			: `${trimmedBaseUrl.replace(/\/$/, "")}/v1`

		const config: Record<string, any> = {}
		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
		}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		if (Object.keys(headers).length > 0) {
			config["headers"] = headers
		}

		const response = await axios.get(`${normalizedBaseUrl}/models`, config)
		const modelsArray = response.data?.data?.map((model: any) => model.id) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
