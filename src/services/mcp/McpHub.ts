import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InMemoryFileCoolServer } from "./InMemoryMcpServer.js"
import ReconnectingEventSource from "reconnecting-eventsource"
import {
	CallToolResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import axios from "axios"
import chokidar, { FSWatcher } from "chokidar"
import delay from "delay"
import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { z } from "zod"
import { t } from "../../i18n"

import { ClineProvider } from "../../core/webview/ClineProvider"
import { GlobalFileNames } from "../../shared/globalFileNames"
import {
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpServer,
	McpTool,
	McpToolCallResponse,
} from "../../shared/mcp"
import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual } from "../../utils/path"
import { injectVariables } from "../../utils/config"

export type McpConnection = {
	server: McpServer
	client: Client
	transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
	inMemoryServer?: InMemoryFileCoolServer // For in-memory connections
}

// Base configuration schema for common settings
const BaseConfigSchema = z.object({
	disabled: z.boolean().optional(),
	timeout: z.number().min(1).max(3600).optional().default(600),
	alwaysAllow: z.array(z.string()).default([]),
	watchPaths: z.array(z.string()).optional(), // paths to watch for changes and restart server
	disabledTools: z.array(z.string()).default([]),
})

// Custom error messages for better user feedback
const typeErrorMessage = "Server type must be 'stdio', 'sse', or 'streamable-http'"
const stdioFieldsErrorMessage =
	"For 'stdio' type servers, you must provide a 'command' field and can optionally include 'args' and 'env'"
const sseFieldsErrorMessage =
	"For 'sse' type servers, you must provide a 'url' field and can optionally include 'headers'"
const streamableHttpFieldsErrorMessage =
	"For 'streamable-http' type servers, you must provide a 'url' field and can optionally include 'headers'"
const mixedFieldsErrorMessage =
	"Cannot mix 'stdio' and ('sse' or 'streamable-http') fields. For 'stdio' use 'command', 'args', and 'env'. For 'sse'/'streamable-http' use 'url' and 'headers'"
const missingFieldsErrorMessage =
	"Server configuration must include either 'command' (for stdio) or 'url' (for sse/streamable-http) and a corresponding 'type' if 'url' is used."

// Helper function to create a refined schema with better error messages
const createServerTypeSchema = () => {
	return z.union([
		// Stdio config (has command field)
		BaseConfigSchema.extend({
			type: z.enum(["stdio"]).optional(),
			command: z.string().min(1, "Command cannot be empty"),
			args: z.array(z.string()).optional(),
			cwd: z.string().default(() => vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? process.cwd()),
			env: z.record(z.string()).optional(),
			// Ensure no SSE fields are present
			url: z.undefined().optional(),
			headers: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "stdio" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "stdio", { message: typeErrorMessage }),
		// SSE config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["sse"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "sse" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "sse", { message: typeErrorMessage }),
		// StreamableHTTP config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["streamable-http"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "streamable-http" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "streamable-http", {
				message: typeErrorMessage,
			}),
	])
}

// Server configuration schema with automatic type inference and validation
export const ServerConfigSchema = createServerTypeSchema()

// Settings schema
const McpSettingsSchema = z.object({
	mcpServers: z.record(ServerConfigSchema),
})

export class McpHub {
	private providerRef: WeakRef<ClineProvider>
	private disposables: vscode.Disposable[] = []
	private settingsWatcher?: vscode.FileSystemWatcher
	private fileWatchers: Map<string, FSWatcher[]> = new Map()
	private projectMcpWatcher?: vscode.FileSystemWatcher
	private isDisposed: boolean = false
	connections: McpConnection[] = []
	isConnecting: boolean = false
	private refCount: number = 0 // Reference counter for active clients
	private configChangeDebounceTimers: Map<string, NodeJS.Timeout> = new Map()
	// Store memory server tool states to persist across refreshes
	private memoryServerToolStates: Map<string, { alwaysAllow: string[], disabledTools: string[] }> = new Map()
	// Store memory server enable/disable states to persist across refreshes
	private memoryServerDisabledStates: Map<string, boolean> = new Map()

	constructor(provider: ClineProvider) {
		this.providerRef = new WeakRef(provider)
		this.watchMcpSettingsFile()
		this.watchProjectMcpFile().catch(console.error)
		this.setupWorkspaceFoldersWatcher()
		// Load saved memory server tool states
		this.loadMemoryServerToolStates().catch(console.error)
		// Load saved memory server disabled states
		this.loadMemoryServerDisabledStates().catch(console.error)
		this.initializeGlobalMcpServers()
		this.initializeProjectMcpServers()
		this.initializeInMemoryFileCoolServer().catch(console.error)
	}
	/**
	 * Save memory server tool states before refresh
	 */
	private async saveMemoryServerToolStates(): Promise<void> {
		const memoryConnections = this.connections.filter(conn => conn.server.source === "memory")
		for (const conn of memoryConnections) {
			const alwaysAllow: string[] = []
			const disabledTools: string[] = []

			if (conn.server.tools) {
				for (const tool of conn.server.tools) {
					if (tool.alwaysAllow) {
						alwaysAllow.push(tool.name)
					}
					if (!tool.enabledForPrompt) {
						disabledTools.push(tool.name)
					}
				}
			}

			this.memoryServerToolStates.set(conn.server.name, { alwaysAllow, disabledTools })

			// Also save the server's disabled state
			this.memoryServerDisabledStates.set(conn.server.name, conn.server.disabled || false)
		}

		// Persist to plugin state
		await this.persistMemoryServerToolStates()
		await this.persistMemoryServerDisabledStates()
	}

	/**
	 * Persist memory server tool states to plugin storage
	 */
	private async persistMemoryServerToolStates(): Promise<void> {
		const provider = this.providerRef.deref()
		if (provider) {
			const stateObject = Object.fromEntries(this.memoryServerToolStates)
			// Use VSCode's globalState directly for custom data
			await provider.context.globalState.update("mcpMemoryServerToolStates", stateObject)
		}
	}

	/**
	 * Load memory server tool states from plugin storage
	 */
	private async loadMemoryServerToolStates(): Promise<void> {
		const provider = this.providerRef.deref()
		if (provider) {
			const stateObject = provider.context.globalState.get("mcpMemoryServerToolStates") as Record<string, { alwaysAllow: string[], disabledTools: string[] }> | undefined
			if (stateObject) {
				this.memoryServerToolStates = new Map(Object.entries(stateObject))
			}
		}
	}

	/**
	 * Load memory server disabled states from plugin storage
	 */
	private async loadMemoryServerDisabledStates(): Promise<void> {
		const provider = this.providerRef.deref()
		if (provider) {
			const stateObject = provider.context.globalState.get("mcpMemoryServerDisabledStates") as Record<string, boolean> | undefined
			if (stateObject) {
				this.memoryServerDisabledStates = new Map(Object.entries(stateObject))
			}
		}
	}

	/**
	 * Persist memory server disabled states to plugin storage
	 */
	private async persistMemoryServerDisabledStates(): Promise<void> {
		const provider = this.providerRef.deref()
		if (provider) {
			const stateObject = Object.fromEntries(this.memoryServerDisabledStates)
			await provider.context.globalState.update("mcpMemoryServerDisabledStates", stateObject)
		}
	}

