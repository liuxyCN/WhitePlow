import { useState, useCallback, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { Layers } from "lucide-react"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui"
import MarkdownBlock from "../common/MarkdownBlock"
import { cn } from "@/lib/utils"

export type ContextInjectionNoticePayload = {
	longTermMemoryKeys?: number
	codebaseSnippets?: number
	/** Raw `<long_term_memory>` block prepended to the request */
	longTermMemoryText?: string
	/** Raw codebase auto-inject block prepended to the request */
	codebaseText?: string
}

function parsePayload(text: string | undefined): ContextInjectionNoticePayload {
	if (!text) {
		return {}
	}
	try {
		return JSON.parse(text) as ContextInjectionNoticePayload
	} catch {
		return {}
	}
}

/** Remove outer `<long_term_memory>` / `<codebase_context>` wrappers for cleaner dialog display. */
function stripInjectionXmlWrapper(text: string, tag: "long_term_memory" | "codebase_context"): string {
	const trimmed = text.trim()
	const openRe = new RegExp(`^<${tag}>\\s*`, "i")
	const closeRe = new RegExp(`\\s*</${tag}>\\s*$`, "i")
	return trimmed.replace(openRe, "").replace(closeRe, "").trim()
}

type ContextInjectionNoticeProps = {
	messageText: string | undefined
}

/**
 * Chat row line for context injection (long-term memory + codebase index). When the
 * extension stored `longTermMemoryText` / `codebaseText`, the row is clickable to view
 * the same content in a dialog (Markdown rendering reuses MarkdownBlock).
 */
export function ContextInjectionNotice({ messageText }: ContextInjectionNoticeProps) {
	const { t } = useTranslation()
	const data = parsePayload(messageText)
	const mem = data.longTermMemoryKeys ?? 0
	const code = data.codebaseSnippets ?? 0
	const memText = data.longTermMemoryText?.trim()
	const codeText = data.codebaseText?.trim()
	const memDisplay = memText ? stripInjectionXmlWrapper(memText, "long_term_memory") : ""
	const codeDisplay = codeText ? stripInjectionXmlWrapper(codeText, "codebase_context") : ""
	const hasDetail = Boolean(memText || codeText)

	const parts: string[] = []
	if (mem > 0) {
		parts.push(t("chat:contextInjection.memoryLine", { count: mem }))
	}
	if (code > 0) {
		parts.push(t("chat:contextInjection.codebaseLine", { count: code }))
	}
	if (parts.length === 0) {
		return null
	}

	const [open, setOpen] = useState(false)
	const onOpen = useCallback(() => {
		if (hasDetail) {
			setOpen(true)
		}
	}, [hasDetail])

	const onKeyDown = useCallback(
		(e: KeyboardEvent<HTMLDivElement>) => {
			if (!hasDetail) {
				return
			}
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault()
				setOpen(true)
			}
		},
		[hasDetail],
	)

	return (
		<>
			<div
				role={hasDetail ? "button" : undefined}
				tabIndex={hasDetail ? 0 : undefined}
				className={cn(
					"flex items-start gap-2 text-xs text-vscode-descriptionForeground pl-1 py-1.5 my-0.5 border-l-2 border-vscode-focusBorder/50 ml-1 rounded-sm bg-vscode-editor-background/30",
					hasDetail &&
						"cursor-pointer hover:bg-vscode-list-hoverBackground/40 focus:outline-none focus:ring-1 focus:ring-vscode-focusBorder rounded-sm",
				)}
				onClick={onOpen}
				onKeyDown={onKeyDown}
				title={hasDetail ? t("chat:contextInjection.clickToView") : undefined}
				aria-label={hasDetail ? t("chat:contextInjection.clickToView") : undefined}>
				<Layers className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-80" aria-hidden />
				<div>
					<span className="font-medium text-vscode-foreground">{t("chat:contextInjection.title")}</span>
					<span className="mx-1.5">·</span>
					<span>{parts.join(" · ")}</span>
				</div>
			</div>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 sm:max-w-2xl">
					<DialogHeader className="px-6 pt-6 pb-2 shrink-0">
						<DialogTitle>{t("chat:contextInjection.detailTitle")}</DialogTitle>
					</DialogHeader>
					<div className="px-6 pb-6 overflow-y-auto flex flex-col gap-4 min-h-0 text-sm">
						{memText ? (
							<section>
								<h3 className="text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground mb-2">
									{t("chat:contextInjection.memoryHeading")}
								</h3>
								<div className="rounded border border-vscode-widget-border bg-vscode-editor-background p-3">
									<MarkdownBlock markdown={memDisplay} />
								</div>
							</section>
						) : null}
						{codeText ? (
							<section>
								<h3 className="text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground mb-2">
									{t("chat:contextInjection.codebaseHeading")}
								</h3>
								<div className="rounded border border-vscode-widget-border bg-vscode-editor-background p-3">
									<MarkdownBlock markdown={codeDisplay} />
								</div>
							</section>
						) : null}
					</div>
				</DialogContent>
			</Dialog>
		</>
	)
}
