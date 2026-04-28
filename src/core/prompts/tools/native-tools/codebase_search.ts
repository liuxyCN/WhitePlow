import type OpenAI from "openai"

const CODEBASE_SEARCH_DESCRIPTION = `基于工作区**已建索引**的**文档库语义检索**：在向量索引中按语义相似度查找最相关的文本片段，侧重**含义**而非字面匹配。索引内容可包含分析报告、项目资料、政策法规、制度、Markdown/文档、配置说明、产品说明、规范、笔记、翻译稿、源码等**各类工作区文本**，**不局限于编程**；中文友好——当用户或目标内容为中文时，查询宜使用中文，并可复用用户原话。

**重要：**在本对话中，凡要检索文档、代码或其它工作区文本，应**优先于** \`search_files\` / \`list_files\` / \`read_file\` 等工具**先**使用本工具；适用于整段对话，不限于首轮。

参数：
- **query**（必填）：要找什么（主题、功能、报错片段、章节意图、业务名词、政策法规、制度等）。面向中文材料时优先用中文表述。
- **path**（可选）：缩小检索范围。填 **null** 表示在所有工作区根下检索——当文档散落、位置不明或跨多目录时务必如此。
  - **相对路径：**在每个工作区根下**各自**按同一相对前缀过滤。仅某一根下有该子树、或有意在多根下匹配相同目录结构时适用。
  - **多根注意：**相对路径无法表达「只要第二个根」。若必须限定在**某一根**内的目录（尤其当其它根也存在相同相对路径前缀时），请对 \`path\` 使用**绝对目录路径**，以便只在该根的索引范围内检索。
  - **绝对路径：**仅检索包含该路径的那一个工作区根，其余根本次跳过。

示例：中文查询、收窄到子目录
{ "query": "项目股权架构说明", "path": "docs/overview" }

示例：全工作区（不确定文档或材料在哪时默认）
{ "query": "项目股权架构说明", "path": null }

示例：多工作区根——用绝对路径只搜第二个仓库下的目录
{ "query": "项目股权架构说明", "path": "/abs/path/to/second-repo/docs" }`

const QUERY_PARAMETER_DESCRIPTION = `语义检索用语：描述你要找的主题或信息；语言尽量与预期材料一致（中文材料优先中文）`

const PATH_PARAMETER_DESCRIPTION = `可选范围：null = 所有工作区根；相对路径 = 每个根下按相同路径段过滤；多根且要钉死某一根时优先用绝对目录路径`

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
