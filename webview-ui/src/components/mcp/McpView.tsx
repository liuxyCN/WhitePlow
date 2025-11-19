import React, { useState } from "react"
import { Trans } from "react-i18next"
import {
	VSCodeButton,
	VSCodeCheckbox,
	VSCodeLink,
	VSCodePanels,
	VSCodePanelTab,
	VSCodePanelView,
	VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"

import { McpServer } from "@roo/mcp"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	Button,
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
	ToggleSwitch,
	StandardTooltip,
} from "@src/components/ui"
import { buildDocLink } from "@src/utils/docLinks"

import { Tab, TabContent, TabHeader } from "../common/Tab"

import McpToolRow from "./McpToolRow"
import McpResourceRow from "./McpResourceRow"
import McpEnabledToggle from "./McpEnabledToggle"
import { McpErrorRow } from "./McpErrorRow"

type McpViewProps = {
	onDone: () => void
}

const McpView = ({ onDone }: McpViewProps) => {
	const {
		mcpServers: servers,
		alwaysAllowMcp,
		mcpEnabled,
		enableMcpServerCreation,
		setEnableMcpServerCreation,
		mcpGatewayEnabled,
		setMcpGatewayEnabled,
		mcpGatewayUrl,
		setMcpGatewayUrl,
		mcpGatewayApiKey,
		setMcpGatewayApiKey,
		mcpGatewayAlwaysAllow,
		setMcpGatewayAlwaysAllow,
	} = useExtensionState()

	const { t } = useAppTranslation()

	return (
		<Tab>
			<TabHeader className="flex justify-between items-center">
				<h3 className="text-vscode-foreground m-0">{t("mcp:title")}</h3>
				<Button onClick={onDone}>{t("mcp:done")}</Button>
			</TabHeader>

			<TabContent>
				<div
					style={{
						color: "var(--vscode-foreground)",
						fontSize: "13px",
						marginBottom: "10px",
						marginTop: "5px",
					}}>
					<Trans i18nKey="mcp:description">
						<VSCodeLink
							href={buildDocLink("features/mcp/using-mcp-in-roo", "mcp_settings")}
							style={{ display: "inline" }}>
							Learn More
						</VSCodeLink>
					</Trans>
				</div>

				<McpEnabledToggle />

				{mcpEnabled && (
					<>
						<div style={{ marginBottom: 15 }}>
							<VSCodeCheckbox
								checked={enableMcpServerCreation}
								onChange={(e: any) => {
									setEnableMcpServerCreation(e.target.checked)
									vscode.postMessage({ type: "enableMcpServerCreation", bool: e.target.checked })
								}}>
								<span style={{ fontWeight: "500" }}>{t("mcp:enableServerCreation.title")}</span>
							</VSCodeCheckbox>
							<div
								style={{
									fontSize: "12px",
									marginTop: "5px",
									color: "var(--vscode-descriptionForeground)",
								}}>
								<Trans i18nKey="mcp:enableServerCreation.description">
									<VSCodeLink
										href={buildDocLink(
											"features/mcp/using-mcp-in-roo#how-to-use-roo-to-create-an-mcp-server",
											"mcp_server_creation",
										)}
										style={{ display: "inline" }}>
										Learn about server creation
									</VSCodeLink>
									<strong>new</strong>
								</Trans>
								<p style={{ marginTop: "8px" }}>{t("mcp:enableServerCreation.hint")}</p>
							</div>
						</div>

						{/* MCP Gateway Configuration */}
						<div style={{ marginBottom: 20 }}>
							<h4 style={{ margin: "0 0 10px 0", fontWeight: "500" }}>{t("mcp:gateway.title")}</h4>
							<div
								style={{
									fontSize: "12px",
									marginBottom: "10px",
									color: "var(--vscode-descriptionForeground)",
								}}>
								{t("mcp:gateway.description")}
							</div>

							{/* MCP Gateway Enable Toggle */}
							<div style={{ marginBottom: 15 }}>
								<VSCodeCheckbox
									checked={mcpGatewayEnabled}
									onChange={(e: any) => {
										setMcpGatewayEnabled(e.target.checked)
										vscode.postMessage({ type: "mcpGatewayEnabled", bool: e.target.checked })
									}}>
									<span style={{ fontWeight: "500" }}>{t("mcp:gateway.enable.title")}</span>
								</VSCodeCheckbox>
								<div
									style={{
										fontSize: "12px",
										marginTop: "5px",
										color: "var(--vscode-descriptionForeground)",
									}}>
									{t("mcp:gateway.enable.description")}
								</div>
							</div>

							{/* Gateway URL and API Key - only show when enabled */}
							{mcpGatewayEnabled && (
								<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
									<VSCodeTextField
										value={mcpGatewayUrl || ""}
										onInput={(e: any) => {
											const value = e.target.value
											setMcpGatewayUrl(value)
											vscode.postMessage({ type: "mcpGatewayUrl", text: value })
										}}
										placeholder={t("mcp:gateway.url.placeholder")}
										style={{ width: "100%" }}>
										<label style={{ fontWeight: "500" }}>{t("mcp:gateway.url.label")}</label>
									</VSCodeTextField>
									<VSCodeTextField
										value={mcpGatewayApiKey || ""}
										type="password"
										onInput={(e: any) => {
											const value = e.target.value
											setMcpGatewayApiKey(value)
											vscode.postMessage({ type: "mcpGatewayApiKey", text: value })
										}}
										placeholder={t("mcp:gateway.apiKey.placeholder")}
										style={{ width: "100%" }}>
										<label style={{ fontWeight: "500" }}>{t("mcp:gateway.apiKey.label")}</label>
									</VSCodeTextField>
									
									{/* MCP Gateway Always Allow Toggle */}
									<div style={{ marginTop: 10 }}>
										<VSCodeCheckbox
											checked={mcpGatewayAlwaysAllow}
											onChange={(e: any) => {
												setMcpGatewayAlwaysAllow(e.target.checked)
												vscode.postMessage({ type: "mcpGatewayAlwaysAllow", bool: e.target.checked })
											}}>
											<span style={{ fontWeight: "500" }}>{t("mcp:gateway.alwaysAllow.title")}</span>
										</VSCodeCheckbox>
										<div
											style={{
												fontSize: "12px",
												marginTop: "5px",
												color: "var(--vscode-descriptionForeground)",
											}}>
											{t("mcp:gateway.alwaysAllow.description")}
										</div>
									</div>
								</div>
							)}
						</div>

						{/* Server List */}
						{servers.length > 0 && (
							<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
								{servers.map((server) => (
									<ServerRow
										key={`${server.name}-${server.source || "global"}`}
										server={server}
										alwaysAllowMcp={alwaysAllowMcp}
									/>
								))}
							</div>
						)}

						{/* Edit Settings Buttons */}
						<div
							style={{
								marginTop: "10px",
								width: "100%",
								display: "grid",
								gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
								gap: "10px",
							}}>
							<Button
								variant="secondary"
								style={{ width: "100%" }}
								onClick={() => {
									vscode.postMessage({ type: "openMcpSettings" })
								}}>
								<span className="codicon codicon-edit" style={{ marginRight: "6px" }}></span>
								{t("mcp:editGlobalMCP")}
							</Button>
							<Button
								variant="secondary"
								style={{ width: "100%" }}
								onClick={() => {
									vscode.postMessage({ type: "openProjectMcpSettings" })
								}}>
								<span className="codicon codicon-edit" style={{ marginRight: "6px" }}></span>
								{t("mcp:editProjectMCP")}
							</Button>
							<Button
								variant="secondary"
								style={{ width: "100%" }}
								onClick={() => {
									vscode.postMessage({ type: "refreshAllMcpServers" })
								}}>
								<span className="codicon codicon-refresh" style={{ marginRight: "6px" }}></span>
								{t("mcp:refreshMCP")}
							</Button>
							{/* <StandardTooltip content={t("mcp:marketplace")}>
								<Button
									variant="secondary"
									style={{ width: "100%" }}
									onClick={() => {
										window.postMessage(
											{
												type: "action",
												action: "marketplaceButtonClicked",
												values: { marketplaceTab: "mcp" },
											},
											"*",
										)
									}}>
									<span className="codicon codicon-extensions" style={{ marginRight: "6px" }}></span>
									{t("mcp:marketplace")}
								</Button>
							</StandardTooltip> */}
						</div>
						<div
							style={{
								marginTop: "15px",
								fontSize: "12px",
								color: "var(--vscode-descriptionForeground)",
							}}>
							<VSCodeLink
								href={buildDocLink(
									"features/mcp/using-mcp-in-roo#editing-mcp-settings-files",
									"mcp_edit_settings",
								)}
								style={{ display: "inline" }}>
								{t("mcp:learnMoreEditingSettings")}
							</VSCodeLink>
						</div>
					</>
				)}
			</TabContent>
		</Tab>
	)
}

