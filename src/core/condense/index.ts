import Anthropic from "@anthropic-ai/sdk"

import { TelemetryService } from "@roo-code/telemetry"

import { t } from "../../i18n"
import { ApiHandler } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"

export const N_MESSAGES_TO_KEEP = 1
export const MIN_CONDENSE_THRESHOLD = 3 // Minimum percentage of context window to trigger condensing
export const MAX_CONDENSE_THRESHOLD = 100 // Maximum percentage of context window to trigger condensing

const SUMMARY_PROMPT = `\
你的任务是创建一份详细的对话摘要，请密切关注用户的明确请求和你之前的操作。
这份摘要应该全面捕获专业标准、业务知识、分析方法和领域知识，这些对于继续对话和支持任何持续任务至关重要。本工具面向投资机构，专注于报告撰写、财务分析、风险管理、合规内控、投资分析、商业模式分析、背景调查、税务分析等专业工作。

你的摘要应按以下结构组织：
上下文：用于继续对话的上下文。根据当前任务，如果适用，应包括：
  1. 之前的对话：概述整个对话过程中与用户讨论的主要内容。应能让阅读者理解整体对话流程。对于投资机构的专业领域（如财务分析、风险管理、合规内控、投资分析、商业模式分析、背景调查、税务分析、正式文档撰写），请保留关键的专业术语、标准和规范。
  2. 当前工作：详细描述在本次压缩请求之前正在进行的工作。请特别关注对话中较新的消息。包括正在遵循的任何特定格式、模板或标准（例如：文档结构、分析框架、合规要求、报告格式、投资分析模型、商业模式框架、尽调清单、税务筹划方案）。
  3. 关键概念和标准：列出所有重要的概念、专业标准、法规、分析框架或方法论，这些可能与继续工作相关。对于投资机构的专业场景，请保留：
     - 专业标准和法规（例如：会计准则、税务法规、合规要求、文档格式标准、监管规定、投资监管政策）
     - 分析框架和方法论（例如：财务分析模型、投资分析模型、商业模式分析框架、风险评估方法、合规检查流程、尽调方法论、税务筹划方法）
     - 投资机构特定的术语和约定
     - 业务概念和行业知识（例如：商业模式要素、市场分析、竞争分析、行业趋势）
  4. 相关文件、文档和数据：如果适用，请列举为任务延续而检查、修改或创建的特定文件、文档或数据源。请特别关注最新的消息和变更。对于每个项目，包括：
     - 重要性的总结
     - 所做更改的总结（如有）
     - 重要内容片段（文本、数据、表格或结构化信息）
     - 数据源和引用（特别是对于财务分析、投资分析、背景调查、税务分析或正式文档）
     - 关键数据和指标（例如：财务指标、投资回报指标、商业模式关键指标、税务数据）
  5. 问题解决和分析：记录迄今为止解决的问题、已执行的分析或已识别的问题。对于投资机构的专业领域，请保留：
     - 量化数据和计算（包括计算方法、公式和数据来源）
     - 投资分析结果（例如：投资价值评估、投资回报率、估值分析、投资风险分析）
     - 商业模式分析（例如：商业模式画布、盈利模式、价值链分析、竞争优势分析）
     - 背景调查发现（例如：企业信用状况、法律风险、经营风险、关联方关系、历史沿革）
     - 税务分析结果（例如：税务筹划方案、税务风险识别、税负分析、税务合规性检查）
     - 风险评估和分类（风险等级、影响范围、控制措施）
     - 合规差距和法规引用（具体法规条款、合规要求、整改措施）
     - 文档结构和格式要求（报告格式、公文规范、分析框架）
     - 投资决策相关的分析和建议
  6. 待处理任务和下一步：概述你被明确要求处理的所有待处理任务，以及你将采取的所有未完成工作的下一步（如适用）。在有助于清晰理解的地方包含数据点、关键指标或结构化内容。对于任何下一步，请包含来自最近对话的直接引用，准确显示你正在处理的任务以及你停止的位置。这应该是逐字逐句的，以确保任务之间上下文不丢失信息。保留任何必须遵循的特定要求、截止日期、标准或格式规范。特别重要：如果对话中包含待办任务列表（todo list，通过 updateTodoList 工具调用创建），你必须完整保留所有待办任务的内容，包括每个待办项的完整文本、状态（pending、in_progress、completed）和ID，不要压缩或简化待办任务列表的内容，必须原样保留所有待办项的详细信息。

摘要结构示例：
1. 之前的对话：
  [详细描述，保留专业术语和上下文]
2. 当前工作：
  [详细描述，包括正在使用的任何标准、格式或框架]
3. 关键概念和标准：
  - 专业标准： [标准1]，[法规1]，[框架1]，[...]
  - 分析方法： [方法1]，[方法2]，[...]
  - 业务概念： [概念1]，[概念2]，[...]
4. 相关文件、文档和数据：
  - [文件/文档名称1]
    - [重要性的总结]
    - [所做更改的总结（如有）]
    - [重要内容片段及上下文]
    - [数据源或引用（如适用）]
    - [关键数据和指标]
  - [文件/文档名称2]
    - [重要内容片段]
  - [...]
5. 问题解决和分析：
  [详细描述，包括任何定量分析、投资分析、商业模式分析、背景调查发现、税务分析、风险评估、合规检查、格式要求或投资决策分析]
6. 待处理任务和下一步：
  - [任务1详情和下一步，包括任何特定要求或标准]
  - [任务2详情和下一步，包括任何特定要求或标准]
  - [...]
  - 如果存在待办任务列表，必须完整列出所有待办项：
    - [ ] 待办项1的完整内容（状态：pending/in_progress/completed）
    - [ ] 待办项2的完整内容（状态：pending/in_progress/completed）
    - [...]

仅输出对话摘要，不要添加任何额外的评论或解释。确保所有专业术语、标准、数据点、关键指标和结构化信息都被准确保留。
`

