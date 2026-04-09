/** Instructions for the lightweight pre-call that selects which structured keys to inject. */
export const LONG_TERM_MEMORY_SELECTION_INSTRUCTIONS = `你是「长期记忆筛选」模块。根据用户本轮输入，判断需要从长期记忆中注入哪些条目到主对话中。

规则：
- 下面 JSON 对象表示已存储的记忆（键为 id，值为内容）。
- 只选择与当前用户输入**直接相关**、能帮助助手更准确回答的键。
- 宁少勿多；若都不相关则 keys 为空数组。
- 只输出一个合法 JSON 对象，不要用 markdown 代码块，不要其它说明文字。
- 格式：{"keys":["键id1","键id2",...]}，键必须来自下面 JSON 中已存在的键。

`

export function buildMemorySelectionUserContent(userPrompt: string, memoriesJson: string): string {
	return `${LONG_TERM_MEMORY_SELECTION_INSTRUCTIONS}

---BEGIN_USER_MESSAGE---
${userPrompt}
---END_USER_MESSAGE---

---BEGIN_MEMORIES_JSON---
${memoriesJson}
---END_MEMORIES_JSON---

请只输出 JSON。`
}
