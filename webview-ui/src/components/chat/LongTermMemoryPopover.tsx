import React, { useState, useEffect, useMemo, useCallback } from "react"
import { Brain, Sparkles, Trash2 } from "lucide-react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import type { LongTermMemoryContentsSnapshot, LongTermMemoryStatus } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import { PopoverTrigger, StandardTooltip, Button, Popover, PopoverContent } from "@src/components/ui"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { useRooPortal } from "@src/components/ui/hooks/useRooPortal"

interface LongTermMemoryPopoverProps {
	children: React.ReactNode
	status: LongTermMemoryStatus
}

const LongTermMemoryPopover: React.FC<LongTermMemoryPopoverProps> = ({ children, status: externalStatus }) => {
	const { t } = useAppTranslation()
	const { longTermMemoryConfig } = useExtensionState()
	const [open, setOpen] = useState(false)
	const portalContainer = useRooPortal("roo-portal")
	const [internalStatus, setInternalStatus] = useState<LongTermMemoryStatus>(externalStatus)
	const [contentsSnapshot, setContentsSnapshot] = useState<LongTermMemoryContentsSnapshot | null>(null)
	const [contentsLoading, setContentsLoading] = useState(false)

	const featureOn = longTermMemoryConfig?.longTermMemoryEnabled !== false
	const pauseIngest = longTermMemoryConfig?.longTermMemoryPauseIngest === true
	const smartInject = longTermMemoryConfig?.longTermMemorySmartInject !== false

	const updateLongTermMemoryConfig = (partial: Record<string, boolean | number | undefined>) => {
		vscode.postMessage({
			type: "updateSettings",
			updatedSettings: {
				longTermMemoryConfig: {
					...(longTermMemoryConfig ?? {}),
					...partial,
				},
			},
		})
	}

	const requestContents = useCallback(() => {
		setContentsLoading(true)
		vscode.postMessage({ type: "requestLongTermMemoryContents" })
	}, [])

	const requestContentsRefreshAfterAction = useCallback(() => {
		setContentsLoading(true)
	}, [])

	useEffect(() => {
		setInternalStatus(externalStatus)
	}, [externalStatus])

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === "longTermMemoryStatusUpdate") {
				setInternalStatus(event.data.values as LongTermMemoryStatus)
			} else if (event.data?.type === "longTermMemoryContents") {
				setContentsSnapshot(event.data.values as LongTermMemoryContentsSnapshot)
				setContentsLoading(false)
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestLongTermMemoryStatus" })
			requestContents()
		}
	}, [open, requestContents])

	const structuredKeys = useMemo(() => {
		if (!contentsSnapshot) {
			return []
		}
		return Object.keys(contentsSnapshot.structured).sort((a, b) => a.localeCompare(b))
	}, [contentsSnapshot])

	const formatStructuredValue = (v: string | number | boolean) => {
		if (typeof v === "boolean") {
			return v ? "true" : "false"
		}
		return String(v)
	}

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
		| "ingesting"
		| "optimizing"
		| "error"

	const longTermMemoryBusy =
		internalStatus.systemStatus === "Ingesting" || internalStatus.systemStatus === "Optimizing"

	return (
		<Popover open={open} onOpenChange={setOpen}>
			{children}
			<PopoverContent
				className="w-[min(100vw-2rem,28rem)] max-h-[min(96vh,42rem)] overflow-y-auto p-4"
				align="end"
				container={portalContainer}>
				<div className="flex flex-col gap-3 text-sm text-vscode-foreground">
					<h4 className="m-0 pb-1">{t("settings:longTermMemory.title")}</h4>
					<p className="m-0 text-vscode-descriptionForeground text-xs leading-snug">
						{t("settings:longTermMemory.description")}
					</p>

					<div className="flex items-center gap-2">
						<VSCodeCheckbox
							checked={featureOn}
							onChange={(e: any) => updateLongTermMemoryConfig({ longTermMemoryEnabled: e.target.checked })}>
							<span className="font-medium">{t("settings:longTermMemory.enableLabel")}</span>
						</VSCodeCheckbox>
						<StandardTooltip content={t("settings:longTermMemory.enableDescription")}>
							<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
						</StandardTooltip>
					</div>

					<div className="flex items-center gap-2">
						<VSCodeCheckbox
							checked={pauseIngest}
							onChange={(e: any) =>
								updateLongTermMemoryConfig({ longTermMemoryPauseIngest: e.target.checked })
							}>
							<span className="text-sm">{t("settings:longTermMemory.pauseIngestLabel")}</span>
						</VSCodeCheckbox>
					</div>

					<div className="flex items-center gap-2">
						<VSCodeCheckbox
							checked={smartInject}
							disabled={!featureOn}
							onChange={(e: any) =>
								updateLongTermMemoryConfig({ longTermMemorySmartInject: e.target.checked })
							}>
							<span className="text-sm">{t("settings:longTermMemory.smartInjectLabel")}</span>
						</VSCodeCheckbox>
						<StandardTooltip content={t("settings:longTermMemory.smartInjectDescription")}>
							<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
						</StandardTooltip>
					</div>

					<div>
						<h4 className="text-xs font-medium m-0 mb-1">{t("settings:longTermMemory.statusTitle")}</h4>
						<p className="m-0 text-xs text-vscode-descriptionForeground">
							{t(`settings:longTermMemory.statuses.${statusKey}`)}
							{internalStatus.totalItems > 0 &&
								internalStatus.systemStatus === "Ingesting" &&
								` (${progressPercentage}%)`}
						</p>
						{internalStatus.totalItems > 0 && internalStatus.systemStatus === "Ingesting" && (
							<ProgressPrimitive.Root
								className="relative h-1.5 w-full overflow-hidden rounded-full bg-vscode-input-background mt-2"
								value={progressPercentage}>
								<ProgressPrimitive.Indicator
									className="h-full bg-vscode-button-background transition-transform duration-300 ease-out"
									style={{ transform: transformStyleString }}
								/>
							</ProgressPrimitive.Root>
						)}
						<p className="m-0 mt-2 text-xs text-vscode-descriptionForeground">
							{t("settings:longTermMemory.structuredCount", { count: internalStatus.structuredKeyCount })}
						</p>
					</div>

					<div className="border border-vscode-widget-border rounded p-2 space-y-2">
						<div className="flex items-center justify-between gap-2">
							<h4 className="text-xs font-medium m-0">{t("settings:longTermMemory.browseSectionTitle")}</h4>
							<div className="flex items-center gap-1.5 shrink-0">
								<Button
									variant="secondary"
									className="text-xs h-7 px-2"
									onClick={() => vscode.postMessage({ type: "longTermMemoryOpenPreferencesFile" })}>
									{t("settings:longTermMemory.browseOpenFileButton")}
								</Button>
								<Button variant="secondary" className="text-xs h-7 px-2" onClick={() => requestContents()}>
									{t("settings:longTermMemory.browseRefreshButton")}
								</Button>
							</div>
						</div>
						{contentsLoading && (
							<p className="m-0 text-xs text-vscode-descriptionForeground">{t("settings:longTermMemory.browseLoading")}</p>
						)}
						{!contentsLoading && contentsSnapshot && (
							<details className="rounded bg-vscode-editor-background/40">
								<summary className="cursor-pointer text-xs font-medium px-2 py-1.5 select-none">
									{t("settings:longTermMemory.browseStructuredTitle")}
								</summary>
								<div className="px-2 pb-2 max-h-60 overflow-y-auto border-t border-vscode-widget-border">
									{structuredKeys.length === 0 ? (
										<p className="m-0 mt-2 text-xs text-vscode-descriptionForeground">
											{t("settings:longTermMemory.browseEmptyStructured")}
										</p>
									) : (
										<dl className="m-0 mt-2 space-y-2">
											{structuredKeys.map((key) => (
												<div key={key} className="flex gap-1.5 items-start justify-between">
													<div className="min-w-0 flex-1">
														<dt className="text-[10px] uppercase tracking-wide text-vscode-descriptionForeground font-mono break-all">
															{key}
														</dt>
														<dd className="m-0 mt-0.5 text-xs whitespace-pre-wrap break-words pl-0">
															{formatStructuredValue(contentsSnapshot.structured[key])}
														</dd>
													</div>
													<StandardTooltip content={t("settings:longTermMemory.browseDeleteKeyTooltip")}>
														<Button
															variant="ghost"
															className="h-7 w-7 p-0 shrink-0 text-vscode-descriptionForeground hover:text-vscode-errorForeground"
															disabled={!featureOn || longTermMemoryBusy}
															onClick={() => {
																requestContentsRefreshAfterAction()
																vscode.postMessage({ type: "longTermMemoryDeleteKey", memoryKey: key })
															}}
															aria-label={t("settings:longTermMemory.browseDeleteKeyAria")}>
															<Trash2 className="h-3.5 w-3.5" />
														</Button>
													</StandardTooltip>
												</div>
											))}
										</dl>
									)}
								</div>
							</details>
						)}
					</div>

					{internalStatus.recentErrors.length > 0 && (
						<div>
							<h4 className="text-xs font-medium m-0 mb-1">{t("settings:longTermMemory.errorsTitle")}</h4>
							<ul className="m-0 pl-4 max-h-24 overflow-y-auto text-xs">
								{internalStatus.recentErrors.map((err, i) => (
									<li key={i} className="break-words">
										{err}
									</li>
								))}
							</ul>
							<Button
								variant="secondary"
								className="mt-2"
								onClick={() => vscode.postMessage({ type: "longTermMemoryClearErrors" })}>
								{t("settings:longTermMemory.clearErrorsButton")}
							</Button>
						</div>
					)}

					<div className="flex flex-wrap gap-2 pt-2 border-t">
						<Button
							variant="secondary"
							disabled={!featureOn || longTermMemoryBusy}
							onClick={() => {
								vscode.postMessage({ type: "longTermMemoryOptimizeStructured" })
							}}>
							<Sparkles className="h-3.5 w-3.5 mr-1 inline-block align-middle" />
							{t("settings:longTermMemory.optimizeButton")}
						</Button>
						<Button
							variant="secondary"
							disabled={!featureOn || longTermMemoryBusy}
							onClick={() => {
								requestContentsRefreshAfterAction()
								vscode.postMessage({ type: "longTermMemoryRescanAll" })
							}}>
							{t("settings:longTermMemory.rescanButton")}
						</Button>
						<Button
							variant="secondary"
							disabled={!featureOn}
							onClick={() => {
								requestContentsRefreshAfterAction()
								vscode.postMessage({ type: "longTermMemoryClearStructuredMemory" })
							}}>
							{t("settings:longTermMemory.clearStructuredButton")}
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}