export type SummarizeResponse = {
	messages: ApiMessage[] // The messages after summarization
	summary: string // The summary text; empty string for no summary
	cost: number // The cost of the summarization operation
	newContextTokens?: number // The number of tokens in the context for the next API request
	error?: string // Populated iff the operation fails: error message shown to the user on failure (see Task.ts)
}

/**
 * Summarizes the conversation messages using an LLM call
 *
 * @param {ApiMessage[]} messages - The conversation messages
 * @param {ApiHandler} apiHandler - The API handler to use for token counting.
 * @param {string} systemPrompt - The system prompt for API requests, which should be considered in the context token count
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @param {boolean} isAutomaticTrigger - Whether the summarization is triggered automatically
 * @returns {SummarizeResponse} - The result of the summarization operation (see above)
 */
/**
 * Summarizes the conversation messages using an LLM call
 *
 * @param {ApiMessage[]} messages - The conversation messages
 * @param {ApiHandler} apiHandler - The API handler to use for token counting (fallback if condensingApiHandler not provided)
 * @param {string} systemPrompt - The system prompt for API requests (fallback if customCondensingPrompt not provided)
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @param {number} prevContextTokens - The number of tokens currently in the context, used to ensure we don't grow the context
 * @param {boolean} isAutomaticTrigger - Whether the summarization is triggered automatically
 * @param {string} customCondensingPrompt - Optional custom prompt to use for condensing
 * @param {ApiHandler} condensingApiHandler - Optional specific API handler to use for condensing
 * @returns {SummarizeResponse} - The result of the summarization operation (see above)
 */
