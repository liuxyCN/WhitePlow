import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface DeleteLongTermMemoryParams {
	memory_key: string
}

export class DeleteLongTermMemoryTool extends BaseTool<"delete_long_term_memory"> {
	readonly name = "delete_long_term_memory" as const

	async execute(params: DeleteLongTermMemoryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks

		try {
			const key = params.memory_key?.trim() ?? ""
			if (!key) {
				task.consecutiveMistakeCount++
				task.recordToolError("delete_long_term_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("delete_long_term_memory", "memory_key"))
				return
			}

			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("无法访问扩展宿主。"))
				return
			}

			const mgr = provider.getLongTermMemoryManager()
			if (!mgr.isFeatureEnabled()) {
				task.recordToolError("delete_long_term_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("长期记忆已关闭，无法删除。"))
				return
			}

			task.consecutiveMistakeCount = 0

			const approvalMsg = JSON.stringify({ tool: "deleteLongTermMemory", memoryKey: key })
			const didApprove = await askApproval("tool", approvalMsg)
			if (!didApprove) {
				pushToolResult("User declined to delete long-term memory.")
				return
			}

			const result = await mgr.deleteStructuredKey(key)
			if (!result.ok) {
				task.recordToolError("delete_long_term_memory")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(result.error))
				return
			}

			pushToolResult(formatResponse.toolResult(`已删除长期记忆键：\`${key}\``))
		} catch (error) {
			await handleError("delete long-term memory", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"delete_long_term_memory">): Promise<void> {
		const key = block.nativeArgs?.memory_key ?? block.params.memory_key ?? ""
		await task
			.ask("tool", JSON.stringify({ tool: "deleteLongTermMemory", memoryKey: key }), block.partial)
			.catch(() => {})
	}
}

export const deleteLongTermMemoryTool = new DeleteLongTermMemoryTool()
