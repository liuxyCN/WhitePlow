import axios from "axios"
import OpenAI from "openai"

import {
	chinalifePEDefaultModelId,
	chinalifePEModels,
	CHINALIFEPE_DEFAULT_TEMPERATURE,
	type ChinalifePEModelId,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"
import { DEFAULT_HEADERS } from "./constants"
import { getApiRequestTimeout } from "./utils/timeout-config"

/** VS Code / Chromium DevTools truncates long single console.log lines with "…"; stay under that. */
const CHINALIFEPE_REQUEST_BODY_LOG_CHUNK = 4000

function logChinalifePERawHttpRequestBody(raw: string): void {
	const total = raw.length
	const chunkSize = CHINALIFEPE_REQUEST_BODY_LOG_CHUNK
	const parts = Math.ceil(total / chunkSize) || 1
	console.log(
		`[ChinalifePE] raw HTTP request body: ${total} chars, ${parts} log line(s) (concatenate payloads in order to reconstruct)`,
	)
	for (let i = 0; i < parts; i++) {
		const slice = raw.slice(i * chunkSize, (i + 1) * chunkSize)
		console.log(`[ChinalifePE] raw HTTP request body [${i + 1}/${parts}]\n${slice}`)
	}
}

/** Logs the exact HTTP request body the OpenAI SDK sends (not Task's requestBodyForDebug). */
function createChinalifePERequestBodyLoggingFetch(): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		let nextInit = init
		let raw: string | undefined

		if (init?.body != null) {
			const body = init.body
			if (typeof body === "string") {
				raw = body
			} else if (body instanceof Uint8Array) {
				raw = new TextDecoder().decode(body)
			} else if (typeof Buffer !== "undefined" && Buffer.isBuffer(body)) {
				raw = body.toString("utf8")
			} else if (body instanceof ArrayBuffer) {
				raw = new TextDecoder().decode(body)
			} else if (typeof Blob !== "undefined" && body instanceof Blob) {
				raw = await body.text()
			} else if (body instanceof ReadableStream) {
				const [forLog, forRequest] = body.tee()
				raw = await new Response(forLog).text()
				nextInit = { ...init, body: forRequest }
			}
		}

		if (raw !== undefined) {
			logChinalifePERawHttpRequestBody(raw)
		}

		return globalThis.fetch(input as RequestInfo, nextInit as RequestInit)
	}
}

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

		this.client = new OpenAI({
			baseURL: this.baseURL,
			apiKey: this.options.apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: getApiRequestTimeout(),
			fetch: createChinalifePERequestBodyLoggingFetch(),
		})
	}

	/**
	 * ChinalifePE gateway is OpenAI-compatible but does not use OpenAI strict tool schemas; use
	 * strict: false and preserve original parameter shapes (same approach as MCP tools in BaseProvider).
	 */
	protected override convertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
		if (!tools) {
			return undefined
		}
		return tools.map((tool) => {
			if (tool.type !== "function") {
				return tool
			}
			return {
				...tool,
				function: {
					...tool.function,
					strict: false,
					parameters: tool.function.parameters,
				},
			}
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
