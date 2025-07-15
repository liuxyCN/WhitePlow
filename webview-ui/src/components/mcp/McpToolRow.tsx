import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { McpTool } from "@roo/mcp"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { StandardTooltip, ToggleSwitch } from "@/components/ui"

type McpToolRowProps = {
	tool: McpTool
	serverName?: string
	serverSource?: "global" | "project" | "memory"
	alwaysAllowMcp?: boolean
	isInChatContext?: boolean
}

const McpToolRow = ({ tool, serverName, serverSource, alwaysAllowMcp, isInChatContext = false }: McpToolRowProps) => {
	const { t } = useAppTranslation()
	const isToolEnabled = tool.enabledForPrompt ?? true

	const handleAlwaysAllowChange = () => {
		if (!serverName) return
		vscode.postMessage({
			type: "toggleToolAlwaysAllow",
			serverName,
			source: serverSource || "global",
			toolName: tool.name,
			alwaysAllow: !tool.alwaysAllow,
		})
	}

	const handleEnabledForPromptChange = () => {
		if (!serverName) return
		vscode.postMessage({
			type: "toggleToolEnabledForPrompt",
			serverName,
			source: serverSource || "global",
			toolName: tool.name,
			isEnabled: !tool.enabledForPrompt,
		})
	}

	return (
		<div key={tool.name} className="py-2 border-b border-vscode-panel-border last:border-b-0">
			<div
				data-testid="tool-row-container"
				className="flex items-center gap-4"
				onClick={(e) => e.stopPropagation()}>
				{/* Tool name section */}
				<div className="flex items-center min-w-0 flex-1">
					<span
						className={`codicon codicon-symbol-method mr-2 flex-shrink-0 ${
							isToolEnabled
								? "text-vscode-symbolIcon-methodForeground"
								: "text-vscode-descriptionForeground opacity-60"
						}`}></span>
					<StandardTooltip
						content={
							<div className="max-w-md">
								<div className="font-medium mb-1">{tool.name}</div>
								{tool.description && (
									<div className="text-xs opacity-80 mb-2">{tool.description}</div>
								)}
								{isToolEnabled &&
									tool.inputSchema &&
									"properties" in tool.inputSchema &&
									Object.keys(tool.inputSchema.properties as Record<string, any>).length > 0 && (
										<div className="text-xs">
											<div className="mb-1 text-[11px] uppercase opacity-80">
												{t("mcp:tool.parameters")}
											</div>
											{Object.entries(tool.inputSchema.properties as Record<string, any>).map(
												([paramName, schema]) => {
													const isRequired =
														tool.inputSchema &&
														"required" in tool.inputSchema &&
														Array.isArray(tool.inputSchema.required) &&
														tool.inputSchema.required.includes(paramName)

													return (
														<div key={paramName} className="flex items-baseline mt-1">
															<code className="mr-2 text-xs">
																{paramName}
																{isRequired && <span className="text-red-400">*</span>}
															</code>
															<span className="opacity-80 break-words text-xs">
																{schema.description || t("mcp:tool.noDescription")}
															</span>
														</div>
													)
												},
											)}
										</div>
									)}
							</div>
						}>
						<span
							className={`font-medium truncate ${
								isToolEnabled
									? "text-vscode-foreground"
									: "text-vscode-descriptionForeground opacity-60"
							}`}>
							{tool.name}
						</span>
					</StandardTooltip>
				</div>

				{/* Controls section */}
				{serverName && (
					<div className="flex items-center gap-4 flex-shrink-0">
						{/* Always Allow checkbox - only show when tool is enabled */}
						{alwaysAllowMcp && isToolEnabled && (
							<VSCodeCheckbox
								checked={tool.alwaysAllow}
								onChange={handleAlwaysAllowChange}
								data-tool={tool.name}
								className="text-xs">
								<span className="text-vscode-descriptionForeground whitespace-nowrap">
									{t("mcp:tool.alwaysAllow")}
								</span>
							</VSCodeCheckbox>
						)}

						{/* Enabled toggle switch - only show in settings context */}
						{!isInChatContext && (
							<StandardTooltip content={t("mcp:tool.togglePromptInclusion")}>
								<ToggleSwitch
									checked={isToolEnabled}
									onChange={handleEnabledForPromptChange}
									size="medium"
									aria-label={t("mcp:tool.togglePromptInclusion")}
									data-testid={`tool-prompt-toggle-${tool.name}`}
								/>
							</StandardTooltip>
						)}
					</div>
				)}
			</div>
		</div>
	)
}

export default McpToolRow