interface LongTermMemoryStatusBadgeProps {
	className?: string
}

export const LongTermMemoryStatusBadge: React.FC<LongTermMemoryStatusBadgeProps> = ({ className }) => {
	const { t } = useAppTranslation()

	const [status, setStatus] = useState<LongTermMemoryStatus>({
		featureEnabled: true,
		systemStatus: "Idle",
		processedItems: 0,
		totalItems: 0,
		recentErrors: [],
		structuredKeyCount: 0,
	})

	useEffect(() => {
		vscode.postMessage({ type: "requestLongTermMemoryStatus" })

		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === "longTermMemoryStatusUpdate") {
				setStatus(event.data.values as LongTermMemoryStatus)
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const progressPercentage = useMemo(
		() => (status.totalItems > 0 ? Math.round((status.processedItems / status.totalItems) * 100) : 0),
		[status.processedItems, status.totalItems],
	)

	const tooltipText = useMemo(() => {
		switch (status.systemStatus) {
			case "Standby":
				return t("chat:longTermMemoryStatus.standby")
			case "Idle":
				return t("chat:longTermMemoryStatus.idle")
			case "Processing":
				return t("chat:longTermMemoryStatus.processing")
			case "Ingesting":
				return t("chat:longTermMemoryStatus.ingesting", { percentage: progressPercentage })
			case "Optimizing":
				return t("chat:longTermMemoryStatus.optimizing")
			case "Error":
				return t("chat:longTermMemoryStatus.error")
			default:
				return t("chat:longTermMemoryStatus.status")
		}
	}, [status.systemStatus, progressPercentage, t])

	const statusColorClass = useMemo(() => {
		const colors: Record<LongTermMemoryStatus["systemStatus"], string> = {
			Standby: "bg-vscode-descriptionForeground/60",
			Idle: "bg-green-500",
			Processing: "bg-yellow-500 animate-pulse",
			Ingesting: "bg-yellow-500 animate-pulse",
			Optimizing: "bg-yellow-500 animate-pulse",
			Error: "bg-red-500",
		}
		return colors[status.systemStatus]
	}, [status.systemStatus])

	return (
		<LongTermMemoryPopover status={status}>
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
						<Brain className="w-4 h-4" />
						<span
							className={cn(
								"absolute top-0 right-0 w-1.5 h-1.5 rounded-full transition-colors duration-200",
								statusColorClass,
							)}
						/>
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
		</LongTermMemoryPopover>
	)
}
