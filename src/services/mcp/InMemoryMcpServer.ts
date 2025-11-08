import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createInMemoryTransportPair, InMemoryTransport } from "./InMemoryTransport.js"
import { processFiles } from "../file-cool/client.js"
import { z, type ZodRawShape } from "zod"
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
			const tools = await this.fetchToolsList()
			const inputSchema = this.createInputSchema()

			for (const tool of tools) {
				this.registerTool(tool.name, tool.description, inputSchema)
			}
		} catch (error) {
			console.error("Failed to setup server with dynamic tools:", error)
			throw error
		}
	}

	// Create common input schema for all tools
	private createInputSchema(): ZodRawShape {
		return {
			inputs: z
				.array(z.string())
				.describe("File paths or URLs - 文件路径或URL地址。支持绝对文件路径字符串数组或URL字符串数组 / Supports absolute file path string array or URL string array"),
		} as ZodRawShape
	}

	// Register a single tool
	private registerTool(toolName: string, toolDescription: string, inputSchema: ZodRawShape): void {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const toolHandler = async (args: any): Promise<any> => {
			try {
				const inputs = args.inputs as string[]
				if (!Array.isArray(inputs)) {
					throw new Error(`Expected inputs to be an array, got ${typeof inputs}`)
				}

				const result = await processFiles(inputs, toolName, this.config)
				return {
					content: [{ type: "text", text: `${toolName} result: ${result}` }],
				}
			} catch (error: any) {
				throw new Error(this.formatToolError(toolName, error))
			}
		}

		// Register tool with correct context
		(this.server.registerTool as any).call(
			this.server,
			toolName,
			{ description: toolDescription, inputSchema },
			toolHandler
		)
	}

	// Format tool error messages
	private formatToolError(toolName: string, error: any): string {
		const message = error.message || String(error)
		if (message.includes("MCP Gateway URL is required")) {
			return `${toolName} failed: MCP Gateway URL is not configured. Please set the Gateway URL in MCP settings.`
		}
		if (message.includes("MCP Gateway API Key is required")) {
			return `${toolName} failed: MCP Gateway API Key is not configured. Please set the API Key in MCP settings.`
		}
		return `${toolName} failed: ${message}`
	}

	// Fetch tools list from API
	private async fetchToolsList(): Promise<ToolInfo[]> {
		if (!this.config.apiUrl || !this.config.apiKey) {
			throw new Error("API URL and API Key are required to fetch tools list")
		}

		try {
			const response = await axios.get(`${this.config.apiUrl}/file-cool/tools`, {
				headers: { API_KEY: this.config.apiKey },
				timeout: 10000,
			})

			if (!response.data || !Array.isArray(response.data)) {
				throw new Error("Invalid response format from tools API")
			}

			return response.data.map((tool: any) => ({
				name: tool.name,
				description: tool.description || `Execute ${tool.name} function`,
			}))
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