export async function summarizeConversation(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
	systemPrompt: string,
	taskId: string,
	prevContextTokens: number,
	isAutomaticTrigger?: boolean,
	customCondensingPrompt?: string,
	condensingApiHandler?: ApiHandler,
): Promise<SummarizeResponse> {
	TelemetryService.instance.captureContextCondensed(
		taskId,
		isAutomaticTrigger ?? false,
		!!customCondensingPrompt?.trim(),
		!!condensingApiHandler,
	)

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	// Always preserve the first message (which may contain slash command content)
	const firstMessage = messages[0]
	// Get messages to summarize, including the first message and excluding the last N messages
	const messagesToSummarize = getMessagesSinceLastSummary(messages.slice(0, -N_MESSAGES_TO_KEEP))

	if (messagesToSummarize.length <= 1) {
		const error =
			messages.length <= N_MESSAGES_TO_KEEP + 1
				? t("common:errors.condense_not_enough_messages")
				: t("common:errors.condensed_recently")
		return { ...response, error }
	}

	const keepMessages = messages.slice(-N_MESSAGES_TO_KEEP)
	// Check if there's a recent summary in the messages we're keeping
	const recentSummaryExists = keepMessages.some((message) => message.isSummary)

	if (recentSummaryExists) {
		const error = t("common:errors.condensed_recently")
		return { ...response, error }
	}

	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: "Summarize the conversation so far, as described in the prompt instructions.",
	}

	const requestMessages = maybeRemoveImageBlocks([...messagesToSummarize, finalRequestMessage], apiHandler).map(
		({ role, content }) => ({ role, content }),
	)

	// Note: this doesn't need to be a stream, consider using something like apiHandler.completePrompt
	// Use custom prompt if provided and non-empty, otherwise use the default SUMMARY_PROMPT
	const promptToUse = customCondensingPrompt?.trim() ? customCondensingPrompt.trim() : SUMMARY_PROMPT

	// Use condensing API handler if provided, otherwise use main API handler
	let handlerToUse = condensingApiHandler || apiHandler

	// Check if the chosen handler supports the required functionality
	if (!handlerToUse || typeof handlerToUse.createMessage !== "function") {
		console.warn(
			"Chosen API handler for condensing does not support message creation or is invalid, falling back to main apiHandler.",
		)

		handlerToUse = apiHandler // Fallback to the main, presumably valid, apiHandler

		// Ensure the main apiHandler itself is valid before this point or add another check.
		if (!handlerToUse || typeof handlerToUse.createMessage !== "function") {
			// This case should ideally not happen if main apiHandler is always valid.
			// Consider throwing an error or returning a specific error response.
			console.error("Main API handler is also invalid for condensing. Cannot proceed.")
			// Return an appropriate error structure for SummarizeResponse
			const error = t("common:errors.condense_handler_invalid")
			return { ...response, error }
		}
	}

	const stream = handlerToUse.createMessage(promptToUse, requestMessages)

	let summary = ""
	let cost = 0
	let outputTokens = 0

	for await (const chunk of stream) {
		if (chunk.type === "text") {
			summary += chunk.text
		} else if (chunk.type === "usage") {
			// Record final usage chunk only
			cost = chunk.totalCost ?? 0
			outputTokens = chunk.outputTokens ?? 0
		}
	}

	summary = summary.trim()

	if (summary.length === 0) {
		const error = t("common:errors.condense_failed")
		return { ...response, cost, error }
	}

	const summaryMessage: ApiMessage = {
		role: "assistant",
		content: summary,
		ts: keepMessages[0].ts,
		isSummary: true,
	}

	// Reconstruct messages: [first message, summary, last N messages]
	const newMessages = [firstMessage, summaryMessage, ...keepMessages]

	// Count the tokens in the context for the next API request
	// We only estimate the tokens in summaryMesage if outputTokens is 0, otherwise we use outputTokens
	const systemPromptMessage: ApiMessage = { role: "user", content: systemPrompt }

	const contextMessages = outputTokens
		? [systemPromptMessage, ...keepMessages]
		: [systemPromptMessage, summaryMessage, ...keepMessages]

	const contextBlocks = contextMessages.flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)

	const newContextTokens = outputTokens + (await apiHandler.countTokens(contextBlocks))
	if (newContextTokens >= prevContextTokens) {
		const error = t("common:errors.condense_context_grew")
		return { ...response, cost, error }
	}
	return { messages: newMessages, summary, cost, newContextTokens }
}

/* Returns the list of all messages since the last summary message, including the summary. Returns all messages if there is no summary. */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	let lastSummaryIndexReverse = [...messages].reverse().findIndex((message) => message.isSummary)

	if (lastSummaryIndexReverse === -1) {
		return messages
	}

	const lastSummaryIndex = messages.length - lastSummaryIndexReverse - 1
	const messagesSinceSummary = messages.slice(lastSummaryIndex)

	// Bedrock requires the first message to be a user message.
	// We preserve the original first message to maintain context.
	// See https://github.com/RooCodeInc/Roo-Code/issues/4147
	if (messagesSinceSummary.length > 0 && messagesSinceSummary[0].role !== "user") {
		// Get the original first message (should always be a user message with the task)
		const originalFirstMessage = messages[0]
		if (originalFirstMessage && originalFirstMessage.role === "user") {
			// Use the original first message unchanged to maintain full context
			return [originalFirstMessage, ...messagesSinceSummary]
		} else {
			// Fallback to generic message if no original first message exists (shouldn't happen)
			const userMessage: ApiMessage = {
				role: "user",
				content: "Please continue from the following summary:",
				ts: messages[0]?.ts ? messages[0].ts - 1 : Date.now(),
			}
			return [userMessage, ...messagesSinceSummary]
		}
	}

	return messagesSinceSummary
}
