import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createInMemoryTransportPair, InMemoryTransport } from "./InMemoryTransport.js"
import { processFiles } from "../file-cool/client.js"
import { z } from "zod"
import axios from "axios"

interface FileCoolConfig {
	apiUrl?: string;
	apiKey?: string;
}

interface ToolInfo {
	name: string;
	description: string;
}

/**
 * In-memory MCP server that wraps file-cool functionality
 */
export class InMemoryFileCoolServer {
	private server: McpServer
	private client: Client | null = null
	private serverTransport: InMemoryTransport | null = null
	private clientTransport: InMemoryTransport | null = null
	private config: FileCoolConfig
	private ready: boolean = false
	private initializationPromise: Promise<void>

	constructor(config?: FileCoolConfig) {
		this.config = config || {};
		console.log(`InMemoryFileCoolServer initialized with config:`, {
			apiUrl: this.config.apiUrl || 'not configured',
			apiKey: this.config.apiKey ? '[REDACTED]' : 'not configured'
		});
		this.server = new McpServer({
			name: "file-cool",
			version: "1.0.0",
		})

		// 异步初始化服务器
		this.initializationPromise = this.initializeServer()
	}

	/**
	 * 异步初始化服务器
	 */
	private async initializeServer(): Promise<void> {
		try {
			await this.setupServer()
			this.ready = true
			console.log("InMemoryFileCoolServer setup completed successfully")
		} catch (error) {
			console.error("Failed to initialize InMemoryFileCoolServer:", error)
			this.ready = false
		}
	}

	private async setupServer(): Promise<void> {
		try {
			// 获取工具列表
			const tools = await this.fetchToolsList()

			// 统一的 inputSchema，所有工具都使用相同的结构
			const commonInputSchema = {
				inputFiles: z
					.array(z.string())
					.describe("Path to the files, absolute file path"),
			}

			// 动态注册工具
			for (const tool of tools) {
				this.server.registerTool(
					tool.name,
					{
						description: tool.description,
						inputSchema: commonInputSchema,
					},
					async ({ inputFiles }) => {
						try {
							const result = await processFiles(inputFiles, tool.name, this.config)
							return {
								content: [
									{
										type: "text",
										text: `${tool.name} result: ${result}`,
									},
								],
							}
						} catch (error: any) {
							// Provide more helpful error messages for configuration issues
							if (error.message.includes("MCP Gateway URL is required")) {
								throw new Error(`${tool.name} failed: MCP Gateway URL is not configured. Please set the Gateway URL in MCP settings.`)
							}
							if (error.message.includes("MCP Gateway API Key is required")) {
								throw new Error(`${tool.name} failed: MCP Gateway API Key is not configured. Please set the API Key in MCP settings.`)
							}
							throw new Error(`${tool.name} failed: ${error.message}`)
						}
					}
				)
			}
		} catch (error) {
			console.error("Failed to setup server with dynamic tools:", error)
		}
	}

	/**
	 * 从 API URL 获取工具列表
	 */
	private async fetchToolsList(): Promise<ToolInfo[]> {
		if (!this.config.apiUrl) {
			throw new Error("API URL is required to fetch tools list")
		}

		if (!this.config.apiKey) {
			throw new Error("API Key is required to fetch tools list")
		}

		try {
			const url = `${this.config.apiUrl}/file-cool/tools`
			const response = await axios.get(url, {
				headers: {
					"API_KEY": this.config.apiKey,
				},
				timeout: 10000, // 10秒超时
			})

			if (response.data && Array.isArray(response.data)) {
				return response.data.map((tool: any) => ({
					name: tool.name,
					description: tool.description || `Execute ${tool.name} function`,
				}))
			} else {
				throw new Error("Invalid response format from tools API")
			}
		} catch (error: any) {
			console.error("Failed to fetch tools list from API:", error)
			throw new Error(`Failed to fetch tools list: ${error.message}`)
		}
	}

	/**
	 * Start the in-memory server and return a connected client
	 */
	async connect(): Promise<Client> {
		if (this.client) {
			throw new Error("Server already connected")
		}

		// Wait for initialization to complete
		await this.initializationPromise

		// Check if initialization was successful
		if (!this.ready) {
			throw new Error("Server initialization failed - cannot connect")
		}

		// Create transport pair
		const [clientTransport, serverTransport] = createInMemoryTransportPair()
		this.clientTransport = clientTransport
		this.serverTransport = serverTransport

		// Create and connect client
		this.client = new Client(
			{
				name: "file-cool-client",
				version: "1.0.0",
			},
			{
				capabilities: {},
			}
		)

		// Connect server and client
		await Promise.all([
			this.server.connect(serverTransport),
			this.client.connect(clientTransport),
		])

		return this.client
	}

	/**
	 * Disconnect and cleanup
	 */
	async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.close()
			this.client = null
		}

		if (this.serverTransport) {
			await this.serverTransport.close()
			this.serverTransport = null
		}

		if (this.clientTransport) {
			await this.clientTransport.close()
			this.clientTransport = null
		}
	}

	/**
	 * Get the connected client (if any)
	 */
	getClient(): Client | null {
		return this.client
	}

	/**
	 * Check if server is connected
	 */
	isConnected(): boolean {
		return this.client !== null && this.serverTransport !== null && !this.serverTransport.isClosed
	}

	/**
	 * Check if server initialization is complete
	 */
	isReady(): boolean {
		return this.ready
	}
}

/**
 * Factory function to create and connect an in-memory file-cool server
 */
export async function createInMemoryFileCoolServer(config?: FileCoolConfig): Promise<{
	server: InMemoryFileCoolServer
	client: Client
}> {
	const server = new InMemoryFileCoolServer(config)
	const client = await server.connect()
	return { server, client }
}
