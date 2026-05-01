import type OpenAI from "openai"

const NEW_TASK_DESCRIPTION = `在指定模式下创建一个新的子任务，并将 message 作为子任务的初始指令（如有需要可附带 todos）。

调用规则（必须严格遵守）：
1. 本工具必须“单独调用”。同一条 assistant 消息中，不能与任何其他工具一起调用。
2. 如果在委派前需要先收集信息，请先在前一轮完成信息收集；下一轮再只调用 new_task。
3. 当用户明确要求“使用 new_task / 新建子任务 / 委派给子任务”，或明确要求“通过 new_task 让子任务去调用某工具（如 web_search）”时，应优先调用本工具，而不是直接调用目标工具。`

const MODE_PARAMETER_DESCRIPTION = `子任务启动模式的标识（slug），例如：code、debug、architect`

const MESSAGE_PARAMETER_DESCRIPTION = `传递给子任务的初始指令或上下文。若用户要求“用 new_task 调用某工具”，请在此参数中明确写出子任务需要调用的工具与目标。`

const TODOS_PARAMETER_DESCRIPTION = `可选：使用 Markdown checklist 格式提供子任务初始待办；当工作区要求 todos 时该参数为必填`

export default {
	type: "function",
	function: {
		name: "new_task",
		description: NEW_TASK_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					description: MODE_PARAMETER_DESCRIPTION,
				},
				message: {
					type: "string",
					description: MESSAGE_PARAMETER_DESCRIPTION,
				},
				todos: {
					type: ["string", "null"],
					description: TODOS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["mode", "message", "todos"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
