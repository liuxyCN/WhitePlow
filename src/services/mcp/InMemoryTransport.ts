import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { EventEmitter } from "events"

/**
 * In-memory transport for connecting MCP client and server in the same process
 */
export class InMemoryTransport implements Transport {
	private _isStarted = false
	private _isClosed = false
	private _peer: InMemoryTransport | null = null
	private _eventEmitter = new EventEmitter()

	// Transport interface callbacks
	onclose?: () => void
	onerror?: (error: Error) => void
	onmessage?: (message: JSONRPCMessage) => void

	constructor() {
		// Set up event listeners
		this._eventEmitter.on("message", (message: JSONRPCMessage) => {
			if (this.onmessage && !this._isClosed) {
				try {
					this.onmessage(message)
				} catch (error) {
					this.onerror?.(error instanceof Error ? error : new Error(String(error)))
				}
			}
		})

		this._eventEmitter.on("error", (error: Error) => {
			if (this.onerror && !this._isClosed) {
				this.onerror(error)
			}
		})

		this._eventEmitter.on("close", () => {
			if (this.onclose && !this._isClosed) {
				this._isClosed = true
				this.onclose()
			}
		})
	}

	/**
	 * Connect this transport to its peer
	 */
	connectToPeer(peer: InMemoryTransport): void {
		if (this._peer) {
			throw new Error("Transport already connected to a peer")
		}
		this._peer = peer
		peer._peer = this
	}

	/**
	 * Start the transport
	 */
	async start(): Promise<void> {
		if (this._isStarted) {
			throw new Error("Transport already started")
		}
		if (this._isClosed) {
			throw new Error("Transport is closed")
		}
		this._isStarted = true
	}

	/**
	 * Send a message to the peer
	 */
	async send(message: JSONRPCMessage): Promise<void> {
		if (!this._isStarted) {
			throw new Error("Transport not started")
		}
		if (this._isClosed) {
			throw new Error("Transport is closed")
		}
		if (!this._peer) {
			throw new Error("No peer connected")
		}

		// Send message to peer asynchronously
		setImmediate(() => {
			if (this._peer && !this._peer._isClosed) {
				this._peer._eventEmitter.emit("message", message)
			}
		})
	}

	/**
	 * Close the transport
	 */
	async close(): Promise<void> {
		if (this._isClosed) {
			return
		}

		this._isClosed = true
		this._isStarted = false

		// Notify peer of closure
		if (this._peer && !this._peer._isClosed) {
			setImmediate(() => {
				this._peer?._eventEmitter.emit("close")
			})
		}

		// Emit close event for this transport
		setImmediate(() => {
			this._eventEmitter.emit("close")
		})

		// Clean up
		this._eventEmitter.removeAllListeners()
		this._peer = null
	}

	/**
	 * Check if transport is closed
	 */
	get isClosed(): boolean {
		return this._isClosed
	}

	/**
	 * Check if transport is started
	 */
	get isStarted(): boolean {
		return this._isStarted
	}
}

/**
 * Create a pair of connected in-memory transports
 */
export function createInMemoryTransportPair(): [InMemoryTransport, InMemoryTransport] {
	const clientTransport = new InMemoryTransport()
	const serverTransport = new InMemoryTransport()
	
	clientTransport.connectToPeer(serverTransport)
	
	return [clientTransport, serverTransport]
}
