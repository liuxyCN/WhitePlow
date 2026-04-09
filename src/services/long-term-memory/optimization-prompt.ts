/** Optimize/dedupe structured long-term memory via LLM. User content is Chinese-facing. */
export const LONG_TERM_MEMORY_OPTIMIZATION_INSTRUCTIONS = `你是助手扩展中的「长期记忆优化」模块。下面 JSON 为当前已存储的结构化记忆（键 → 值，值仅能为字符串、数字或布尔）。

任务：
1. 合并**语义重复**的键或条目（保留信息更完整、表述更清晰的一方，或合并为一条）。
2. 统一 key 命名风格：小写英文点分路径（如 user.replyLanguage），与现有风格一致。
3. 精简冗余表述，但**不要删除**用户未来仍可能用到的稳定偏好或事实。
4. 禁止输出密钥、密码、token、完整证件号等敏感内容；若某条疑似敏感请丢弃该项。

只输出一个合法 JSON 对象，不要用 markdown 代码块，不要其它说明文字。
格式：{"items":[...]}，每项为 {"key":"...","value":...}（仅 key 与 value 两个字段）。
条目数量不限，但若输入为空或无可优化内容则 {"items":[]}。

`

export function buildOptimizationUserContent(memoriesJson: string, focus?: string): string {
	const hint =
		focus && focus.trim().length > 0
			? `\n用户额外说明（可选）：${focus.trim()}\n`
			: ""
	return `${LONG_TERM_MEMORY_OPTIMIZATION_INSTRUCTIONS}
${hint}
---BEGIN_MEMORIES_JSON---
${memoriesJson}
---END_MEMORIES_JSON---

请按上述要求只输出 JSON。`
}