const ServerRow = ({ server, alwaysAllowMcp }: { server: McpServer; alwaysAllowMcp?: boolean }) => {
	const { t } = useAppTranslation()
	const [isExpanded, setIsExpanded] = useState(false)
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
	const [showConfigDialog, setShowConfigDialog] = useState(false)
	const [authKey, setAuthKey] = useState("")
	const [extraFieldValues, setExtraFieldValues] = useState<Record<string, string>>({})
	const [timeoutValue, setTimeoutValue] = useState(() => {
		const configTimeout = JSON.parse(server.config)?.timeout
		return configTimeout ?? 600 // Default 10 minutes (600 seconds)
	})

	// Computed property to check if server is expandable
	const isExpandable = server.status === "connected" && !server.disabled

	const timeoutOptions = [
		{ value: 15, label: t("mcp:networkTimeout.options.15seconds") },
		{ value: 30, label: t("mcp:networkTimeout.options.30seconds") },
		{ value: 60, label: t("mcp:networkTimeout.options.1minute") },
		{ value: 300, label: t("mcp:networkTimeout.options.5minutes") },
		{ value: 600, label: t("mcp:networkTimeout.options.10minutes") },
		{ value: 900, label: t("mcp:networkTimeout.options.15minutes") },
		{ value: 1800, label: t("mcp:networkTimeout.options.30minutes") },
		{ value: 3600, label: t("mcp:networkTimeout.options.60minutes") },
	]

	const getStatusColor = () => {
		// Disabled servers should always show grey regardless of connection status
		if (server.disabled) {
			return "var(--vscode-descriptionForeground)"
		}

		switch (server.status) {
			case "connected":
				return "var(--vscode-testing-iconPassed)"
			case "connecting":
				return "var(--vscode-charts-yellow)"
			case "disconnected":
				return "var(--vscode-testing-iconFailed)"
		}
	}

	const getSourceBadgeStyle = () => {
		const source = server.source || "global"
		const baseStyle = {
			marginLeft: "8px",
			padding: "1px 6px",
			fontSize: "11px",
			borderRadius: "4px",
		}

		switch (source) {
			case "global":
				return {
					...baseStyle,
					background: "var(--vscode-charts-blue)",
					color: "var(--vscode-editor-background)",
				}
			case "project":
				return {
					...baseStyle,
					background: "var(--vscode-testing-iconPassed)",
					color: "var(--vscode-editor-background)",
				}
			case "memory":
				return {
					...baseStyle,
					background: "var(--vscode-charts-purple)",
					color: "var(--vscode-editor-background)",
				}
			default:
				return {
					...baseStyle,
					background: "var(--vscode-badge-background)",
					color: "var(--vscode-badge-foreground)",
				}
		}
	}

	const handleRowClick = () => {
		// Only allow expansion for connected and enabled servers
		if (isExpandable) {
			setIsExpanded(!isExpanded)
		}
	}

	const handleRestart = () => {
		vscode.postMessage({
			type: "restartMcpServer",
			text: server.name,
			source: server.source || "global",
		})
	}

	const handleTimeoutChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
		const seconds = parseInt(event.target.value)
		setTimeoutValue(seconds)
		vscode.postMessage({
			type: "updateMcpTimeout",
			serverName: server.name,
			source: server.source || "global",
			timeout: seconds,
		})
	}

	const handleDelete = () => {
		vscode.postMessage({
			type: "deleteMcpServer",
			serverName: server.name,
			source: server.source || "global",
		})
		setShowDeleteConfirm(false)
	}

	const handleConfigClick = () => {
		setShowConfigDialog(true)
		setAuthKey("")
		// Initialize extra field values
		const initialValues: Record<string, string> = {}
		if (server.serverConfig?.extraFields) {
			server.serverConfig.extraFields.forEach((field) => {
				initialValues[field.fieldName] = ""
			})
		}
		setExtraFieldValues(initialValues)
	}

	const handleSaveAuthKey = () => {
		if (!authKey.trim()) {
			return
		}
		vscode.postMessage({
			type: "saveMcpServerAuthKey",
			serverName: server.name,
			authKey: authKey,
		})
	}

	const handleSaveExtraField = (fieldName: string, fieldValue: string) => {
		if (!fieldValue.trim()) {
			return
		}
		vscode.postMessage({
			type: "saveMcpServerExtraField",
			serverName: server.name,
			extraFieldName: fieldName,
			extraFieldValue: fieldValue,
		})
	}

	// Check if server needs configuration
	const needsConfiguration =
		server.configStatus === "configured" || server.configStatus === "not_configured"

	return (
		<div style={{ marginBottom: "10px" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					padding: "8px",
					background: "var(--vscode-textCodeBlock-background)",
					cursor: isExpandable ? "pointer" : "default",
					borderRadius: isExpanded || isExpandable ? "4px" : "4px 4px 0 0",
					opacity: server.disabled ? 0.6 : 1,
				}}
				onClick={handleRowClick}>
				{isExpandable && (
					<span
						className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`}
						style={{ marginRight: "8px" }}
					/>
				)}
				<span style={{ flex: 1 }}>
					{server.name}
					{server.source && (
						<span style={getSourceBadgeStyle()}>
							{server.source}
						</span>
					)}
				</span>
				<div
					style={{ display: "flex", alignItems: "center", marginRight: "8px" }}
					onClick={(e) => e.stopPropagation()}>
					{needsConfiguration && (
						<Button
							variant="ghost"
							size="icon"
							onClick={handleConfigClick}
							style={{ marginRight: "8px" }}>
							<span className="codicon codicon-settings-gear" style={{ fontSize: "14px" }}></span>
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setShowDeleteConfirm(true)}
						style={{ marginRight: "8px" }}>
						<span className="codicon codicon-trash" style={{ fontSize: "14px" }}></span>
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={handleRestart}
						disabled={server.status === "connecting"}
						style={{ marginRight: "8px" }}>
						<span className="codicon codicon-refresh" style={{ fontSize: "14px" }}></span>
					</Button>
				</div>
				<div
					style={{
						width: "8px",
						height: "8px",
						borderRadius: "50%",
						background: getStatusColor(),
						marginLeft: "8px",
					}}
				/>
				<div style={{ marginLeft: "8px" }}>
					<ToggleSwitch
						checked={!server.disabled}
						onChange={() => {
							vscode.postMessage({
								type: "toggleMcpServer",
								serverName: server.name,
								source: server.source || "global",
								disabled: !server.disabled,
							})
						}}
						size="medium"
						aria-label={`Toggle ${server.name} server`}
					/>
				</div>
			</div>

			{isExpandable
				? isExpanded && (
						<div
							style={{
								background: "var(--vscode-textCodeBlock-background)",
								padding: "0 10px 10px 10px",
								fontSize: "13px",
								borderRadius: "0 0 4px 4px",
							}}>
							<VSCodePanels style={{ marginBottom: "10px" }}>
								<VSCodePanelTab id="tools">
									{t("mcp:tabs.tools")} ({server.tools?.length || 0})
								</VSCodePanelTab>
								<VSCodePanelTab id="resources">
									{t("mcp:tabs.resources")} (
									{[...(server.resourceTemplates || []), ...(server.resources || [])].length || 0})
								</VSCodePanelTab>
								{server.instructions && (
									<VSCodePanelTab id="instructions">{t("mcp:instructions")}</VSCodePanelTab>
								)}
								<VSCodePanelTab id="logs">
									{t("mcp:tabs.logs")} ({server.errorHistory?.length || 0})
								</VSCodePanelTab>

								<VSCodePanelView id="tools-view">
									{server.tools && server.tools.length > 0 ? (
										<div
											style={{
												display: "flex",
												flexDirection: "column",
												gap: "8px",
												width: "100%",
											}}>
											{server.tools.map((tool) => (
												<McpToolRow
													key={`${tool.name}-${server.name}-${server.source || "global"}`}
													tool={tool}
													serverName={server.name}
													serverSource={server.source || "global"}
													alwaysAllowMcp={alwaysAllowMcp}
												/>
											))}
										</div>
									) : (
										<div
											style={{ padding: "10px 0", color: "var(--vscode-descriptionForeground)" }}>
											{t("mcp:emptyState.noTools")}
										</div>
									)}
								</VSCodePanelView>

								<VSCodePanelView id="resources-view">
									{(server.resources && server.resources.length > 0) ||
									(server.resourceTemplates && server.resourceTemplates.length > 0) ? (
										<div
											style={{
												display: "flex",
												flexDirection: "column",
												gap: "8px",
												width: "100%",
											}}>
											{[...(server.resourceTemplates || []), ...(server.resources || [])].map(
												(item) => (
													<McpResourceRow
														key={"uriTemplate" in item ? item.uriTemplate : item.uri}
														item={item}
													/>
												),
											)}
										</div>
									) : (
										<div
											style={{ padding: "10px 0", color: "var(--vscode-descriptionForeground)" }}>
											{t("mcp:emptyState.noResources")}
										</div>
									)}
								</VSCodePanelView>

								{server.instructions && (
									<VSCodePanelView id="instructions-view">
										<div style={{ padding: "10px 0", fontSize: "12px" }}>
											<div className="opacity-80 whitespace-pre-wrap break-words">
												{server.instructions}
											</div>
										</div>
									</VSCodePanelView>
								)}

								<VSCodePanelView id="logs-view">
									{server.errorHistory && server.errorHistory.length > 0 ? (
										<div
											style={{
												display: "flex",
												flexDirection: "column",
												gap: "8px",
												width: "100%",
											}}>
											{[...server.errorHistory]
												.sort((a, b) => b.timestamp - a.timestamp)
												.map((error, index) => (
													<McpErrorRow key={`${error.timestamp}-${index}`} error={error} />
												))}
										</div>
									) : (
										<div
											style={{ padding: "10px 0", color: "var(--vscode-descriptionForeground)" }}>
											{t("mcp:emptyState.noLogs")}
										</div>
									)}
								</VSCodePanelView>
							</VSCodePanels>

							{/* Network Timeout */}
							<div style={{ padding: "10px 7px" }}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: "10px",
										marginBottom: "8px",
									}}>
									<span>{t("mcp:networkTimeout.label")}</span>
									<select
										value={timeoutValue}
										onChange={handleTimeoutChange}
										style={{
											flex: 1,
											padding: "4px",
											background: "var(--vscode-dropdown-background)",
											color: "var(--vscode-dropdown-foreground)",
											border: "1px solid var(--vscode-dropdown-border)",
											borderRadius: "2px",
											outline: "none",
											cursor: "pointer",
										}}>
										{timeoutOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</select>
								</div>
								<span
									style={{
										fontSize: "12px",
										color: "var(--vscode-descriptionForeground)",
										display: "block",
									}}>
									{t("mcp:networkTimeout.description")}
								</span>
							</div>
						</div>
					)
				: // Only show error UI for non-disabled servers
					!server.disabled && (
						<div
							style={{
								fontSize: "13px",
								background: "var(--vscode-textCodeBlock-background)",
								borderRadius: "0 0 4px 4px",
								width: "100%",
							}}>
							<div
								style={{
									color: "var(--vscode-testing-iconFailed)",
									marginBottom: "8px",
									padding: "0 10px",
									overflowWrap: "break-word",
									wordBreak: "break-word",
								}}>
								{server.error &&
									server.error.split("\n").map((item, index) => (
										<React.Fragment key={index}>
											{index > 0 && <br />}
											{item}
										</React.Fragment>
									))}
							</div>
							<VSCodeButton
								appearance="secondary"
								onClick={handleRestart}
								disabled={server.status === "connecting"}
								style={{ width: "calc(100% - 20px)", margin: "0 10px 10px 10px" }}>
								{server.status === "connecting"
									? t("mcp:serverStatus.retrying")
									: t("mcp:serverStatus.retryConnection")}
							</VSCodeButton>
						</div>
					)}

			{/* Delete Confirmation Dialog */}
			<Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("mcp:deleteDialog.title")}</DialogTitle>
						<DialogDescription>
							{t("mcp:deleteDialog.description", { serverName: server.name })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setShowDeleteConfirm(false)}>
							{t("mcp:deleteDialog.cancel")}
						</Button>
						<Button variant="default" onClick={handleDelete}>
							{t("mcp:deleteDialog.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Configuration Dialog */}
			<Dialog open={showConfigDialog} onOpenChange={setShowConfigDialog}>
				<DialogContent style={{ maxWidth: "500px" }}>
					<DialogHeader>
						<DialogTitle>
							{server.serverConfig?.fieldLabel || t("mcp:configDialog.title", { serverName: server.name })}
						</DialogTitle>
						<DialogDescription>
							{t("mcp:configDialog.description", { serverName: server.name })}
						</DialogDescription>
					</DialogHeader>
					<div style={{ display: "flex", flexDirection: "column", gap: "15px", marginTop: "15px" }}>
						{/* Instructions */}
						{server.serverConfig?.instructions && (
							<div
								style={{
									padding: "12px",
									background: "var(--vscode-textCodeBlock-background)",
									borderRadius: "4px",
									fontSize: "13px",
								}}>
								<div
									style={{
										fontWeight: "500",
										marginBottom: "8px",
										color: "var(--vscode-foreground)",
									}}>
									{server.serverConfig.instructions.title}
								</div>
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: "4px",
										color: "var(--vscode-descriptionForeground)",
									}}>
									<div>{server.serverConfig.instructions.step1}</div>
									<div>{server.serverConfig.instructions.step2}</div>
									<div>{server.serverConfig.instructions.step3}</div>
									<div>{server.serverConfig.instructions.step4}</div>
									<div>{server.serverConfig.instructions.step5}</div>
								</div>
							</div>
						)}
						<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
							<VSCodeTextField
								value={authKey}
								type="password"
								onInput={(e: any) => {
									setAuthKey(e.target.value)
								}}
								placeholder={
									server.configStatus === "configured"
										? "已配置 / Already configured"
										: "未配置 / Not configured"
								}
								style={{ width: "100%" }}>
							</VSCodeTextField>
							<Button
								variant="default"
								size="sm"
								onClick={handleSaveAuthKey}
								disabled={!authKey.trim()}
								style={{ alignSelf: "flex-end", width: "auto" }}>
								{t("mcp:configDialog.save")}
							</Button>
						</div>

						{server.serverConfig?.extraFields &&
							server.serverConfig.extraFields.map((field) => (
								<div key={field.fieldName} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
									<VSCodeTextField
										value={extraFieldValues[field.fieldName] || ""}
										onInput={(e: any) => {
											setExtraFieldValues({
												...extraFieldValues,
												[field.fieldName]: e.target.value,
											})
										}}
										placeholder={t("mcp:configDialog.extraField.placeholder", { fieldLabel: field.fieldLabel })}
										style={{ width: "100%" }}>
									</VSCodeTextField>
									<Button
										variant="default"
										size="sm"
										onClick={() => handleSaveExtraField(field.fieldName, extraFieldValues[field.fieldName] || "")}
										disabled={!extraFieldValues[field.fieldName]?.trim()}
										style={{ alignSelf: "flex-end", width: "auto" }}>
										{t("mcp:configDialog.save")}
									</Button>
								</div>
							))}
					</div>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setShowConfigDialog(false)}>
							{t("mcp:configDialog.cancel")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

export default McpView