	/**
	 * Restore memory server tool states after refresh
	 */
	private restoreMemoryServerToolStates(): void {
		const memoryConnections = this.connections.filter(conn => conn.server.source === "memory")
		for (const conn of memoryConnections) {
			const savedState = this.memoryServerToolStates.get(conn.server.name)
			if (savedState && conn.server.tools) {
				for (const tool of conn.server.tools) {
					tool.alwaysAllow = savedState.alwaysAllow.includes(tool.name)
					tool.enabledForPrompt = !savedState.disabledTools.includes(tool.name)
				}
			}
		}
	}

	/**
	 * Registers a client (e.g., ClineProvider) using this hub.
	 * Increments the reference count.
	 */
	public registerClient(): void {
		this.refCount++
		console.log(`McpHub: Client registered. Ref count: ${this.refCount}`)
	}

	/**
	 * Unregisters a client. Decrements the reference count.
	 * If the count reaches zero, disposes the hub.
	 */
	public async unregisterClient(): Promise<void> {
		this.refCount--
		console.log(`McpHub: Client unregistered. Ref count: ${this.refCount}`)
		if (this.refCount <= 0) {
			console.log("McpHub: Last client unregistered. Disposing hub.")
			await this.dispose()
		}
	}

	/**
	 * Validates and normalizes server configuration
	 * @param config The server configuration to validate
	 * @param serverName Optional server name for error messages
	 * @returns The validated configuration
	 * @throws Error if the configuration is invalid
	 */
	private validateServerConfig(config: any, serverName?: string): z.infer<typeof ServerConfigSchema> {
		// Detect configuration issues before validation
		const hasStdioFields = config.command !== undefined
		const hasUrlFields = config.url !== undefined // Covers sse and streamable-http

		// Check for mixed fields (stdio vs url-based)
		if (hasStdioFields && hasUrlFields) {
			throw new Error(mixedFieldsErrorMessage)
		}

		// Infer type for stdio if not provided
		if (!config.type && hasStdioFields) {
			config.type = "stdio"
		}

		// For url-based configs, type must be provided by the user
		if (hasUrlFields && !config.type) {
			throw new Error("Configuration with 'url' must explicitly specify 'type' as 'sse' or 'streamable-http'.")
		}

		// Validate type if provided
		if (config.type && !["stdio", "sse", "streamable-http"].includes(config.type)) {
			throw new Error(typeErrorMessage)
		}

		// Check for type/field mismatch
		if (config.type === "stdio" && !hasStdioFields) {
			throw new Error(stdioFieldsErrorMessage)
		}
		if (config.type === "sse" && !hasUrlFields) {
			throw new Error(sseFieldsErrorMessage)
		}
		if (config.type === "streamable-http" && !hasUrlFields) {
			throw new Error(streamableHttpFieldsErrorMessage)
		}

		// If neither command nor url is present (type alone is not enough)
		if (!hasStdioFields && !hasUrlFields) {
			throw new Error(missingFieldsErrorMessage)
		}

		// Validate the config against the schema
		try {
			return ServerConfigSchema.parse(config)
		} catch (validationError) {
			if (validationError instanceof z.ZodError) {
				// Extract and format validation errors
				const errorMessages = validationError.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("; ")
				throw new Error(
					serverName
						? `Invalid configuration for server "${serverName}": ${errorMessages}`
						: `Invalid server configuration: ${errorMessages}`,
				)
			}
			throw validationError
		}
	}

	/**
	 * Formats and displays error messages to the user
	 * @param message The error message prefix
	 * @param error The error object
	 */
	private showErrorMessage(message: string, error: unknown): void {
		console.error(`${message}:`, error)
	}

