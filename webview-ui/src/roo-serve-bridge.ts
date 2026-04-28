import type { ExtensionMessage } from "@roo-code/types"

import { applyServeModeVscodeCssVariableDefaults } from "./serve-vscode-default-vars"

declare global {
	interface Window {
		__ROO_SERVE_AGENT_ID__?: string
	}
}

function getServeAgentId(): string | undefined {
	if (typeof window === "undefined") {
		return undefined
	}

	return window.__ROO_SERVE_AGENT_ID__ ?? new URLSearchParams(window.location.search).get("agentId") ?? undefined
}

if (import.meta.env.VITE_ROO_SERVE === "1") {
	applyServeModeVscodeCssVariableDefaults()

	const agentId = getServeAgentId()

	if (!agentId) {
		console.error(
			"[Roo serve UI] Missing agentId. Create an agent (POST /v1/agents) then open /app/?agentId=<uuid>",
		)
	} else {
		const es = new EventSource(`/v1/agents/${agentId}/stream`)

		es.addEventListener("message", (ev: MessageEvent<string>) => {
			try {
				const parsed = JSON.parse(ev.data) as { rooServeBridge?: boolean; message?: ExtensionMessage }
				if (parsed.rooServeBridge && parsed.message) {
					window.dispatchEvent(new MessageEvent("message", { data: parsed.message }))
				}
			} catch {
				// ignore non-JSON or non-bridge lines (e.g. stream-json control events)
			}
		})

		es.onerror = () => {
			// EventSource will retry automatically.
		}
	}
}
