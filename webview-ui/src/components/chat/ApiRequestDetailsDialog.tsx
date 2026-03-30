import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { Copy, Check } from "lucide-react"

interface ApiRequestDetailsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	requestBody?: string
	responseBody?: string
	/** When set, shows a primary button to proceed (e.g. after reviewing the payload before send). */
	onProceed?: () => void
	proceedLabel?: string
	/** Shown under the title when `onProceed` is used (pre-send preview). */
	previewHint?: string
}

export const ApiRequestDetailsDialog: React.FC<ApiRequestDetailsDialogProps> = ({
	open,
	onOpenChange,
	requestBody,
	responseBody,
	onProceed,
	proceedLabel,
	previewHint,
}) => {
	const { t } = useTranslation()
	const [copiedRequest, setCopiedRequest] = useState(false)
	const [copiedResponse, setCopiedResponse] = useState(false)

	const handleCopyRequest = () => {
		if (requestBody) {
			navigator.clipboard.writeText(requestBody)
			setCopiedRequest(true)
			setTimeout(() => setCopiedRequest(false), 2000)
		}
	}

	const handleCopyResponse = () => {
		if (responseBody) {
			navigator.clipboard.writeText(responseBody)
			setCopiedResponse(true)
			setTimeout(() => setCopiedResponse(false), 2000)
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>{t("chat:apiRequest.details.title")}</DialogTitle>
				</DialogHeader>
				{previewHint && onProceed && (
					<p className="text-xs text-vscode-descriptionForeground -mt-1 mb-1">{previewHint}</p>
				)}
				<div className="flex-1 overflow-y-auto space-y-4">
					{requestBody && (
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<h3 className="font-semibold text-sm">{t("chat:apiRequest.details.request")}</h3>
								<VSCodeButton appearance="icon" onClick={handleCopyRequest} title={t("common:copy")}>
									{copiedRequest ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
								</VSCodeButton>
							</div>
							<pre
								className="p-3 bg-vscode-editor-background border border-vscode-editorGroup-border rounded text-xs overflow-x-auto"
								style={{
									maxHeight: "300px",
									overflowY: "auto",
								}}>
								<code>{requestBody}</code>
							</pre>
						</div>
					)}
					{responseBody && (
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<h3 className="font-semibold text-sm">{t("chat:apiRequest.details.response")}</h3>
								<VSCodeButton appearance="icon" onClick={handleCopyResponse} title={t("common:copy")}>
									{copiedResponse ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
								</VSCodeButton>
							</div>
							<pre
								className="p-3 bg-vscode-editor-background border border-vscode-editorGroup-border rounded text-xs overflow-x-auto"
								style={{
									maxHeight: "300px",
									overflowY: "auto",
								}}>
								<code>{responseBody}</code>
							</pre>
						</div>
					)}
					{!requestBody && !responseBody && (
						<div className="text-center py-8 text-vscode-descriptionForeground">
							{t("chat:apiRequest.details.noData")}
						</div>
					)}
				</div>
				{onProceed && proceedLabel && (
					<div className="flex justify-end pt-2 border-t border-vscode-editorGroup-border">
						<VSCodeButton appearance="primary" onClick={onProceed}>
							{proceedLabel}
						</VSCodeButton>
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
