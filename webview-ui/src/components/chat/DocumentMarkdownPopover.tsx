import React, { useState, useEffect, useMemo } from "react"
import { FileText } from "lucide-react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import type { DocumentMarkdownStatus } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import { PopoverTrigger, StandardTooltip, Button, Popover, PopoverContent } from "@src/components/ui"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { useRooPortal } from "@src/components/ui/hooks/useRooPortal"

interface DocumentMarkdownPopoverProps {
	children: React.ReactNode
	documentMarkdownStatus: DocumentMarkdownStatus
}

export const DocumentMarkdownPopover: React.FC<DocumentMarkdownPopoverProps> = ({
	children,
	documentMarkdownStatus: externalDocumentMarkdownStatus,
}) => {
	const { t } = useAppTranslation()
	const { cwd, documentMarkdownConfig } = useExtensionState()
	const [open, setOpen] = useState(false)
	const portalContainer = useRooPortal("roo-portal")

	const [internalStatus, setInternalStatus] = useState<DocumentMarkdownStatus>(externalDocumentMarkdownStatus)

	const featureOn = documentMarkdownConfig?.documentMarkdownEnabled !== false
	const workspaceOn = internalStatus.workspaceEnabled ?? false

	const officeTypeOn = documentMarkdownConfig?.documentMarkdownConvertOffice !== false
	const pdfTypeOn = documentMarkdownConfig?.documentMarkdownConvertPdf !== false
	const imagesTypeOn = documentMarkdownConfig?.documentMarkdownConvertImages === true

	const updateDocumentMarkdownConfig = (partial: Record<string, boolean | undefined>) => {
		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: {
				documentMarkdownConfig: {
					...(documentMarkdownConfig ?? {}),
					...partial,
				},
			},
		})
	}

	useEffect(() => {
		setInternalStatus(externalDocumentMarkdownStatus)
	}, [externalDocumentMarkdownStatus])

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === "documentMarkdownStatusUpdate") {
				const values = event.data.values as DocumentMarkdownStatus
				if (!values.workspacePath || values.workspacePath === cwd) {
					setInternalStatus(values)
				}
			} else if (open && event.data?.type === "workspaceUpdated") {
				vscode.postMessage({ type: "requestDocumentMarkdownStatus" })
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [cwd, open])

	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestDocumentMarkdownStatus" })
		}
	}, [open])

	const progressPercentage = useMemo(
		() =>
			internalStatus.totalItems > 0
				? Math.round((internalStatus.processedItems / internalStatus.totalItems) * 100)
				: 0,
		[internalStatus.processedItems, internalStatus.totalItems],
	)

	const transformStyleString = `translateX(-${100 - progressPercentage}%)`

	const statusKey = internalStatus.systemStatus.toLowerCase() as
		| "standby"
		| "idle"
		| "processing"
		| "error"

	const updateGlobalFeature = (checked: boolean) => {
		updateDocumentMarkdownConfig({ documentMarkdownEnabled: checked })
	}

	return (
		<Popover
			open={open}
			onOpenChange={(newOpen) => {
				setOpen(newOpen)
				if (newOpen) {
					vscode.postMessage({ type: "requestDocumentMarkdownStatus" })
				}
			}}>
			{children}
			<PopoverContent
				className="w-[calc(100vw-32px)] max-w-[450px] max-h-[80vh] overflow-y-auto p-0"
				align="end"
				alignOffset={0}
				side="bottom"
				sideOffset={5}
				collisionPadding={16}
				avoidCollisions={true}
				container={portalContainer}>
				<div className="p-3 border-b border-vscode-dropdown-border cursor-default">
					<div className="flex flex-row items-center gap-1 p-0 mt-0 mb-1 w-full">
						<h4 className="m-0 pb-2 flex-1">{t("settings:documentMarkdown.title")}</h4>
					</div>
					<p className="my-0 pr-4 text-sm w-full text-vscode-descriptionForeground">
						{t("settings:documentMarkdown.description")}
					</p>
				</div>

				<div className="p-4">
					{/* Global feature (independent of codebase index) */}
					<div className="mb-4">
						<div className="flex items-center gap-2">
							<VSCodeCheckbox checked={featureOn} onChange={(e: any) => updateGlobalFeature(e.target.checked)}>
								<span className="font-medium">{t("settings:documentMarkdown.enableLabel")}</span>
							</VSCodeCheckbox>
							<StandardTooltip content={t("settings:documentMarkdown.enableDescription")}>
								<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
							</StandardTooltip>
						</div>
					</div>

					{featureOn && (
						<div className="mb-4 space-y-2">
							<h4 className="text-sm font-medium m-0">{t("settings:documentMarkdown.fileTypesTitle")}</h4>
							<div className="flex items-center gap-2">
								<VSCodeCheckbox
									checked={officeTypeOn}
									onChange={(e: any) =>
										updateDocumentMarkdownConfig({ documentMarkdownConvertOffice: e.target.checked })
									}>
									<span className="text-sm">{t("settings:documentMarkdown.convertOfficeLabel")}</span>
								</VSCodeCheckbox>
							</div>
							<div className="flex items-center gap-2">
								<VSCodeCheckbox
									checked={pdfTypeOn}
									onChange={(e: any) =>
										updateDocumentMarkdownConfig({ documentMarkdownConvertPdf: e.target.checked })
									}>
									<span className="text-sm">{t("settings:documentMarkdown.convertPdfLabel")}</span>
								</VSCodeCheckbox>
							</div>
							<div className="flex items-center gap-2">
								<VSCodeCheckbox
									checked={imagesTypeOn}
									onChange={(e: any) =>
										updateDocumentMarkdownConfig({ documentMarkdownConvertImages: e.target.checked })
									}>
									<span className="text-sm">{t("settings:documentMarkdown.convertImagesLabel")}</span>
								</VSCodeCheckbox>
							</div>
						</div>
					)}

					{/* Status (always visible when popover open — same idea as CodeIndexPopover) */}
					<div className="space-y-2 mb-4">
						<h4 className="text-sm font-medium">{t("settings:documentMarkdown.statusTitle")}</h4>
						<div className="text-sm text-vscode-descriptionForeground">
							<span
								className={cn("inline-block w-3 h-3 rounded-full mr-2", {
									"bg-gray-400": internalStatus.systemStatus === "Standby",
									"bg-green-500": internalStatus.systemStatus === "Idle",
									"bg-yellow-500 animate-pulse": internalStatus.systemStatus === "Processing",
									"bg-red-500": internalStatus.systemStatus === "Error",
								})}
							/>
							{t(`settings:documentMarkdown.statuses.${statusKey}`)}
							{internalStatus.message ? ` - ${internalStatus.message}` : ""}
						</div>

						{internalStatus.systemStatus === "Processing" && (
							<div className="mt-2">
								<ProgressPrimitive.Root
									className="relative h-2 w-full overflow-hidden rounded-full bg-secondary"
									value={progressPercentage}>
									<ProgressPrimitive.Indicator
										className="h-full w-full flex-1 bg-primary transition-transform duration-300 ease-in-out"
										style={{
											transform: transformStyleString,
										}}
									/>
								</ProgressPrimitive.Root>
							</div>
						)}
					</div>

					{featureOn && (
						<div className="flex items-center gap-2 pt-4 pb-1">
							<input
								type="checkbox"
								id="document-markdown-auto-enable-default"
								checked={internalStatus.autoEnableDefault ?? true}
								onChange={(e) =>
									vscode.postMessage({
										type: "setDocumentMarkdownAutoEnableDefault",
										bool: e.target.checked,
									})
								}
								className="accent-vscode-focusBorder"
							/>
							<label
								htmlFor="document-markdown-auto-enable-default"
								className="text-xs text-vscode-foreground cursor-pointer">
								{t("settings:documentMarkdown.autoEnableDefaultLabel")}
							</label>
						</div>
					)}

					{featureOn && (
						<div className="flex items-center gap-2 pt-1 pb-2">
							<input
								type="checkbox"
								id="document-markdown-workspace-toggle"
								checked={workspaceOn}
								onChange={(e) =>
									vscode.postMessage({
										type: "toggleDocumentMarkdownWorkspace",
										bool: e.target.checked,
									})
								}
								className="accent-vscode-focusBorder"
							/>
							<label
								htmlFor="document-markdown-workspace-toggle"
								className="text-xs text-vscode-foreground cursor-pointer">
								{t("settings:documentMarkdown.workspaceToggleLabel")}
							</label>
						</div>
					)}

					{featureOn && workspaceOn && !internalStatus.gatewayConfigured && (
						<p className="text-xs text-vscode-errorForeground pb-2">
							{t("settings:documentMarkdown.gatewayRequired")}
						</p>
					)}

					{featureOn && !workspaceOn && (
						<p className="text-xs text-vscode-descriptionForeground pb-2">
							{t("settings:documentMarkdown.workspaceDisabledMessage")}
						</p>
					)}

					{featureOn && internalStatus.recentErrors && internalStatus.recentErrors.length > 0 && (
						<div className="mt-4 space-y-1">
							<div className="flex items-center justify-between gap-2">
								<h4 className="text-sm font-medium text-vscode-errorForeground m-0">
									{t("settings:documentMarkdown.errorsTitle")}
								</h4>
								<Button
									variant="ghost"
									size="sm"
									className="shrink-0 h-7 text-xs"
									onClick={() => vscode.postMessage({ type: "documentMarkdownClearErrors" })}>
									{t("settings:documentMarkdown.clearErrorsButton")}
								</Button>
							</div>
							<ul className="text-xs text-vscode-errorForeground space-y-1 max-h-32 overflow-y-auto list-disc pl-4">
								{internalStatus.recentErrors.map((err: string, i: number) => (
									<li key={i} className="break-words">
										{err}
									</li>
								))}
							</ul>
						</div>
					)}

					<div className="flex items-center gap-2 pt-6">
						{featureOn &&
							internalStatus.enabled &&
							internalStatus.gatewayConfigured &&
							(internalStatus.systemStatus === "Idle" || internalStatus.systemStatus === "Error") && (
								<Button onClick={() => vscode.postMessage({ type: "documentMarkdownScanWorkspace" })}>
									{t("settings:documentMarkdown.startScanButton")}
								</Button>
							)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}

interface DocumentMarkdownStatusBadgeProps {
	className?: string
}

export const DocumentMarkdownStatusBadge: React.FC<DocumentMarkdownStatusBadgeProps> = ({ className }) => {
	const { t } = useAppTranslation()
	const { cwd } = useExtensionState()

	const [documentMarkdownStatus, setDocumentMarkdownStatus] = useState<DocumentMarkdownStatus>({
		enabled: false,
		featureEnabled: true,
		workspaceEnabled: false,
		systemStatus: "Standby",
		processedItems: 0,
		totalItems: 0,
		recentErrors: [],
		autoEnableDefault: true,
	})

	useEffect(() => {
		vscode.postMessage({ type: "requestDocumentMarkdownStatus" })

		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === "documentMarkdownStatusUpdate") {
				const values = event.data.values as DocumentMarkdownStatus
				if (!values.workspacePath || values.workspacePath === cwd) {
					setDocumentMarkdownStatus(values)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [cwd])

	const progressPercentage = useMemo(
		() =>
			documentMarkdownStatus.totalItems > 0
				? Math.round((documentMarkdownStatus.processedItems / documentMarkdownStatus.totalItems) * 100)
				: 0,
		[documentMarkdownStatus.processedItems, documentMarkdownStatus.totalItems],
	)

	const tooltipText = useMemo(() => {
		switch (documentMarkdownStatus.systemStatus) {
			case "Standby":
				return t("chat:documentMarkdownStatus.standby")
			case "Processing":
				return t("chat:documentMarkdownStatus.processing", { percentage: progressPercentage })
			case "Error":
				return t("chat:documentMarkdownStatus.error")
			default:
				return t("chat:documentMarkdownStatus.idle")
		}
	}, [documentMarkdownStatus.systemStatus, progressPercentage, t])

	const statusColorClass = useMemo(() => {
		const colors: Record<DocumentMarkdownStatus["systemStatus"], string> = {
			Standby: "bg-vscode-descriptionForeground/60",
			Idle: "bg-green-500",
			Processing: "bg-yellow-500 animate-pulse",
			Error: "bg-red-500",
		}
		return colors[documentMarkdownStatus.systemStatus]
	}, [documentMarkdownStatus.systemStatus])

	return (
		<DocumentMarkdownPopover documentMarkdownStatus={documentMarkdownStatus}>
			<StandardTooltip content={tooltipText}>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						aria-label={tooltipText}
						className={cn(
							"relative h-5 w-5 p-0",
							"text-vscode-foreground opacity-85",
							"hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)]",
							"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
							className,
						)}>
						<FileText className="w-4 h-4" />
						<span
							className={cn(
								"absolute top-0 right-0 w-1.5 h-1.5 rounded-full transition-colors duration-200",
								statusColorClass,
							)}
						/>
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
		</DocumentMarkdownPopover>
	)
}