	public setupWorkspaceFoldersWatcher(): void {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(async () => {
				await this.updateProjectMcpServers()
				await this.watchProjectMcpFile()
			}),
		)
	}

	/**
	 * Debounced wrapper for handling config file changes
	 */
	private debounceConfigChange(filePath: string, source: "global" | "project"): void {
		const key = `${source}-${filePath}`

		// Clear existing timer if any
		const existingTimer = this.configChangeDebounceTimers.get(key)
		if (existingTimer) {
			clearTimeout(existingTimer)
		}

		// Set new timer
		const timer = setTimeout(async () => {
			this.configChangeDebounceTimers.delete(key)
			await this.handleConfigFileChange(filePath, source)
		}, 500) // 500ms debounce

		this.configChangeDebounceTimers.set(key, timer)
	}

	private async handleConfigFileChange(filePath: string, source: "global" | "project"): Promise<void> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			const result = McpSettingsSchema.safeParse(config)

			if (!result.success) {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))
				return
			}

			await this.updateServerConnections(result.data.mcpServers || {}, source)
		} catch (error) {
			// Check if the error is because the file doesn't exist
			if (error.code === "ENOENT" && source === "project") {
				// File was deleted, clean up project MCP servers
				await this.cleanupProjectMcpServers()
				await this.notifyWebviewOfServerChanges()
				vscode.window.showInformationMessage(t("mcp:info.project_config_deleted"))
			} else {
				this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
			}
		}
	}

	private async watchProjectMcpFile(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		// Clean up existing project MCP watcher if it exists
		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			return
		}

		const workspaceFolder = vscode.workspace.workspaceFolders[0]
		const projectMcpPattern = new vscode.RelativePattern(workspaceFolder, ".roo/mcp.json")

		// Create a file system watcher for the project MCP file pattern
		this.projectMcpWatcher = vscode.workspace.createFileSystemWatcher(projectMcpPattern)

		// Watch for file changes
		const changeDisposable = this.projectMcpWatcher.onDidChange((uri) => {
			this.debounceConfigChange(uri.fsPath, "project")
		})

		// Watch for file creation
		const createDisposable = this.projectMcpWatcher.onDidCreate((uri) => {
			this.debounceConfigChange(uri.fsPath, "project")
		})

		// Watch for file deletion
		const deleteDisposable = this.projectMcpWatcher.onDidDelete(async () => {
			// Clean up all project MCP servers when the file is deleted
			await this.cleanupProjectMcpServers()
			await this.notifyWebviewOfServerChanges()
			vscode.window.showInformationMessage(t("mcp:info.project_config_deleted"))
		})

		this.disposables.push(
			vscode.Disposable.from(changeDisposable, createDisposable, deleteDisposable, this.projectMcpWatcher),
		)
	}

	private async updateProjectMcpServers(): Promise<void> {
		try {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) return

			const content = await fs.readFile(projectMcpPath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			// Validate configuration structure
			const result = McpSettingsSchema.safeParse(config)
			if (result.success) {
				await this.updateServerConnections(result.data.mcpServers || {}, "project")
			} else {
				// Format validation errors for better user feedback
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				console.error("Invalid project MCP settings format:", errorMessages)
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))
			}
		} catch (error) {
			this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
		}
	}

	private async cleanupProjectMcpServers(): Promise<void> {
		// Disconnect and remove all project MCP servers
		const projectConnections = this.connections.filter((conn) => conn.server.source === "project")

		for (const conn of projectConnections) {
			await this.deleteConnection(conn.server.name, "project")
		}

		// Clear project servers from the connections list
		await this.updateServerConnections({}, "project", false)
	}

	getServers(): McpServer[] {
		// Only return enabled servers
		return this.connections.filter((conn) => !conn.server.disabled).map((conn) => conn.server)
	}

	getAllServers(): McpServer[] {
		// Return all servers regardless of state
		return this.connections.map((conn) => conn.server)
	}

	async getMcpServersPath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpServersPath = await provider.ensureMcpServersDirectoryExists()
		return mcpServersPath
	}

	async getMcpSettingsFilePath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpSettingsFilePath = path.join(
			await provider.ensureSettingsDirectoryExists(),
			GlobalFileNames.mcpSettings,
		)
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {
		
  	}
}`,
			)
		}
		return mcpSettingsFilePath
	}

	private async watchMcpSettingsFile(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		// Clean up existing settings watcher if it exists
		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}

		const settingsPath = await this.getMcpSettingsFilePath()
		const settingsPattern = new vscode.RelativePattern(path.dirname(settingsPath), path.basename(settingsPath))

		// Create a file system watcher for the global MCP settings file
		this.settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPattern)

		// Watch for file changes
		const changeDisposable = this.settingsWatcher.onDidChange((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounceConfigChange(settingsPath, "global")
			}
		})

		// Watch for file creation
		const createDisposable = this.settingsWatcher.onDidCreate((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounceConfigChange(settingsPath, "global")
			}
		})

		this.disposables.push(vscode.Disposable.from(changeDisposable, createDisposable, this.settingsWatcher))
	}

	private async initializeMcpServers(source: "global" | "project"): Promise<void> {
		try {
			const configPath =
				source === "global" ? await this.getMcpSettingsFilePath() : await this.getProjectMcpPath()

			if (!configPath) {
				return
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)
			const result = McpSettingsSchema.safeParse(config)

			if (result.success) {
				await this.updateServerConnections(result.data.mcpServers || {}, source, false)
			} else {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				console.error(`Invalid ${source} MCP settings format:`, errorMessages)
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))

				if (source === "global") {
					// Still try to connect with the raw config, but show warnings
					try {
						await this.updateServerConnections(config.mcpServers || {}, source, false)
					} catch (error) {
						this.showErrorMessage(`Failed to initialize ${source} MCP servers with raw config`, error)
					}
				}
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, error)
				vscode.window.showErrorMessage(errorMessage)
			} else {
				this.showErrorMessage(`Failed to initialize ${source} MCP servers`, error)
			}
		}
	}

	private async initializeGlobalMcpServers(): Promise<void> {
		await this.initializeMcpServers("global")
	}

	// Get project-level MCP configuration path
	private async getProjectMcpPath(): Promise<string | null> {
		if (!vscode.workspace.workspaceFolders?.length) {
			return null
		}

		const workspaceFolder = vscode.workspace.workspaceFolders[0]
		const projectMcpDir = path.join(workspaceFolder.uri.fsPath, ".roo")
		const projectMcpPath = path.join(projectMcpDir, "mcp.json")

		try {
			await fs.access(projectMcpPath)
			return projectMcpPath
		} catch {
			return null
		}
	}

	// Initialize project-level MCP servers
	private async initializeProjectMcpServers(): Promise<void> {
		await this.initializeMcpServers("project")
	}

	// Initialize in-memory file-cool server
	private async initializeInMemoryFileCoolServer(): Promise<void> {
		try {
			console.log("Initializing in-memory file-cool server...")

			// Get configuration from GlobalSettings
			const provider = this.providerRef.deref()
			let config: { apiUrl?: string; apiKey?: string } | undefined = undefined
			if (provider) {
				const { mcpGatewayEnabled, mcpGatewayUrl, mcpGatewayApiKey } = await provider.getState()

				// Only initialize if MCP Gateway is enabled
				if (!mcpGatewayEnabled) {
					console.log("MCP Gateway is disabled. Skipping file-cool server initialization.")
					return
				}

				// Only pass config if both URL and API key are provided and not empty
				if (mcpGatewayUrl && mcpGatewayUrl.trim() && mcpGatewayApiKey && mcpGatewayApiKey.trim()) {
					config = {
						apiUrl: mcpGatewayUrl.trim(),
						apiKey: mcpGatewayApiKey.trim()
					}
					console.log("MCP Gateway configuration found, initializing file-cool server with custom settings")

					// Also initialize streamable-http gateway servers
					await this.initializeStreamableHttpGatewayServers(mcpGatewayUrl.trim(), mcpGatewayApiKey.trim())
				} else {
					console.log("MCP Gateway configuration not complete - URL or API Key missing. File-cool server will require configuration.")
				}
			}

			const inMemoryServer = new InMemoryFileCoolServer(config)
			const client = await inMemoryServer.connect()
			console.log("In-memory server connected successfully")

			// Check if there's a saved disabled state for file-cool server
			const savedDisabledState = this.memoryServerDisabledStates.get("file-cool") ?? false

			const connection: McpConnection = {
				server: {
					name: "file-cool",
					config: JSON.stringify({ type: "stdio", command: "in-memory" }), // Valid config for in-memory server
					status: "connected",
					disabled: savedDisabledState, // Apply saved disabled state
					source: "memory" as any, // Special source to avoid normal validation flows
					errorHistory: [],
					tools: [],
					resources: [],
					resourceTemplates: [],
				},
				client,
				transport: null as any, // Not used for in-memory connections
				inMemoryServer,
			}

			// Add connection first
			this.connections.push(connection)
			console.log("Connection added to connections list")

			// Add a small delay to ensure everything is ready
			await new Promise(resolve => setTimeout(resolve, 100))

			// Fetch tools and resources
			console.log("Fetching tools for in-memory server...")
			try {
				connection.server.tools = await this.fetchToolsList("file-cool", "memory")
				console.log("In-memory server tools fetched:", connection.server.tools.length)
			} catch (error) {
				console.error("Failed to fetch tools:", error)
			}

			try {
				connection.server.resources = await this.fetchResourcesList("file-cool", "memory")
				connection.server.resourceTemplates = await this.fetchResourceTemplatesList("file-cool", "memory")
			} catch (error) {
				console.error("Failed to fetch resources:", error)
			}

			await this.notifyWebviewOfServerChanges()

			console.log("In-memory file-cool server initialized successfully with", connection.server.tools?.length || 0, "tools")
		} catch (error) {
			console.error("Failed to initialize in-memory file-cool server:", error)
		}
	}

	// Initialize streamable-http gateway servers
	private async initializeStreamableHttpGatewayServers(gatewayUrl: string, apiKey: string): Promise<void> {
		try {
			console.log("Initializing streamable-http MCP gateway servers...")

			// Fetch server list from gateway URL
			const serverListUrl = gatewayUrl.endsWith('/') ? gatewayUrl + 'server-list' : gatewayUrl + '/server-list'
			console.log(`Fetching server list from: ${serverListUrl}`)

			const response = await axios.get(serverListUrl, {
				headers: {
					"API_KEY": apiKey
				},
				timeout: 10000 // 10 seconds timeout
			})

			if (!response.data || !Array.isArray(response.data)) {
				console.error("Invalid server list response format:", response.data)
				throw new Error("Invalid server list response format")
			}

			const serverList = response.data
			console.log(`Found ${serverList.length} servers to initialize:`, serverList.map((s: any) => s.name || s))

			// Loop through each server and initialize
			for (const serverInfo of serverList) {
				try {
					// Handle both string and object formats
					const serverName = typeof serverInfo === 'string' ? serverInfo : serverInfo.name
					const serverPath = typeof serverInfo === 'string' ? serverInfo : (serverInfo.path || serverInfo.name)

					if (!serverName) {
						console.warn("Skipping server with missing name:", serverInfo)
						continue
					}

					// Check if there's a saved disabled state for this server, default to true (disabled)
					const savedDisabledState = this.memoryServerDisabledStates.get(serverName) ?? true

					const serverConfig = {
						type: "streamable-http" as const,
						url: gatewayUrl.endsWith('/') ? gatewayUrl + serverPath : gatewayUrl + '/' + serverPath,
						headers: {
							"API_KEY": apiKey
						},
						disabled: savedDisabledState, // Apply saved disabled state or default to disabled
						timeout: 600,
						alwaysAllow: [],
						disabledTools: []
					}

					console.log(`Connecting to server: ${serverName} at ${serverConfig.url}`)
					await this.connectToServer(serverName, serverConfig, "memory")
					console.log(`Successfully connected to server: ${serverName}`)
				} catch (serverError) {
					console.error(`Failed to connect to server ${typeof serverInfo === 'string' ? serverInfo : serverInfo.name}:`, serverError)
					// Continue with other servers even if one fails
				}
			}

			console.log("Streamable-http MCP gateway servers initialization completed")
		} catch (error) {
			console.error("Failed to initialize streamable-http MCP gateway servers:", error)
		}
	}

	private async connectToServer(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" | "memory" = "global",
	): Promise<void> {
		// Remove existing connection if it exists with the same source
		await this.deleteConnection(name, source)

		try {
			const client = new Client(
				{
					name: "NeonTractor",
					version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: {},
				},
			)

			let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

			// Inject variables to the config (environment, magic variables,...)
			const configInjected = (await injectVariables(config, {
				env: process.env,
				workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
			})) as typeof config

			if (configInjected.type === "stdio") {
				// On Windows, wrap commands with cmd.exe to handle non-exe executables like npx.ps1
				// This is necessary for node version managers (fnm, nvm-windows, volta) that implement
				// commands as PowerShell scripts rather than executables.
				// Note: This adds a small overhead as commands go through an additional shell layer.
				const isWindows = process.platform === "win32"

				// Check if command is already cmd.exe to avoid double-wrapping
				const isAlreadyWrapped =
					configInjected.command.toLowerCase() === "cmd.exe" || configInjected.command.toLowerCase() === "cmd"

				const command = isWindows && !isAlreadyWrapped ? "cmd.exe" : configInjected.command
				const args =
					isWindows && !isAlreadyWrapped
						? ["/c", configInjected.command, ...(configInjected.args || [])]
						: configInjected.args

				transport = new StdioClientTransport({
					command,
					args,
					cwd: configInjected.cwd,
					env: {
						...getDefaultEnvironment(),
						...(configInjected.env || {}),
					},
					stderr: "pipe",
				})

				// Set up stdio specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}

				// transport.stderr is only available after the process has been started. However we can't start it separately from the .connect() call because it also starts the transport. And we can't place this after the connect call since we need to capture the stderr stream before the connection is established, in order to capture errors during the connection process.
				// As a workaround, we start the transport ourselves, and then monkey-patch the start method to no-op so that .connect() doesn't try to start it again.
				await transport.start()
				const stderrStream = transport.stderr
				if (stderrStream) {
					stderrStream.on("data", async (data: Buffer) => {
						const output = data.toString()
						// Check if output contains INFO level log
						const isInfoLog = /INFO/i.test(output)

						if (isInfoLog) {
							// Log normal informational messages
							console.log(`Server "${name}" info:`, output)
						} else {
							// Treat as error log
							console.error(`Server "${name}" stderr:`, output)
							const connection = this.findConnection(name, source)
							if (connection) {
								this.appendErrorMessage(connection, output)
								if (connection.server.status === "disconnected") {
									await this.notifyWebviewOfServerChanges()
								}
							}
						}
					})
				} else {
					console.error(`No stderr stream for ${name}`)
				}
			} else if (configInjected.type === "streamable-http") {
				// Streamable HTTP connection

				let headers = configInjected.headers || {}
				if (name === "NeonTractor") {
					const defaultProfile = await this.providerRef
						.deref()
						?.providerSettingsManager.getProfile({ name: "default" })
					headers.API_KEY = defaultProfile?.apiKey || ""
				}
				transport = new StreamableHTTPClientTransport(new URL(configInjected.url), {
					requestInit: {
						headers,
					},
				})

				// Set up Streamable HTTP specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}" (streamable-http):`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}
			} else if (configInjected.type === "sse") {
				// SSE connection
				const sseOptions = {
					requestInit: {
						headers: configInjected.headers,
					},
				}
				// Configure ReconnectingEventSource options
				const reconnectingEventSourceOptions = {
					max_retry_time: 5000, // Maximum retry time in milliseconds
					withCredentials: configInjected.headers?.["Authorization"] ? true : false, // Enable credentials if Authorization header exists
					fetch: (url: string | URL, init: RequestInit) => {
						const headers = new Headers({ ...(init?.headers || {}), ...(configInjected.headers || {}) })
						return fetch(url, {
							...init,
							headers,
						})
					},
				}
				global.EventSource = ReconnectingEventSource
				transport = new SSEClientTransport(new URL(configInjected.url), {
					...sseOptions,
					eventSourceInit: reconnectingEventSourceOptions,
				})

				// Set up SSE specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}
			} else {
				// Should not happen if validateServerConfig is correct
				throw new Error(`Unsupported MCP server type: ${(configInjected as any).type}`)
			}

			// Only override transport.start for stdio transports that have already been started
			if (configInjected.type === "stdio") {
				transport.start = async () => {}
			}

			const connection: McpConnection = {
				server: {
					name,
					config: JSON.stringify(configInjected),
					status: "connecting",
					disabled: configInjected.disabled,
					source,
					projectPath: source === "project" ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,
					errorHistory: [],
				},
				client,
				transport,
			}
			this.connections.push(connection)

			// Connect (this will automatically start the transport)
			await client.connect(transport)
			connection.server.status = "connected"
			connection.server.error = ""
			connection.server.instructions = client.getInstructions()

			// Initial fetch of tools and resources
			connection.server.tools = await this.fetchToolsList(name, source)
			connection.server.resources = await this.fetchResourcesList(name, source)
			connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name, source)
		} catch (error) {
			// Update status with error
			const connection = this.findConnection(name, source)
			if (connection) {
				connection.server.status = "disconnected"
				this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
			}
			throw error
		}
	}

	private appendErrorMessage(connection: McpConnection, error: string, level: "error" | "warn" | "info" = "error") {
		const MAX_ERROR_LENGTH = 1000
		const truncatedError =
			error.length > MAX_ERROR_LENGTH
				? `${error.substring(0, MAX_ERROR_LENGTH)}...(error message truncated)`
				: error

		// Add to error history
		if (!connection.server.errorHistory) {
			connection.server.errorHistory = []
		}

		connection.server.errorHistory.push({
			message: truncatedError,
			timestamp: Date.now(),
			level,
		})

		// Keep only the last 100 errors
		if (connection.server.errorHistory.length > 100) {
			connection.server.errorHistory = connection.server.errorHistory.slice(-100)
		}

		// Update current error display
		connection.server.error = truncatedError
	}

	/**
	 * Helper method to find a connection by server name and source
	 * @param serverName The name of the server to find
	 * @param source Optional source to filter by (global or project)
	 * @returns The matching connection or undefined if not found
	 */
	private findConnection(serverName: string, source?: "global" | "project" | "memory"): McpConnection | undefined {
		// If source is specified, only find servers with that source
		if (source !== undefined) {
			return this.connections.find((conn) => conn.server.name === serverName && conn.server.source === source)
		}

		// If no source is specified, search in priority order: project > global > memory
		// This ensures that when servers have the same name, project servers are prioritized
		const projectConn = this.connections.find(
			(conn) => conn.server.name === serverName && conn.server.source === "project",
		)
		if (projectConn) return projectConn

		// If no project server is found, look for global servers
		const globalConn = this.connections.find(
			(conn) => conn.server.name === serverName && (conn.server.source === "global" || !conn.server.source),
		)
		if (globalConn) return globalConn

		// Finally, look for memory servers
		return this.connections.find(
			(conn) => conn.server.name === serverName && conn.server.source === "memory",
		)
	}

	private async fetchToolsList(serverName: string, source?: "global" | "project" | "memory"): Promise<McpTool[]> {
		try {
			// Use the helper method to find the connection
			const connection = this.findConnection(serverName, source)

			if (!connection) {
				console.error(`Server ${serverName} with source ${source} not found`)
				throw new Error(`Server ${serverName} not found`)
			}

			console.log(`Fetching tools for ${serverName} (source: ${source})...`)

			const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema)

			// Determine the actual source of the server
			const actualSource = connection.server.source || "global"
			let configPath: string
			let alwaysAllowConfig: string[] = []
			let disabledToolsList: string[] = []

			// Skip config file reading for memory servers
			if (actualSource !== "memory") {
				// Read from the appropriate config file based on the actual source
				try {
					let serverConfigData: Record<string, any> = {}
				if (actualSource === "project") {
						// Get project MCP config path
						const projectMcpPath = await this.getProjectMcpPath()
						if (projectMcpPath) {
							configPath = projectMcpPath
							const content = await fs.readFile(configPath, "utf-8")
							serverConfigData = JSON.parse(content)
							}
					} else {
						// Get global MCP settings path
						configPath = await this.getMcpSettingsFilePath()
						const content = await fs.readFile(configPath, "utf-8")
						serverConfigData = JSON.parse(content)
					}
				if (serverConfigData) {
					alwaysAllowConfig = serverConfigData.mcpServers?.[serverName]?.alwaysAllow || []
						disabledToolsList = serverConfigData.mcpServers?.[serverName]?.disabledTools || []
				}
				} catch (error) {
					console.error(`Failed to read tool configuration for ${serverName}:`, error)
					// Continue with empty configs
				}
			} else {
				// For memory servers, try to restore from saved states first, then from existing tools
				const savedState = this.memoryServerToolStates.get(serverName)
				if (savedState) {
					alwaysAllowConfig = [...savedState.alwaysAllow]
					disabledToolsList = [...savedState.disabledTools]
				} else {
					// Fallback: preserve existing tool states if they exist
					const existingTools = connection.server.tools || []
					for (const existingTool of existingTools) {
						if (existingTool.alwaysAllow) {
							alwaysAllowConfig.push(existingTool.name)
						}
						if (!existingTool.enabledForPrompt) {
							disabledToolsList.push(existingTool.name)
						}
					}
				}
			}

			// Mark tools as always allowed and enabled for prompt based on settings
			const tools = (response?.tools || []).map((tool) => ({
				...tool,
				alwaysAllow: alwaysAllowConfig.includes(tool.name),
				enabledForPrompt: !disabledToolsList.includes(tool.name),
			}))

			return tools
		} catch (error) {
			console.error(`Failed to fetch tools for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourcesList(serverName: string, source?: "global" | "project" | "memory"): Promise<McpResource[]> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				return []
			}
			const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema)
			return response?.resources || []
		} catch (error) {
			// console.error(`Failed to fetch resources for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourceTemplatesList(
		serverName: string,
		source?: "global" | "project" | "memory",
	): Promise<McpResourceTemplate[]> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				return []
			}
			const response = await connection.client.request(
				{ method: "resources/templates/list" },
				ListResourceTemplatesResultSchema,
			)
			return response?.resourceTemplates || []
		} catch (error) {
			// console.error(`Failed to fetch resource templates for ${serverName}:`, error)
			return []
		}
	}

	async deleteConnection(name: string, source?: "global" | "project" | "memory"): Promise<void> {
		// If source is provided, only delete connections from that source
		const connections = source
			? this.connections.filter((conn) => conn.server.name === name && conn.server.source === source)
			: this.connections.filter((conn) => conn.server.name === name)

		for (const connection of connections) {
			try {
				// Handle in-memory servers
				if (connection.inMemoryServer) {
					await connection.inMemoryServer.disconnect()
				} else {
					await connection.transport.close()
					await connection.client.close()
				}
			} catch (error) {
				console.error(`Failed to close transport for ${name}:`, error)
			}
		}

		// Remove the connections from the array
		this.connections = this.connections.filter((conn) => {
			if (conn.server.name !== name) return true
			if (source && conn.server.source !== source) return true
			return false
		})
	}

	async updateServerConnections(
		newServers: Record<string, any>,
		source: "global" | "project" | "memory" = "global",
		manageConnectingState: boolean = true,
	): Promise<void> {
		if (manageConnectingState) {
			this.isConnecting = true
		}
		this.removeAllFileWatchers()
		// Filter connections by source, excluding in-memory servers
		const currentConnections = this.connections.filter(
			(conn) =>
				conn.server.source !== "memory" && // Exclude in-memory servers
				(conn.server.source === source || (!conn.server.source && source === "global")),
		)
		const currentNames = new Set(currentConnections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		// Delete removed servers
		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name, source)
			}
		}

		// Update or add servers
		for (const [name, config] of Object.entries(newServers)) {
			// Only consider connections that match the current source
			const currentConnection = this.findConnection(name, source)

			// Validate and transform the config
			let validatedConfig: z.infer<typeof ServerConfigSchema>
			try {
				validatedConfig = this.validateServerConfig(config, name)
			} catch (error) {
				this.showErrorMessage(`Invalid configuration for MCP server "${name}"`, error)
				continue
			}

			if (!currentConnection) {
				// New server
				try {
					this.setupFileWatcher(name, validatedConfig, source)
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to connect to new MCP server ${name}`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					this.setupFileWatcher(name, validatedConfig, source)
					await this.deleteConnection(name, source)
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to reconnect MCP server ${name}`, error)
				}
			}
			// If server exists with same config, do nothing
		}
		await this.notifyWebviewOfServerChanges()
		if (manageConnectingState) {
			this.isConnecting = false
		}
	}

	private setupFileWatcher(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" | "memory" = "global",
	) {
		// Skip file watchers for memory servers
		if (source === "memory") {
			return
		}

		// Initialize an empty array for this server if it doesn't exist
		if (!this.fileWatchers.has(name)) {
			this.fileWatchers.set(name, [])
		}

		const watchers = this.fileWatchers.get(name) || []

		// Only stdio type has args
		if (config.type === "stdio") {
			// Setup watchers for custom watchPaths if defined
			if (config.watchPaths && config.watchPaths.length > 0) {
				const watchPathsWatcher = chokidar.watch(config.watchPaths, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true,
				})

				watchPathsWatcher.on("change", async (changedPath) => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						console.error(`Failed to restart server ${name} after change in ${changedPath}:`, error)
					}
				})

				watchers.push(watchPathsWatcher)
			}

			// Also setup the fallback build/index.js watcher if applicable
			const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
			if (filePath) {
				// we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor
				const indexJsWatcher = chokidar.watch(filePath, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true, // This helps with atomic writes
				})

				indexJsWatcher.on("change", async () => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						console.error(`Failed to restart server ${name} after change in ${filePath}:`, error)
					}
				})

				watchers.push(indexJsWatcher)
			}

			// Update the fileWatchers map with all watchers for this server
			if (watchers.length > 0) {
				this.fileWatchers.set(name, watchers)
			}
		}
	}

	private removeAllFileWatchers() {
		this.fileWatchers.forEach((watchers) => watchers.forEach((watcher) => watcher.close()))
		this.fileWatchers.clear()
	}

	async restartConnection(serverName: string, source?: "global" | "project" | "memory"): Promise<void> {
		// Skip restart for memory servers
		if (source === "memory") {
			return
		}

		this.isConnecting = true
		const provider = this.providerRef.deref()
		if (!provider) {
			return
		}

		// Get existing connection and update its status
		const connection = this.findConnection(serverName, source)
		const config = connection?.server.config
		if (config) {
			vscode.window.showInformationMessage(t("mcp:info.server_restarting", { serverName }))
			connection.server.status = "connecting"
			connection.server.error = ""
			await this.notifyWebviewOfServerChanges()
			await delay(500) // artificial delay to show user that server is restarting
			try {
				await this.deleteConnection(serverName, connection.server.source)
				// Parse the config to validate it
				const parsedConfig = JSON.parse(config)
				try {
					// Validate the config
					const validatedConfig = this.validateServerConfig(parsedConfig, serverName)

					// Try to connect again using validated config
					await this.connectToServer(serverName, validatedConfig, connection.server.source || "global")
					vscode.window.showInformationMessage(t("mcp:info.server_connected", { serverName }))
				} catch (validationError) {
					this.showErrorMessage(`Invalid configuration for MCP server "${serverName}"`, validationError)
				}
			} catch (error) {
				this.showErrorMessage(`Failed to restart ${serverName} MCP server connection`, error)
			}
		}

		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	public async refreshInMemoryServers(): Promise<void> {
		try {
			// Save current memory server tool states before refresh
			this.saveMemoryServerToolStates()

			// Find and remove existing in-memory connections
			const inMemoryConnections = this.connections.filter(conn => conn.server.source === "memory")
			for (const conn of inMemoryConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Re-initialize in-memory servers with new configuration
			await this.initializeInMemoryFileCoolServer()

			// Restore tool states after re-initialization
			this.restoreMemoryServerToolStates()

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			console.error("Error refreshing in-memory servers:", error)
		}
	}

	public async refreshAllConnections(): Promise<void> {
		if (this.isConnecting) {
			vscode.window.showInformationMessage(t("mcp:info.already_refreshing"))
			return
		}

		this.isConnecting = true
		vscode.window.showInformationMessage(t("mcp:info.refreshing_all"))

		try {
			// Save current memory server tool states before refresh
			this.saveMemoryServerToolStates()

			const globalPath = await this.getMcpSettingsFilePath()
			let globalServers: Record<string, any> = {}
			try {
				const globalContent = await fs.readFile(globalPath, "utf-8")
				const globalConfig = JSON.parse(globalContent)
				globalServers = globalConfig.mcpServers || {}
				const globalServerNames = Object.keys(globalServers)
				vscode.window.showInformationMessage(
					t("mcp:info.global_servers_active", {
						mcpServers: `${globalServerNames.join(", ") || "none"}`,
					}),
				)
			} catch (error) {
				console.log("Error reading global MCP config:", error)
			}

			const projectPath = await this.getProjectMcpPath()
			let projectServers: Record<string, any> = {}
			if (projectPath) {
				try {
					const projectContent = await fs.readFile(projectPath, "utf-8")
					const projectConfig = JSON.parse(projectContent)
					projectServers = projectConfig.mcpServers || {}
					const projectServerNames = Object.keys(projectServers)
					vscode.window.showInformationMessage(
						t("mcp:info.project_servers_active", {
							mcpServers: `${projectServerNames.join(", ") || "none"}`,
						}),
					)
				} catch (error) {
					console.log("Error reading project MCP config:", error)
				}
			}

			// Clear all existing connections first
			const existingConnections = [...this.connections]
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Re-initialize all servers from scratch
			// This ensures proper initialization including fetching tools, resources, etc.
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			// Re-initialize in-memory servers
			await this.initializeInMemoryFileCoolServer()

			// Restore memory server tool states after re-initialization
			this.restoreMemoryServerToolStates()

			await delay(100)

			await this.notifyWebviewOfServerChanges()

			vscode.window.showInformationMessage(t("mcp:info.all_refreshed"))
		} catch (error) {
			this.showErrorMessage("Failed to refresh MCP servers", error)
		} finally {
			this.isConnecting = false
		}
	}

	/**
	 * Sort connections by priority: project > global > memory
	 * Within each source type, sort by configuration order, then alphabetically
	 */
	private sortConnectionsByPriority(globalOrder: string[], projectOrder: string[]): McpConnection[] {
		return [...this.connections].sort((a, b) => {
			const aSource = a.server.source || "global"
			const bSource = b.server.source || "global"

			// Define source priority: project (0) > global (1) > memory (2)
			const sourcePriority = { project: 0, global: 1, memory: 2 }
			const aPriority = sourcePriority[aSource as keyof typeof sourcePriority] ?? 1
			const bPriority = sourcePriority[bSource as keyof typeof sourcePriority] ?? 1

			// If different source types, sort by priority
			if (aPriority !== bPriority) {
				return aPriority - bPriority
			}

			// Same source type - sort by order within that source
			return this.compareServersByOrder(a.server.name, b.server.name, aSource, globalOrder, projectOrder)
		})
	}

	/**
	 * Compare two servers by their order within the same source type
	 */
	private compareServersByOrder(
		nameA: string,
		nameB: string,
		source: string,
		globalOrder: string[],
		projectOrder: string[]
	): number {
		const getOrderIndex = (name: string, order: string[]) => {
			const index = order.indexOf(name)
			return index === -1 ? Number.MAX_SAFE_INTEGER : index
		}

		let indexA: number, indexB: number

		if (source === "project") {
			indexA = getOrderIndex(nameA, projectOrder)
			indexB = getOrderIndex(nameB, projectOrder)
		} else if (source === "global") {
			indexA = getOrderIndex(nameA, globalOrder)
			indexB = getOrderIndex(nameB, globalOrder)
		} else {
			// Memory servers: sort alphabetically
			return nameA.localeCompare(nameB)
		}

		// If both have same order index (including both not found), sort alphabetically
		return indexA !== indexB ? indexA - indexB : nameA.localeCompare(nameB)
	}

	private async notifyWebviewOfServerChanges(): Promise<void> {
		// Get global server order from settings file
		const settingsPath = await this.getMcpSettingsFilePath()
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const globalServerOrder = Object.keys(config.mcpServers || {})

		// Get project server order if available
		const projectMcpPath = await this.getProjectMcpPath()
		let projectServerOrder: string[] = []
		if (projectMcpPath) {
			try {
				const projectContent = await fs.readFile(projectMcpPath, "utf-8")
				const projectConfig = JSON.parse(projectContent)
				projectServerOrder = Object.keys(projectConfig.mcpServers || {})
			} catch (error) {
				// Silently continue with empty project server order
			}
		}

		// Sort connections by priority and order
		const sortedConnections = this.sortConnectionsByPriority(globalServerOrder, projectServerOrder)

		// Send sorted servers to webview
		const targetProvider: ClineProvider | undefined = this.providerRef.deref()

		if (targetProvider) {
			const serversToSend = sortedConnections.map((connection) => connection.server)

			const message = {
				type: "mcpServers" as const,
				mcpServers: serversToSend,
			}

			try {
				await targetProvider.postMessageToWebview(message)
			} catch (error) {
				console.error("[McpHub] Error calling targetProvider.postMessageToWebview:", error)
			}
		} else {
			console.error(
				"[McpHub] No target provider available (neither from getInstance nor providerRef) - cannot send mcpServers message to webview",
			)
		}
	}

	public async toggleServerDisabled(
		serverName: string,
		disabled: boolean,
		source?: "global" | "project" | "memory",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"

			// For memory servers, update the in-memory state and persist to globalState
			if (serverSource === "memory") {
				connection.server.disabled = disabled
				// Save the disabled state to globalState for persistence
				this.memoryServerDisabledStates.set(serverName, disabled)
				await this.persistMemoryServerDisabledStates()
				await this.notifyWebviewOfServerChanges()
				return
			}

			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { disabled }, serverSource)

			// Update the connection object
			if (connection) {
				try {
					connection.server.disabled = disabled

					// Only refresh capabilities if connected
					if (connection.server.status === "connected") {
						connection.server.tools = await this.fetchToolsList(serverName, serverSource)
						connection.server.resources = await this.fetchResourcesList(serverName, serverSource)
						connection.server.resourceTemplates = await this.fetchResourceTemplatesList(
							serverName,
							serverSource,
						)
					}
				} catch (error) {
					console.error(`Failed to refresh capabilities for ${serverName}:`, error)
				}
			}

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} state`, error)
			throw error
		}
	}

	/**
	 * Helper method to update a server's configuration in the appropriate settings file
	 * @param serverName The name of the server to update
	 * @param configUpdate The configuration updates to apply
	 * @param source Whether to update the global or project config
	 */
	private async updateServerConfig(
		serverName: string,
		configUpdate: Record<string, any>,
		source: "global" | "project" | "memory" = "global",
	): Promise<void> {
		// Skip config updates for memory servers
		if (source === "memory") {
			return
		}
		// Determine which config file to update
		let configPath: string
		if (source === "project") {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			configPath = await this.getMcpSettingsFilePath()
		}

		// Ensure the settings file exists and is accessible
		try {
			await fs.access(configPath)
		} catch (error) {
			console.error("Settings file not accessible:", error)
			throw new Error("Settings file not accessible")
		}

		// Read and parse the config file
		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content)

		// Validate the config structure
		if (!config || typeof config !== "object") {
			throw new Error("Invalid config structure")
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			config.mcpServers = {}
		}

		if (!config.mcpServers[serverName]) {
			config.mcpServers[serverName] = {}
		}

		// Create a new server config object to ensure clean structure
		const serverConfig = {
			...config.mcpServers[serverName],
			...configUpdate,
		}

		// Ensure required fields exist
		if (!serverConfig.alwaysAllow) {
			serverConfig.alwaysAllow = []
		}

		config.mcpServers[serverName] = serverConfig

		// Write the entire config back
		const updatedConfig = {
			mcpServers: config.mcpServers,
		}

		await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2))
	}

	public async updateServerTimeout(
		serverName: string,
		timeout: number,
		source?: "global" | "project" | "memory",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			// For memory servers, skip config file updates but still notify webview
			if (connection.server.source === "memory") {
				await this.notifyWebviewOfServerChanges()
				return
			}

			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { timeout }, connection.server.source || "global")

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} timeout settings`, error)
			throw error
		}
	}

	public async deleteServer(serverName: string, source?: "global" | "project" | "memory"): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"

			// For memory servers, just disconnect and remove from connections
			if (serverSource === "memory") {
				await this.deleteConnection(serverName, serverSource)
				await this.notifyWebviewOfServerChanges()
				return
			}

			// Determine config file based on server source
			const isProjectServer = serverSource === "project"
			let configPath: string

			if (isProjectServer) {
				// Get project MCP config path
				const projectMcpPath = await this.getProjectMcpPath()
				if (!projectMcpPath) {
					throw new Error("Project MCP configuration file not found")
				}
				configPath = projectMcpPath
			} else {
				// Get global MCP settings path
				configPath = await this.getMcpSettingsFilePath()
			}

			// Ensure the settings file exists and is accessible
			try {
				await fs.access(configPath)
			} catch (error) {
				throw new Error("Settings file not accessible")
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)

			// Validate the config structure
			if (!config || typeof config !== "object") {
				throw new Error("Invalid config structure")
			}

			if (!config.mcpServers || typeof config.mcpServers !== "object") {
				config.mcpServers = {}
			}

			// Remove the server from the settings
			if (config.mcpServers[serverName]) {
				delete config.mcpServers[serverName]

				// Write the entire config back
				const updatedConfig = {
					mcpServers: config.mcpServers,
				}

				await fs.writeFile(configPath, JSON.stringify(updatedConfig, null, 2))

				// Update server connections with the correct source
				await this.updateServerConnections(config.mcpServers, serverSource)

				vscode.window.showInformationMessage(t("mcp:info.server_deleted", { serverName }))
			} else {
				vscode.window.showWarningMessage(t("mcp:info.server_not_found", { serverName }))
			}
		} catch (error) {
			this.showErrorMessage(`Failed to delete MCP server ${serverName}`, error)
			throw error
		}
	}

	async readResource(serverName: string, uri: string, source?: "global" | "project" | "memory"): Promise<McpResourceResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection) {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		return await connection.client.request(
			{
				method: "resources/read",
				params: {
					uri,
				},
			},
			ReadResourceResultSchema,
		)
	}

	async callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, unknown>,
		source?: "global" | "project" | "memory",
	): Promise<McpToolCallResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection) {
			throw new Error(
				`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled and cannot be used`)
		}

		let timeout: number
		try {
			const parsedConfig = ServerConfigSchema.parse(JSON.parse(connection.server.config))
			timeout = (parsedConfig.timeout ?? 600) * 1000
		} catch (error) {
			console.error("Failed to parse server config for timeout:", error)
			// Default to 600 seconds if parsing fails
			timeout = 600 * 1000
		}

		return await connection.client.request(
			{
				method: "tools/call",
				params: {
					name: toolName,
					arguments: toolArguments,
				},
			},
			CallToolResultSchema,
			{
				timeout,
			},
		)
	}

	/**
	 * Helper method to update a specific tool list (alwaysAllow or disabledTools)
	 * in the appropriate settings file.
	 * @param serverName The name of the server to update
	 * @param source Whether to update the global or project config
	 * @param toolName The name of the tool to add or remove
	 * @param listName The name of the list to modify ("alwaysAllow" or "disabledTools")
	 * @param addTool Whether to add (true) or remove (false) the tool from the list
	 */
	private async updateServerToolList(
		serverName: string,
		source: "global" | "project" | "memory",
		toolName: string,
		listName: "alwaysAllow" | "disabledTools",
		addTool: boolean,
	): Promise<void> {
		// Skip config file updates for memory servers
		if (source === "memory") {
			// For memory servers, just update the in-memory tool configuration
			const connection = this.findConnection(serverName, source)
			if (connection) {
				// Find the tool and update its properties based on the list name
				const tool = connection.server.tools?.find(t => t.name === toolName)
				if (tool) {
					if (listName === "alwaysAllow") {
						tool.alwaysAllow = addTool
					} else if (listName === "disabledTools") {
						tool.enabledForPrompt = !addTool
					}
				}

				// Update the saved state for persistence across refreshes
				let savedState = this.memoryServerToolStates.get(serverName)
				if (!savedState) {
					savedState = { alwaysAllow: [], disabledTools: [] }
					this.memoryServerToolStates.set(serverName, savedState)
				}

				if (listName === "alwaysAllow") {
					if (addTool && !savedState.alwaysAllow.includes(toolName)) {
						savedState.alwaysAllow.push(toolName)
					} else if (!addTool) {
						const index = savedState.alwaysAllow.indexOf(toolName)
						if (index > -1) {
							savedState.alwaysAllow.splice(index, 1)
						}
					}
				} else if (listName === "disabledTools") {
					if (addTool && !savedState.disabledTools.includes(toolName)) {
						savedState.disabledTools.push(toolName)
					} else if (!addTool) {
						const index = savedState.disabledTools.indexOf(toolName)
						if (index > -1) {
							savedState.disabledTools.splice(index, 1)
						}
					}
				}

				// Persist the updated state
				await this.persistMemoryServerToolStates()
			}
			await this.notifyWebviewOfServerChanges()
			return
		}
		try {
			// Find the connection with matching name and source
			const connection = this.findConnection(serverName, source)

			if (!connection) {
				throw new Error(`Server ${serverName} with source ${source} not found`)
			}

			// Determine the correct config path based on the source
			let configPath: string
			if (source === "project") {
				// Get project MCP config path
				const projectMcpPath = await this.getProjectMcpPath()
				if (!projectMcpPath) {
					throw new Error("Project MCP configuration file not found")
				}
				configPath = projectMcpPath
			} else {
				// Get global MCP settings path
				configPath = await this.getMcpSettingsFilePath()
			}

			// Normalize path for cross-platform compatibility
			// Use a consistent path format for both reading and writing
			const normalizedPath = process.platform === "win32" ? configPath.replace(/\\/g, "/") : configPath

			// Read the appropriate config file
			const content = await fs.readFile(normalizedPath, "utf-8")
			const config = JSON.parse(content)

			if (!config.mcpServers) {
				config.mcpServers = {}
			}

			if (!config.mcpServers[serverName]) {
				config.mcpServers[serverName] = {
					type: "stdio",
					command: "node",
					args: [], // Default to an empty array; can be set later if needed
				}
			}

			if (!config.mcpServers[serverName][listName]) {
				config.mcpServers[serverName][listName] = []
			}

			const targetList = config.mcpServers[serverName][listName]
			const toolIndex = targetList.indexOf(toolName)

			if (addTool && toolIndex === -1) {
				targetList.push(toolName)
			} else if (!addTool && toolIndex !== -1) {
				targetList.splice(toolIndex, 1)
			}

			await fs.writeFile(normalizedPath, JSON.stringify(config, null, 2))

			if (connection) {
				connection.server.tools = await this.fetchToolsList(serverName, source)
				await this.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error(`Failed to update server tool list for ${serverName}:`, error)
			throw error
		}
	}

	async toggleToolAlwaysAllow(
		serverName: string,
		source: "global" | "project" | "memory",
		toolName: string,
		shouldAllow: boolean,
	): Promise<void> {
		try {
			await this.updateServerToolList(serverName, source, toolName, "alwaysAllow", shouldAllow)
		} catch (error) {
			this.showErrorMessage(
				`Failed to toggle always allow for tool "${toolName}" on server "${serverName}" with source "${source}"`,
				error,
			)
			throw error
		}
	}

	async toggleToolEnabledForPrompt(
		serverName: string,
		source: "global" | "project" | "memory",
		toolName: string,
		isEnabled: boolean,
	): Promise<void> {
		try {
			// When isEnabled is true, we want to remove the tool from the disabledTools list.
			// When isEnabled is false, we want to add the tool to the disabledTools list.
			const addToolToDisabledList = !isEnabled
			await this.updateServerToolList(serverName, source, toolName, "disabledTools", addToolToDisabledList)
		} catch (error) {
			this.showErrorMessage(`Failed to update settings for tool ${toolName}`, error)
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	async dispose(): Promise<void> {
		// Prevent multiple disposals
		if (this.isDisposed) {
			console.log("McpHub: Already disposed.")
			return
		}
		console.log("McpHub: Disposing...")
		this.isDisposed = true

		// Clear all debounce timers
		for (const timer of this.configChangeDebounceTimers.values()) {
			clearTimeout(timer)
		}
		this.configChangeDebounceTimers.clear()

		this.removeAllFileWatchers()
		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name, connection.server.source)
			} catch (error) {
				console.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}
		this.connections = []
		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}
		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}
		this.disposables.forEach((d) => d.dispose())
	}
}
