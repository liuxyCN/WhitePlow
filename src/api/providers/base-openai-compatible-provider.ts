import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { ModelInfo } from "@roo-code/types"

import { type ApiHandlerOptions, getModelMaxOutputTokens } from "../../shared/api"
import { XmlMatcher } from "../../utils/xml-matcher"
import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { convertToOpenAiMessages } from "../transform/openai-format"

import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { DEFAULT_HEADERS } from "./constants"
import { BaseProvider } from "./base-provider"
import { handleOpenAIError } from "./utils/openai-error-handler"
import { calculateApiCostOpenAI } from "../../shared/cost"
import { getApiRequestTimeout } from "./utils/timeout-config"

type BaseOpenAiCompatibleProviderOptions<ModelName extends string> = ApiHandlerOptions & {
	providerName: string
	baseURL: string
	defaultProviderModelId: ModelName
	providerModels: Record<ModelName, ModelInfo>
	defaultTemperature?: number
}

export abstract class BaseOpenAiCompatibleProvider<ModelName extends string>
	extends BaseProvider
	implements SingleCompletionHandler
{
	protected readonly providerName: string
	protected readonly baseURL: string
	protected readonly defaultTemperature: number
	protected readonly defaultProviderModelId: ModelName
	protected readonly providerModels: Record<ModelName, ModelInfo>

	protected readonly options: ApiHandlerOptions

	protected client: OpenAI

	constructor({
		providerName,
		baseURL,
		defaultProviderModelId,
		providerModels,
		defaultTemperature,
		...options
	}: BaseOpenAiCompatibleProviderOptions<ModelName>) {
		super()

		this.providerName = providerName
		this.baseURL = baseURL
		this.defaultProviderModelId = defaultProviderModelId
		this.providerModels = providerModels
		this.defaultTemperature = defaultTemperature ?? 0

		this.options = options

		if (!this.options.apiKey) {
			throw new Error("API key is required")
		}

		this.client = new OpenAI({
			baseURL,
			apiKey: this.options.apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			timeout: getApiRequestTimeout(),
		})
	}

	protected createStream(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: OpenAI.RequestOptions,
	) {
		const { id: model, info } = this.getModel()

		// Centralized cap: clamp to 20% of the context window (unless provider-specific exceptions apply)
		const max_tokens =
			getModelMaxOutputTokens({
				modelId: model,
				model: info,
				settings: this.options,
				format: "openai",
			}) ?? undefined

		const temperature = this.options.modelTemperature ?? this.defaultTemperature

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model,
			max_tokens,
			temperature,
			messages: [{ role: "system", content: systemPrompt }, ...convertToOpenAiMessages(messages)],
			stream: true,
			stream_options: { include_usage: true },
			...(metadata?.tools && { tools: this.convertToolsForOpenAI(metadata.tools) }),
			...(metadata?.tool_choice && { tool_choice: metadata.tool_choice }),
			...(metadata?.toolProtocol === "native" && {
				parallel_tool_calls: metadata.parallelToolCalls ?? false,
			}),
		}

		// Add thinking parameter if reasoning is enabled and model supports it
		if (this.options.enableReasoningEffort && info.supportsReasoningBinary) {
			;(params as any).thinking = { type: "enabled" }
		}

		try {
			return this.client.chat.completions.create(params, requestOptions)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const stream = await this.createStream(systemPrompt, messages, metadata)

		const matcher = new XmlMatcher(
			"think",
			(chunk) =>
				({
					type: chunk.matched ? "reasoning" : "text",
					text: chunk.data,
				}) as const,
		)

		let lastUsage: OpenAI.CompletionUsage | undefined
		let reasoningBuffer = "" // Buffer for accumulating reasoning content

		for await (const chunk of stream) {
			// Check for provider-specific error responses (e.g., MiniMax base_resp)
			const chunkAny = chunk as any
			if (chunkAny.base_resp?.status_code && chunkAny.base_resp.status_code !== 0) {
				throw new Error(
					`${this.providerName} API Error (${chunkAny.base_resp.status_code}): ${chunkAny.base_resp.status_msg || "Unknown error"}`,
				)
			}

			const delta = chunk.choices?.[0]?.delta

			if (delta?.content) {
				for (const processedChunk of matcher.update(delta.content)) {
					yield processedChunk
				}
			}

			if (delta) {
				for (const key of ["reasoning_content", "reasoning"] as const) {
					if (key in delta) {
						const reasoning_content = ((delta as any)[key] as string | undefined) || ""
						if (reasoning_content) {
							// Accumulate for later tool extraction
							reasoningBuffer += reasoning_content
							// Also yield immediately for real-time display
							if (reasoning_content.trim()) {
								yield { type: "reasoning", text: reasoning_content }
							}
						}
						break
					}
				}
			}

			// Emit raw tool call chunks - NativeToolCallParser handles state management
			if (delta?.tool_calls) {
				for (const toolCall of delta.tool_calls) {
					yield {
						type: "tool_call_partial",
						index: toolCall.index,
						id: toolCall.id,
						name: toolCall.function?.name,
						arguments: toolCall.function?.arguments,
					}
				}
			}

			if (chunk.usage) {
				lastUsage = chunk.usage
			}
		}

		// Process accumulated reasoning content after stream completes
		// Extract and yield only tool calls (text chunks) for execution
		// Reasoning was already displayed during streaming
		if (reasoningBuffer.trim()) {
			const chunks = this.separateToolCallsFromReasoning(reasoningBuffer)
			// Only yield text chunks (tool calls) for execution
			// Reasoning was already streamed in real-time above
			for (const processedChunk of chunks) {
				if (processedChunk.type === "text") {
					yield processedChunk
				}
			}
		}

		if (lastUsage) {
			yield this.processUsageMetrics(lastUsage, this.getModel().info)
		}

		// Process any remaining content
		for (const processedChunk of matcher.final()) {
			yield processedChunk
		}
	}

	/**
	 * Separates tool call XML tags from reasoning content.
	 * Tool calls should be returned as text, while other content remains as reasoning.
	 * 
	 * Uses a generic approach to match XML-style tool calls while excluding known reasoning tags.
	 */
	private separateToolCallsFromReasoning(
		content: string,
	): Array<{ type: "reasoning" | "text"; text: string }> {
		// Tags that should remain as reasoning content (not treated as tool calls)
		const reasoningTags = ["think", "thinking", "thoughts", "analysis"]
		const reasoningPattern = reasoningTags.join("|")

		// Generic pattern to match XML-style tags (any tag that looks like a tool call)
		// Matches: <tag_name>...</tag_name> or <tag_name attr="value">...</tag_name>
		// Excludes: known reasoning tags
		const regex = new RegExp(
			`<([a-z_][a-z0-9_]*)(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`,
			"gi",
		)

		const result: Array<{ type: "reasoning" | "text"; text: string }> = []
		let lastIndex = 0

		// Find all potential tool call matches
		let match: RegExpExecArray | null
		while ((match = regex.exec(content)) !== null) {
			const tagName = match[1].toLowerCase()
			const matchStart = match.index
			const matchEnd = regex.lastIndex

			// Skip if this is a known reasoning tag
			if (reasoningTags.includes(tagName)) {
				continue
			}

			// Add any reasoning content before this tool call
			if (matchStart > lastIndex) {
				const reasoningText = content.slice(lastIndex, matchStart)
				if (reasoningText.trim()) {
					result.push({ type: "reasoning", text: reasoningText })
				}
			}

			// Add the tool call as text
			const toolCallText = match[0]
			result.push({ type: "text", text: toolCallText })

			lastIndex = matchEnd
		}

		// Add any remaining reasoning content after the last tool call
		if (lastIndex < content.length) {
			const remainingText = content.slice(lastIndex)
			if (remainingText.trim()) {
				result.push({ type: "reasoning", text: remainingText })
			}
		}

		// If no tool calls were found, return the entire content as reasoning
		if (result.length === 0 && content.trim()) {
			result.push({ type: "reasoning", text: content })
		}

		return result
	}

	protected processUsageMetrics(usage: any, modelInfo?: any): ApiStreamUsageChunk {
		const inputTokens = usage?.prompt_tokens || 0
		const outputTokens = usage?.completion_tokens || 0
		const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens || 0
		const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens || 0

		const { totalCost } = modelInfo
			? calculateApiCostOpenAI(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
			: { totalCost: 0 }

		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheWriteTokens: cacheWriteTokens || undefined,
			cacheReadTokens: cacheReadTokens || undefined,
			totalCost,
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		const { id: modelId, info: modelInfo } = this.getModel()

		const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
			model: modelId,
			messages: [{ role: "user", content: prompt }],
		}

		// Add thinking parameter if reasoning is enabled and model supports it
		if (this.options.enableReasoningEffort && modelInfo.supportsReasoningBinary) {
			;(params as any).thinking = { type: "enabled" }
		}

		try {
			const response = await this.client.chat.completions.create(params)

			// Check for provider-specific error responses (e.g., MiniMax base_resp)
			const responseAny = response as any
			if (responseAny.base_resp?.status_code && responseAny.base_resp.status_code !== 0) {
				throw new Error(
					`${this.providerName} API Error (${responseAny.base_resp.status_code}): ${responseAny.base_resp.status_msg || "Unknown error"}`,
				)
			}

			return response.choices?.[0]?.message.content || ""
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}
	}

	override getModel() {
		const id =
			this.options.apiModelId && this.options.apiModelId in this.providerModels
				? (this.options.apiModelId as ModelName)
				: this.defaultProviderModelId

		return { id, info: this.providerModels[id] }
	}
}
