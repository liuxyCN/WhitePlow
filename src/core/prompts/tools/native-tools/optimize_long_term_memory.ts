import type OpenAI from "openai"

const DESC = `Rewrite and deduplicate all structured long-term memories using the configured model: merges semantically duplicate keys, tightens wording, and keeps stable user preferences. May take a few seconds. Use when the user asks to clean up, dedupe, or optimize saved memories.`

export default {
	type: "function",
	function: {
		name: "optimize_long_term_memory",
		description: DESC,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				focus: {
					type: "string",
					description:
						"Optional hint for merge priorities (e.g. coding style). Use an empty string if the user gave no extra guidance.",
				},
			},
			required: ["focus"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
