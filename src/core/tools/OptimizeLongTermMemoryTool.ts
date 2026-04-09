import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface OptimizeLongTermMemoryParams {
	focus: string
}

export class OptimizeLongTermMemoryTool extends BaseTool<"optimize_long_term_memory"> {
	readonly name = "optimize_long_term_memory" as const

	async execute(params: OptimizeLongTermMemoryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks

		try {
			const focusRaw = params.focus ?? ""
			const focusHint = focusRaw.trim()

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("无法访问扩展宿主。"))
				return
			}

			const mgr = provider.getLongTermMemoryManager()
			if (!mgr.isFeatureEnabled()) {
				task.recordToolError("optimize_long_term_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("长期记忆已关闭，无法优化。"))
				return
			}

			task.consecutiveMistakeCount = 0

			const approvalMsg = JSON.stringify({
				tool: "optimizeLongTermMemory",
				focus: focusHint || undefined,
			})
			const didApprove = await askApproval("tool", approvalMsg)
			if (!didApprove) {
				pushToolResult("User declined to optimize long-term memory.")
				return
			}

			const result = await mgr.optimizeStructuredMemory(focusHint || undefined)
			if (!result.ok) {
				task.recordToolError("optimize_long_term_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(result.error))
				return
			}

			pushToolResult(
				formatResponse.toolResult(
					`长期记忆已优化：条目数 ${result.beforeCount} → ${result.afterCount}。`,
				),
			)
		} catch (error) {
			await handleError("optimize long-term memory", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"optimize_long_term_memory">): Promise<void> {
		const focus = block.nativeArgs?.focus ?? block.params.focus ?? ""
		await task
			.ask("tool", JSON.stringify({ tool: "optimizeLongTermMemory", focus: focus.trim() || undefined }), block.partial)
			.catch(() => {})
	}
}

export const optimizeLongTermMemoryTool = new OptimizeLongTermMemoryTool()
