import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createInMemoryTransportPair, InMemoryTransport } from "./InMemoryTransport.js"
import { processFiles } from "../file-cool/client.js"
import { z } from "zod"

interface FileCoolConfig {
	apiUrl?: string;
	apiKey?: string;
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

	constructor(config?: FileCoolConfig) {
		this.config = config || {};
		console.log(`InMemoryFileCoolServer initialized with config:`, {
			apiUrl: this.config.apiUrl || 'not configured',
			apiKey: this.config.apiKey ? '[REDACTED]' : 'not configured'
		});
		this.server = new McpServer({
			name: "file-cool-memory",
			version: "1.0.0",
		})

		this.setupServer()
	}

	private setupServer(): void {
		// Register the paddle_ocr tool
		this.server.registerTool(
			"paddle_ocr",
			{
				description: "Execute OCR from PDF or image file to markdown using PaddleOCR",
				inputSchema: {
					inputFiles: z
						.array(z.string())
						.describe("Path to the PDF or Image files, absolute file path"),
				},
			},
			async ({ inputFiles }) => {
				try {
					const result = await processFiles(inputFiles, "paddle_ocr", this.config)
					return {
						content: [
							{
								type: "text",
								text: `OCR result: ${result}`,
							},
						],
					}
				} catch (error: any) {
					// Provide more helpful error messages for configuration issues
					if (error.message.includes("MCP Gateway URL is required")) {
						throw new Error(`OCR failed: MCP Gateway URL is not configured. Please set the Gateway URL in MCP settings.`)
					}
					if (error.message.includes("MCP Gateway API Key is required")) {
						throw new Error(`OCR failed: MCP Gateway API Key is not configured. Please set the API Key in MCP settings.`)
					}
					throw new Error(`OCR failed: ${error.message}`)
				}
			}
		)
	}

	/**
	 * Start the in-memory server and return a connected client
	 */
	async connect(): Promise<Client> {
		if (this.client) {
			throw new Error("Server already connected")
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
