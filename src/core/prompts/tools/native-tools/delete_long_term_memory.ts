import type OpenAI from "openai"

const DESC = `Delete a single structured long-term memory entry by its exact key. Use when the user asks to forget or remove a stored preference/fact. Keys match the stored format (e.g. user.replyLanguage). Only call after you know the key—if unsure, ask the user or infer from context.`

export default {
	type: "function",
	function: {
		name: "delete_long_term_memory",
		description: DESC,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				memory_key: {
					type: "string",
					description:
						"Exact key of the memory entry to remove (alphanumeric, dots, underscores only; must exist in stored memories).",
				},
			},
			required: ["memory_key"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
