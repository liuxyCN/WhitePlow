import type OpenAI from "openai"

const CODEBASE_SEARCH_DESCRIPTION = `Find files most relevant to the search query using semantic search. Searches based on meaning rather than exact text matches. Embeddings are optimized for Chinese; phrase queries in Chinese when the user or target content is Chinese—reuse the user's exact wording when helpful. Markdown documentation may live anywhere in the workspace (not a single docs root); search the whole workspace unless you have a reason to narrow.

**CRITICAL: For ANY exploration of code or documentation you haven't examined yet in this conversation, you MUST use this tool FIRST before any other search or file exploration tools.** This applies throughout the entire conversation, not just at the beginning. Prefer this over regex-based search_files for understanding implementations and for finding where topics are explained in .md files.

Parameters:
- query: (required) What to find (topic, feature, error fragment, section intent). Use Chinese for Chinese docs and code comments when appropriate.
- path: (optional) Limit search to a subdirectory relative to the workspace root. Use null to search the entire workspace—do this when documentation location is unknown or scattered.

Example: Chinese query, narrow to a package
{ "query": "用户认证与密码哈希", "path": "packages/auth" }

Example: Entire workspace (default when unsure where .md or code lives)
{ "query": "数据库连接池配置说明", "path": null }`

const QUERY_PARAMETER_DESCRIPTION = `Chinese-first semantic query describing what you need; match the language of the content you expect`

const PATH_PARAMETER_DESCRIPTION = `Optional subdirectory to limit scope; null searches entire workspace (use when docs may be in any folder)`

export default {
	type: "function",
	function: {
		name: "codebase_search",
		description: CODEBASE_SEARCH_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: QUERY_PARAMETER_DESCRIPTION,
				},
				path: {
					type: ["string", "null"],
					description: PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["query", "path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
