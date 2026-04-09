/** Chinese user-facing extraction instructions (completePrompt is user-only). No preset domain: infer only from the transcript. */
export const LONG_TERM_MEMORY_EXTRACTION_INSTRUCTIONS = `你是助手扩展中的「长期记忆抽取」模块。不预设对话所属领域，仅根据下文对话判断是否有值得长期保留的信息。

下面「---BEGIN_TRANSCRIPT---」之后是一段已裁剪的历史对话。你的任务：只抽取在**未来、跨任务**仍然有用、且用户未明确要求保密的信息。

只输出**结构化**条目：可用单个键值表达的稳定偏好、习惯、事实或约定。
- key：小写英文点分路径，简短且能区分含义即可（如 user.replyLanguage）。
- value：只能是 JSON 字符串、数字或布尔。

禁止输出密钥、密码、token、完整证件号等敏感内容。不要流水账复述对话。

只输出一个合法 JSON 对象，不要用 markdown 代码块，不要其它说明文字。
格式：{"items":[...]}，每项为 {"key":"...","value":...}（仅 key 与 value 两个字段）。
最多 15 条；没有可存内容则 {"items":[]}。

`

export function buildExtractionUserContent(taskId: string, transcript: string): string {
	return `${LONG_TERM_MEMORY_EXTRACTION_INSTRUCTIONS}

任务ID：${taskId}

---BEGIN_TRANSCRIPT---
${transcript}
---END_TRANSCRIPT---

请按上述要求只输出 JSON。`
}
