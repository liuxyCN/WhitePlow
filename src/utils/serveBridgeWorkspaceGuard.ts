import path from "path"
import * as vscode from "vscode"

import { isToolMemberOfToolGroups } from "../shared/tools"
import { t } from "../i18n"

import { isPathOutsideWorkspace } from "./pathUtils"

export function isRooServeBridge(): boolean {
	return process.env.ROO_SERVE_BRIDGE === "1"
}

/**
 * Webview message types that change extension / VS Code persisted settings, credentials,
 * installed marketplace/skills/commands configuration, or perform high-risk actions in serve:
 * globalState sync from webview, checkpoint restore, git worktrees/branches, arbitrary image save,
 * cloud share, diagnostics export, and settings/task/mode JSON exports. Blocked when {@link isRooServeBridge}.
 */
const SERVE_BRIDGE_BLOCKED_SETTINGS_WEBVIEW_MESSAGE_TYPES = new Set<string>([
	"allowedCommands",
	"autoApprovalEnabled",
	"chinalifePECheckCaptcha",
	"chinalifePELogin",
	"checkpointRestore",
	"checkoutBranch",
	"clearCloudAuthSkipModel",
	"clearIndexData",
	"cloudLandingPageSignIn",
	"createCommand",
	"createSkill",
	"createWorktree",
	"createWorktreeInclude",
	"customInstructions",
	"debugSetting",
	"deleteApiConfiguration",
	"deleteCommand",
	"deleteCustomMode",
	"deleteMcpServer",
	"deleteSkill",
	"deleteWorktree",
	"deniedCommands",
	"didShowAnnouncement",
	"dismissUpsell",
	"downloadErrorDiagnostics",
	"enhancementApiConfigId",
	"exportCurrentTask",
	"exportMode",
	"exportSettings",
	"exportTaskWithId",
	"flushRouterModels",
	"getListApiConfiguration",
	"hasOpenedModeSelector",
	"importMode",
	"importSettings",
	"installMarketplaceItem",
	"installMarketplaceItemWithParameters",
	"loadApiConfiguration",
	"loadApiConfigurationById",
	"lockApiConfigAcrossModes",
	"mcpGatewayAlwaysAllow",
	"mcpGatewayApiKey",
	"mcpGatewayEnabled",
	"mcpGatewayUrl",
	"mode",
	"moveSkill",
	"openAiCodexSignIn",
	"openAiCodexSignOut",
	"openProjectMcpSettings",
	"removeInstalledMarketplaceItem",
	"renameApiConfiguration",
	"resetState",
	"rooCloudManualUrl",
	"rooCloudSignIn",
	"rooCloudSignOut",
	"saveApiConfiguration",
	"saveCodeIndexSettingsAtomic",
	"saveImage",
	"saveMcpServerAuthKey",
	"saveMcpServerExtraField",
	"setAutoEnableDefault",
	"setDocumentMarkdownAutoEnableDefault",
	"startIndexing",
	"stopIndexing",
	"shareCurrentTask",
	"switchOrganization",
	"switchWorktree",
	"taskSyncEnabled",
	"telemetrySetting",
	"toggleApiConfigPin",
	"toggleDocumentMarkdownWorkspace",
	"toggleMcpServer",
	"toggleToolAlwaysAllow",
	"toggleToolEnabledForPrompt",
	"toggleWorkspaceIndexing",
	"ttsEnabled",
	"ttsSpeed",
	"updateCustomMode",
	"updateMcpTimeout",
	"updatePrompt",
	"updateSettings",
	"updateSkillModes",
	"updateVSCodeSetting",
	"upsertApiConfiguration",
])

export function serveBridgeBlocksSettingsWebviewMessage(messageType: string): boolean {
	if (!isRooServeBridge()) {
		return false
	}

	return SERVE_BRIDGE_BLOCKED_SETTINGS_WEBVIEW_MESSAGE_TYPES.has(messageType)
}

export function serveBridgeSettingsReadOnlyMessage(): string {
	return t("tools:serve.settingsReadOnly")
}

/**
 * Under `roo serve` (`ROO_SERVE_BRIDGE=1`), returns an error message when {@link userPath}
 * cannot refer to any path inside the workspace union; otherwise `null`.
 *
 * - **Absolute** `userPath`: normalized and checked against all `vscode.workspace.workspaceFolders`.
 * - **Relative** `userPath`: resolved against **each** workspace root (VS Code multi-root parity);
 *   allowed if at least one candidate lies inside some folder. When there are no workspace folders,
 *   falls back to {@link cwd} (typically `Task.cwd`, first root).
 */
export function serveBridgeOutsideWorkspaceReadRejectMessage(cwd: string, userPath: string): string | null {
	if (!isRooServeBridge()) {
		return null
	}

	const trimmed = userPath.trim()
	if (!trimmed) {
		return null
	}

	if (path.isAbsolute(trimmed)) {
		const absolutePath = path.normalize(path.resolve(trimmed))
		if (isPathOutsideWorkspace(absolutePath)) {
			return `Access denied in serve: path "${userPath}" resolves outside the workspace.`
		}
		return null
	}

	const roots =
		vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
			? vscode.workspace.workspaceFolders.map((f) => f.uri.fsPath)
			: [cwd]

	for (const root of roots) {
		const candidate = path.normalize(path.resolve(root, trimmed))
		if (!isPathOutsideWorkspace(candidate)) {
			return null
		}
	}

	const rootsHint =
		roots.length > 1
			? " (checked relative to each workspace folder; use an absolute path to target a specific root if needed)"
			: ""

	return `Access denied in serve: path "${userPath}" resolves outside the workspace.${rootsHint}`
}

/**
 * Under `roo serve`, returns a localized reason when {@link toolName} belongs to the
 * `edit` or `command` {@link TOOL_GROUPS} entries; otherwise `null`.
 */
export function serveBridgeEditCommandToolRejectMessage(toolName: string): string | null {
	if (!isRooServeBridge()) {
		return null
	}

	if (!isToolMemberOfToolGroups(toolName, ["edit", "command"])) {
		return null
	}

	return t("tools:serve.disabledToolReason", { toolName })
}

/** Localized chat line for a blocked edit/command tool (used with `Task.say("text", …)`). */
export function serveBridgeBlockedEditCommandChatLine(toolName: string, summary: string): string {
	const reason = t("tools:serve.disabledToolReason", { toolName })
	return t("tools:serve.blockedToolChatLine", { toolName, summary, reason })
}
