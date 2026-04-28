import { randomUUID } from "crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import fs from "fs"
import http from "http"
import path from "path"
import { fileURLToPath } from "url"

import { getProviderDefaultModelId, rooCliEventTypes } from "@roo-code/types"
import { normalizeOrderedWorkspaceRoots } from "@roo-code/vscode-shim"

import type { SupportedProvider } from "@/types/index.js"
import { getDefaultExtensionPath } from "@/lib/utils/extension.js"
import { loadSettings } from "@/lib/storage/index.js"
import { isSupportedProvider, supportedProviders } from "@/types/index.js"

import { isRecord } from "@/lib/utils/guards.js"

import { parseCliUserId } from "@/lib/utils/cli-user-id.js"

import { parseAllowlistFromEnv, validateWorkspacePath } from "./workspace-path.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function assertHttpOrHttpsBaseUrl(label: string, raw: string): string {
	const trimmed = raw.trim()
	if (!trimmed) {
		throw new Error(`${label} is required and must be non-empty`)
	}
	let parsed: URL
	try {
		parsed = new URL(trimmed)
	} catch {
		throw new Error(`${label} must be a valid absolute URL`)
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${label} must use http or https`)
	}
	return trimmed
}

export interface ServeCliOptions {
	host: string
	port: number
	extension?: string
	debug?: boolean
}

interface CreateAgentBody {
	workspace: string
	/** Additional workspace directories (multi-root); {@link workspace} is the first root / default cwd. */
	workspaces?: string[]
	provider?: SupportedProvider
	model?: string
	mode?: string
	apiKey?: string
	/** Required when the effective provider is `chinalifepe` (OpenAI-compatible gateway root URL). */
	openAiBaseUrl?: string
	ephemeral?: boolean
	/** Per-user storage; [a-zA-Z0-9_-]+ only; ignored when ephemeral is true. */
	userId?: string
	debug?: boolean
	reasoningEffort?: string
	exitOnError?: boolean
}

interface TaskBody {
	prompt: string
	sessionId?: string
	images?: string[]
	configuration?: Record<string, unknown>
}

interface MessageBody {
	prompt: string
	images?: string[]
}

type SseListener = (line: string) => void

/** NDJSON lines emitted by the CLI stream-json transport (do not mirror as debug). */
const ROO_CLI_EVENT_TYPE_SET = new Set<string>(rooCliEventTypes)

function isAgentChildStdoutProtocolLine(line: string): boolean {
	try {
		const v = JSON.parse(line) as unknown
		if (!v || typeof v !== "object" || Array.isArray(v)) {
			return false
		}
		const o = v as Record<string, unknown>
		if (o.rooServeBridge === true) {
			return true
		}
		if (o.type === "serve") {
			return true
		}
		if (typeof o.type === "string" && ROO_CLI_EVENT_TYPE_SET.has(o.type)) {
			return true
		}
		return false
	} catch {
		return false
	}
}

class AgentSession {
	readonly id: string
	readonly workspace: string
	readonly child: ChildProcessWithoutNullStreams
	private stdoutBuf = ""
	private readonly listeners = new Set<SseListener>()

	constructor(
		id: string,
		workspace: string,
		child: ChildProcessWithoutNullStreams,
		private readonly onChildExit?: () => void,
	) {
		this.id = id
		this.workspace = workspace
		this.child = child

		child.stdout.setEncoding("utf8")
		child.stdout.on("data", (chunk: string) => {
			this.stdoutBuf += chunk
			const parts = this.stdoutBuf.split("\n")
			this.stdoutBuf = parts.pop() ?? ""
			for (const line of parts) {
				const t = line.trim()
				if (t) {
					this.emitLine(t)
				}
			}
		})

		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk: string) => {
			process.stderr.write(`[serve agent ${id}] ${chunk}`)
		})

		child.on("exit", (code, signal) => {
			const tail = this.stdoutBuf.trim()
			if (tail) {
				this.emitLine(tail)
			}

			this.stdoutBuf = ""
			this.emitLine(
				JSON.stringify({
					type: "serve",
					subtype: "agent_exit",
					agentId: id,
					code,
					signal,
				}),
			)
			this.listeners.clear()
			this.onChildExit?.()
		})
	}

	private emitLine(line: string): void {
		// Extension / Node `console.log` goes to the child stdout stream and would otherwise be invisible
		// to the serve parent. Mirror non-protocol lines to stderr only (do not forward to SSE — not JSON).
		if (!isAgentChildStdoutProtocolLine(line)) {
			process.stderr.write(`[serve agent ${this.id}] ${line}\n`)
			return
		}
		for (const fn of this.listeners) {
			try {
				fn(line)
			} catch {
				// ignore subscriber errors
			}
		}
	}

	subscribe(fn: SseListener): () => void {
		this.listeners.add(fn)
		return () => {
			this.listeners.delete(fn)
		}
	}

	writeNdjson(obj: unknown): boolean {
		if (this.child.stdin.destroyed) {
			return false
		}

		return this.child.stdin.write(`${JSON.stringify(obj)}\n`)
	}

	async shutdown(): Promise<void> {
		if (this.child.killed) {
			return
		}

		try {
			this.writeNdjson({ command: "shutdown", requestId: randomUUID() })
		} catch {
			// stdin may already be closed
		}

		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				if (!this.child.killed) {
					this.child.kill("SIGKILL")
				}

				resolve()
			}, 10_000)

			this.child.once("exit", () => {
				clearTimeout(t)
				resolve()
			})
		})
	}
}

function getCliEntryScript(): string {
	const fromArgv = process.argv[1]
	if (fromArgv && (fromArgv.endsWith(".ts") || fromArgv.endsWith(".tsx"))) {
		const distSibling = path.resolve(path.dirname(fromArgv), "../dist/index.js")
		if (fs.existsSync(distSibling)) {
			return distSibling
		}
	}

	if (fromArgv && fs.existsSync(fromArgv)) {
		return fromArgv
	}

	const bundledFallback = path.join(path.dirname(fileURLToPath(import.meta.url)), "../index.js")
	if (fs.existsSync(bundledFallback)) {
		return bundledFallback
	}

	throw new Error(
		"Cannot resolve CLI script for agent subprocesses. Build the CLI (pnpm --filter @roo-code/cli build) or run the packaged `roo` binary.",
	)
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	}
}

/** One line per request when the response ends: `[ISO] METHOD /path STATUS Nms - client` */
function attachServeHttpAccessLog(req: http.IncomingMessage, res: http.ServerResponse): void {
	const accessStarted = Date.now()
	const accessPath = (req.url ?? "/").split("?")[0] || "/"
	const xf = req.headers["x-forwarded-for"]
	const accessClient =
		(typeof xf === "string" && xf.split(",")[0]?.trim()) ||
		req.socket.remoteAddress?.replace(/^::ffff:/, "") ||
		"-"

	let logged = false
	const logOnce = (): void => {
		if (logged) {
			return
		}
		logged = true
		const code = typeof res.statusCode === "number" && res.statusCode > 0 ? res.statusCode : 0
		const duration = Date.now() - accessStarted
		console.log(`[${new Date().toISOString()}] ${req.method} ${accessPath} ${code} ${duration}ms - ${accessClient}`)
	}

	res.on("finish", logOnce)
	res.on("close", logOnce)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		...corsHeaders(),
	})
	res.end(payload)
}

function sendAgentNotFound(res: http.ServerResponse): void {
	sendJson(res, 404, { error: "not_found", message: "agent not found" })
}

function sendStdinClosed(res: http.ServerResponse): void {
	sendJson(res, 503, { error: "stdin_closed", message: "agent process stdin is closed" })
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []

	for await (const chunk of req) {
		chunks.push(chunk as Buffer)
	}

	const raw = Buffer.concat(chunks).toString("utf8").trim()
	if (!raw) {
		return undefined
	}

	try {
		return JSON.parse(raw) as unknown
	} catch {
		throw new Error("invalid JSON body")
	}
}

function getMaxAgents(): number {
	const n = Number.parseInt(process.env.ROO_SERVE_MAX_AGENTS ?? "32", 10)
	return Number.isFinite(n) && n > 0 ? n : 32
}

const DEFAULT_AGENT_TTL_MS = 4 * 60 * 60 * 1000

/** Max lifetime per agent after POST /v1/agents; 0 disables (env ROO_SERVE_AGENT_TTL_MS). */
function getAgentTtlMs(): number {
	const raw = process.env.ROO_SERVE_AGENT_TTL_MS
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_AGENT_TTL_MS
	}
	const n = Number.parseInt(raw, 10)
	if (!Number.isFinite(n) || n < 0) {
		return DEFAULT_AGENT_TTL_MS
	}
	return n
}

const APP_URL_PREFIX = "/app"

/** Welcome UI uses `IMAGES_BASE_URI + "/neontractor-logo.png"` (VS Code webview parity). */
function resolveNeontractorLogoFile(extensionRoot: string): string | null {
	const candidates = [
		path.join(extensionRoot, "assets", "images", "neontractor-logo.png"),
		path.join(extensionRoot, "..", "assets", "images", "neontractor-logo.png"),
	]

	for (const candidate of candidates) {
		const resolved = path.resolve(candidate)
		try {
			if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
				return resolved
			}
		} catch {
			// ignore
		}
	}

	return null
}

const SERVE_AUDIO_WAV_NAMES = ["notification.wav", "celebration.wav", "progress_loop.wav"] as const

/** Chat UI loads `${AUDIO_BASE_URI}/notification.wav` etc.; in serve, base is empty so paths are site-root. */
function resolveServeAudioWavFile(extensionRoot: string, fileName: string): string | null {
	if (!(SERVE_AUDIO_WAV_NAMES as readonly string[]).includes(fileName)) {
		return null
	}

	const candidates = [
		path.join(extensionRoot, "webview-ui", "audio", fileName),
		path.join(extensionRoot, "..", "webview-ui", "audio", fileName),
		path.join(extensionRoot, "..", "..", "webview-ui", "audio", fileName),
	]

	for (const candidate of candidates) {
		const resolved = path.resolve(candidate)
		try {
			if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
				return resolved
			}
		} catch {
			// ignore
		}
	}

	return null
}

function findCliPackageRoot(): string {
	let dir = __dirname

	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string }
				if (pkg.name === "@roo-code/cli") {
					return dir
				}
			} catch {
				// continue
			}
		}

		dir = path.dirname(dir)
	}

	return path.resolve(__dirname, "../..")
}

function resolveServeStaticRoot(): string | null {
	if (process.env.ROO_SERVE_STATIC_DIR) {
		const custom = path.resolve(process.env.ROO_SERVE_STATIC_DIR)
		if (fs.existsSync(path.join(custom, "index.html"))) {
			return custom
		}

		return null
	}

	const builtIn = path.join(findCliPackageRoot(), "static-webview", "build")
	return fs.existsSync(path.join(builtIn, "index.html")) ? builtIn : null
}

function safeStaticFile(staticRoot: string, urlPath: string): string | null {
	const rel = decodeURIComponent(urlPath).replace(/^\/+/, "")
	if (!rel || rel.includes("..")) {
		return null
	}

	const rootReal = path.resolve(staticRoot)
	const full = path.resolve(path.join(staticRoot, rel))
	if (full !== rootReal && !full.startsWith(rootReal + path.sep)) {
		return null
	}

	return full
}

function contentTypeFor(filePath: string): string {
	if (filePath.endsWith(".html")) {
		return "text/html; charset=utf-8"
	}

	if (filePath.endsWith(".js")) {
		return "text/javascript; charset=utf-8"
	}

	if (filePath.endsWith(".css")) {
		return "text/css; charset=utf-8"
	}

	if (filePath.endsWith(".json")) {
		return "application/json; charset=utf-8"
	}

	if (filePath.endsWith(".svg")) {
		return "image/svg+xml"
	}

	if (filePath.endsWith(".png")) {
		return "image/png"
	}

	if (filePath.endsWith(".wav")) {
		return "audio/wav"
	}

	if (filePath.endsWith(".woff2")) {
		return "font/woff2"
	}

	if (filePath.endsWith(".wasm")) {
		return "application/wasm"
	}

	return "application/octet-stream"
}

function injectAgentIdInHtml(html: string, agentId: string | undefined): string {
	if (!agentId) {
		return html
	}

	const injection = `<script>window.__ROO_SERVE_AGENT_ID__=${JSON.stringify(agentId)};</script>`
	if (html.includes("</head>")) {
		return html.replace("</head>", `${injection}</head>`)
	}

	return injection + html
}

function tryServeAppStatic(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	pathname: string,
	url: URL,
	staticRoot: string | null,
): boolean {
	if (req.method !== "GET" && req.method !== "HEAD") {
		return false
	}

	if (pathname !== APP_URL_PREFIX && !pathname.startsWith(`${APP_URL_PREFIX}/`)) {
		return false
	}

	if (!staticRoot) {
		sendJson(res, 503, {
			error: "static_not_built",
			message:
				"Web UI not found. Run: pnpm --filter @roo-code/vscode-webview build:serve (outputs to apps/cli/static-webview/build)",
		})
		return true
	}

	// Only redirect raw `/app` → `/app/` (+ query). Do not redirect when the URL is already
	// `/app/...` — pathname normalization collapses `/app/` to `/app`, and redirecting again
	// would send the same Location (e.g. `/app/?agentId=...`), causing ERR_TOO_MANY_REDIRECTS
	// and a chrome-error:// frame (browser "domains must match" noise in devtools).
	if (url.pathname === "/app") {
		res.writeHead(302, { Location: `${APP_URL_PREFIX}/${url.search}`, ...corsHeaders() })
		res.end()
		return true
	}

	let rel = pathname.slice(APP_URL_PREFIX.length)
	if (rel.startsWith("/")) {
		rel = rel.slice(1)
	}

	if (!rel) {
		rel = "index.html"
	}

	let filePath = safeStaticFile(staticRoot, rel)
	if ((!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) && rel !== "index.html") {
		filePath = path.join(staticRoot, "index.html")
	}

	if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
		sendJson(res, 404, { error: "not_found", path: pathname })
		return true
	}

	const ctype = contentTypeFor(filePath)
	res.writeHead(200, { "Content-Type": ctype, ...corsHeaders() })

	if (req.method === "HEAD") {
		res.end()
		return true
	}

	if (filePath.endsWith(".html")) {
		const agentId = url.searchParams.get("agentId") ?? undefined
		res.end(injectAgentIdInHtml(fs.readFileSync(filePath, "utf8"), agentId))
		return true
	}

	fs.createReadStream(filePath).pipe(res)
	return true
}

export async function startServeHttp(cliOptions: ServeCliOptions): Promise<void> {
	const allowlist = parseAllowlistFromEnv()
	const settings = await loadSettings()
	const cwd = process.cwd()
	const extensionPath = path.resolve(cliOptions.extension || getDefaultExtensionPath(__dirname))
	const cliScript = getCliEntryScript()
	const maxAgents = getMaxAgents()
	const agents = new Map<string, AgentSession>()
	const agentTtlCancel = new Map<string, () => void>()

	if (!fs.existsSync(path.join(extensionPath, "extension.js"))) {
		console.error(`[serve] extension bundle not found at ${extensionPath} (expected extension.js)`)
		process.exit(1)
	}

	/** Resolved once: avoids `findCliPackageRoot` + fs checks on every HTTP request. */
	const staticRoot = resolveServeStaticRoot()

	const buildSpawnArgs = (workspaceRoots: string[], body: CreateAgentBody): string[] => {
		const primary = workspaceRoots[0]
		if (!primary) {
			throw new Error("at least one workspace root is required")
		}
		let provider: SupportedProvider
		if (body.provider !== undefined) {
			if (typeof body.provider !== "string" || !isSupportedProvider(body.provider)) {
				throw new Error(`invalid provider; must be one of: ${supportedProviders.join(", ")}`)
			}
			provider = body.provider
		} else if (typeof settings.provider === "string" && isSupportedProvider(settings.provider)) {
			provider = settings.provider
		} else {
			provider = "chinalifepe"
		}

		const model =
			body.model ?? settings.model ?? getProviderDefaultModelId(provider)
		const mode = body.mode ?? settings.mode ?? "ask"

		const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
		if (!apiKey) {
			throw new Error("apiKey is required and must be non-empty")
		}

		const openAiBaseUrlRaw = typeof body.openAiBaseUrl === "string" ? body.openAiBaseUrl.trim() : ""
		if (provider === "chinalifepe" || openAiBaseUrlRaw) {
			assertHttpOrHttpsBaseUrl("openAiBaseUrl", openAiBaseUrlRaw)
		}

		const args: string[] = [
			cliScript,
			"--print",
			"--output-format",
			"stream-json",
			"--stdin-prompt-stream",
			"--signal-only-exit",
			"-w",
			primary,
			"-e",
			extensionPath,
			"--provider",
			provider,
			"-m",
			model,
			"--mode",
			mode,
		]

		args.push("-k", apiKey)

		if (openAiBaseUrlRaw) {
			args.push("--open-ai-base-url", openAiBaseUrlRaw)
		}

		if (body.ephemeral) {
			args.push("--ephemeral")
		}

		const userIdRaw = typeof body.userId === "string" ? body.userId.trim() : ""
		if (userIdRaw) {
			if (body.ephemeral) {
				throw new Error("userId cannot be used together with ephemeral")
			}

			const safeUserId = parseCliUserId(userIdRaw)
			if (!safeUserId) {
				throw new Error(
					"invalid userId: use only letters, digits, hyphen, and underscore; max 256 characters",
				)
			}

			args.push("--cli-user-id", safeUserId)
		}

		if (body.debug ?? cliOptions.debug) {
			args.push("-d")
		}

		if (body.exitOnError) {
			args.push("--exit-on-error")
		}

		if (body.reasoningEffort) {
			args.push("-r", body.reasoningEffort)
		}

		return args
	}

	const server = http.createServer(async (req, res) => {
		attachServeHttpAccessLog(req, res)

		const cors = corsHeaders()

		if (req.method === "OPTIONS") {
			res.writeHead(204, cors)
			res.end()
			return
		}

		let url: URL
		try {
			url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
		} catch {
			sendJson(res, 400, { error: "bad_request", message: "invalid URL" })
			return
		}

		const pathname = url.pathname.replace(/\/+$/, "") || "/"

		try {
			const heroLogoPaths = new Set<string>([`/neontractor-logo.png`, `${APP_URL_PREFIX}/neontractor-logo.png`])
			if (heroLogoPaths.has(pathname) && (req.method === "GET" || req.method === "HEAD")) {
				const logoFile = resolveNeontractorLogoFile(extensionPath)
				if (!logoFile) {
					sendJson(res, 404, {
						error: "not_found",
						message: `neontractor-logo.png not found under extension path: ${extensionPath}`,
					})
					return
				}

				res.writeHead(200, {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=86400",
					...cors,
				})

				if (req.method === "HEAD") {
					res.end()
					return
				}

				fs.createReadStream(logoFile).pipe(res)
				return
			}

			let serveAudioName: (typeof SERVE_AUDIO_WAV_NAMES)[number] | undefined
			for (const name of SERVE_AUDIO_WAV_NAMES) {
				if (pathname === `/${name}` || pathname === `${APP_URL_PREFIX}/${name}`) {
					serveAudioName = name
					break
				}
			}

			if (serveAudioName && (req.method === "GET" || req.method === "HEAD")) {
				const wavFile = resolveServeAudioWavFile(extensionPath, serveAudioName)
				if (!wavFile) {
					sendJson(res, 404, {
						error: "not_found",
						message: `${serveAudioName} not found under extension path: ${extensionPath}`,
					})
					return
				}

				res.writeHead(200, {
					"Content-Type": "audio/wav",
					"Cache-Control": "public, max-age=86400",
					...cors,
				})

				if (req.method === "HEAD") {
					res.end()
					return
				}

				fs.createReadStream(wavFile).pipe(res)
				return
			}

			if (tryServeAppStatic(req, res, pathname, url, staticRoot)) {
				return
			}

			// POST /v1/agents
			if (req.method === "POST" && pathname === "/v1/agents") {
				if (agents.size >= maxAgents) {
					sendJson(res, 503, { error: "capacity", message: `max agents (${maxAgents}) reached` })
					return
				}

				const raw = await readJsonBody(req)
				if (!raw || typeof raw !== "object" || raw === null) {
					sendJson(res, 400, { error: "bad_request", message: "JSON body required" })
					return
				}

				const body = raw as CreateAgentBody
				if (typeof body.workspace !== "string") {
					sendJson(res, 400, { error: "bad_request", message: "workspace must be a string" })
					return
				}

				const ws = validateWorkspacePath(body.workspace, cwd, allowlist)
				if (!ws.ok) {
					sendJson(res, 400, { error: "workspace", message: ws.error })
					return
				}

				const extraRaw = body.workspaces
				const extra =
					Array.isArray(extraRaw) && extraRaw.length > 0
						? extraRaw.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
						: []

				const resolvedRoots: string[] = [ws.absPath]
				for (const rel of extra) {
					const v = validateWorkspacePath(rel, cwd, allowlist)
					if (!v.ok) {
						sendJson(res, 400, { error: "workspace", message: v.error })
						return
					}
					resolvedRoots.push(v.absPath)
				}

				const roots = normalizeOrderedWorkspaceRoots(resolvedRoots)

				let spawnArgs: string[]
				try {
					spawnArgs = buildSpawnArgs(roots, body)
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e)
					sendJson(res, 400, { error: "bad_request", message })
					return
				}

				const id = randomUUID()
				const child = spawn(process.execPath, spawnArgs, {
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						...process.env,
						ROO_SERVE_BRIDGE: "1",
						...(roots.length > 1 ? { ROO_CLI_WORKSPACE_FOLDERS: roots.join(path.delimiter) } : {}),
					},
					cwd: roots[0]!,
				}) as ChildProcessWithoutNullStreams

				const session = new AgentSession(id, roots[0]!, child, () => {
					agentTtlCancel.get(id)?.()
					agentTtlCancel.delete(id)
					agents.delete(id)
				})
				agents.set(id, session)

				const ttlMs = getAgentTtlMs()
				if (ttlMs > 0) {
					const t = setTimeout(() => {
						agentTtlCancel.delete(id)
						if (agents.get(id) !== session) {
							return
						}
						agents.delete(id)
						process.stderr.write(
							`[serve] agent ${id} reached max lifetime (${ttlMs}ms), shutting down\n`,
						)
						void session.shutdown()
					}, ttlMs)
					agentTtlCancel.set(id, () => clearTimeout(t))
				}

				sendJson(
					res,
					201,
					roots.length > 1
						? { agentId: id, workspace: roots[0]!, workspaces: roots }
						: { agentId: id, workspace: roots[0]! },
				)
				return
			}

			const streamMatch = /^\/v1\/agents\/([^/]+)\/stream$/.exec(pathname)
			if (streamMatch && req.method === "GET") {
				const agentId = streamMatch[1]!
				const s = agents.get(agentId)
				if (!s) {
					sendAgentNotFound(res)
					return
				}

				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
					...cors,
				})

				res.write("\n")

				const writeSse = (line: string) => {
					res.write(`data: ${line}\n\n`)
				}

				const off = s.subscribe(writeSse)
				const ping = setInterval(() => {
					res.write(`: ping\n\n`)
				}, 25_000)

				req.on("close", () => {
					clearInterval(ping)
					off()
				})

				return
			}

			const tasksMatch = /^\/v1\/agents\/([^/]+)\/tasks$/.exec(pathname)
			if (tasksMatch && req.method === "POST") {
				const agentId = tasksMatch[1]!
				const s = agents.get(agentId)
				if (!s) {
					sendAgentNotFound(res)
					return
				}

				const raw = await readJsonBody(req)
				if (!raw || typeof raw !== "object" || raw === null) {
					sendJson(res, 400, { error: "bad_request", message: "JSON body required" })
					return
				}

				const tb = raw as TaskBody
				if (typeof tb.prompt !== "string" || !tb.prompt.trim()) {
					sendJson(res, 400, { error: "bad_request", message: "prompt is required" })
					return
				}

				const requestId = randomUUID()
				const line: Record<string, unknown> = {
					command: "start",
					requestId,
					prompt: tb.prompt.trim(),
				}

				if (tb.sessionId) {
					line.taskId = tb.sessionId
				}

				if (tb.images?.length) {
					line.images = tb.images
				}

				if (tb.configuration && typeof tb.configuration === "object") {
					line.configuration = tb.configuration
				}

				if (!s.writeNdjson(line)) {
					sendStdinClosed(res)
					return
				}

				sendJson(res, 202, { ok: true, requestId })
				return
			}

			const messagesMatch = /^\/v1\/agents\/([^/]+)\/messages$/.exec(pathname)
			if (messagesMatch && req.method === "POST") {
				const agentId = messagesMatch[1]!
				const s = agents.get(agentId)
				if (!s) {
					sendAgentNotFound(res)
					return
				}

				const raw = await readJsonBody(req)
				if (!raw || typeof raw !== "object" || raw === null) {
					sendJson(res, 400, { error: "bad_request", message: "JSON body required" })
					return
				}

				const mb = raw as MessageBody
				if (typeof mb.prompt !== "string" || !mb.prompt.trim()) {
					sendJson(res, 400, { error: "bad_request", message: "prompt is required" })
					return
				}

				const requestId = randomUUID()
				const line: Record<string, unknown> = {
					command: "message",
					requestId,
					prompt: mb.prompt.trim(),
				}

				if (mb.images?.length) {
					line.images = mb.images
				}

				if (!s.writeNdjson(line)) {
					sendStdinClosed(res)
					return
				}

				sendJson(res, 202, { ok: true, requestId })
				return
			}

			const cancelMatch = /^\/v1\/agents\/([^/]+)\/cancel$/.exec(pathname)
			if (cancelMatch && req.method === "POST") {
				const agentId = cancelMatch[1]!
				const s = agents.get(agentId)
				if (!s) {
					sendAgentNotFound(res)
					return
				}

				const requestId = randomUUID()
				if (!s.writeNdjson({ command: "cancel", requestId })) {
					sendStdinClosed(res)
					return
				}

				sendJson(res, 202, { ok: true, requestId })
				return
			}

			const extensionMatch = /^\/v1\/agents\/([^/]+)\/extension$/.exec(pathname)
			if (extensionMatch && req.method === "POST") {
				const agentId = extensionMatch[1]!
				const s = agents.get(agentId)
				if (!s) {
					sendAgentNotFound(res)
					return
				}

				const raw = await readJsonBody(req)
				if (!isRecord(raw)) {
					sendJson(res, 400, { error: "bad_request", message: "JSON object body required (WebviewMessage)" })
					return
				}

				const requestId = randomUUID()
				if (!s.writeNdjson({ command: "extension", requestId, message: raw })) {
					sendStdinClosed(res)
					return
				}

				sendJson(res, 202, { ok: true, requestId })
				return
			}

			const deleteMatch = /^\/v1\/agents\/([^/]+)$/.exec(pathname)
			if (deleteMatch && req.method === "DELETE") {
				const agentId = deleteMatch[1]!
				const s = agents.get(agentId)
				if (!s) {
					sendAgentNotFound(res)
					return
				}

				agentTtlCancel.get(agentId)?.()
				agentTtlCancel.delete(agentId)
				agents.delete(agentId)
				await s.shutdown()
				sendJson(res, 200, { ok: true, agentId })
				return
			}

			if (pathname === "/health" || pathname === "/") {
				sendJson(res, 200, {
					ok: true,
					service: "roo-serve",
					agents: agents.size,
					chatUi: staticRoot ? `http://${cliOptions.host}:${cliOptions.port}${APP_URL_PREFIX}/` : null,
				})
				return
			}

			sendJson(res, 404, { error: "not_found", path: pathname })
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e)
			sendJson(res, 400, { error: "bad_request", message })
		}
	})

	server.listen(cliOptions.port, cliOptions.host, () => {
		console.log(`[serve] listening on http://${cliOptions.host}:${cliOptions.port}`)
		console.log(
			`[serve] POST /v1/agents — required JSON fields: "workspace", "apiKey", "openAiBaseUrl" (OpenAI-compatible API base URL, http(s) root; default provider chinalifepe; MCP uses <openAiBaseUrl>/mcp). Optional: "workspaces" (string[], extra roots; same allowlist as workspace).`,
		)
		console.log(
			`[serve] POST /v1/agents  example: {"workspace":"/abs/path/to/repo","apiKey":"<key>","openAiBaseUrl":"http://127.0.0.1:3000","userId":"my-user-id"}`,
		)
		console.log(
			`[serve] POST /v1/agents  multi-root example: {"workspace":"/abs/path/to/repo","workspaces":["/abs/path/to/other"],"apiKey":"<key>","openAiBaseUrl":"http://127.0.0.1:3000","userId":"my-user-id"}`,
		)
		if (staticRoot) {
			console.log(
				`[serve] Chat UI: http://${cliOptions.host}:${cliOptions.port}${APP_URL_PREFIX}/?agentId=<agentId>`,
			)
		} else {
			console.log("[serve] Chat UI not built; run: pnpm --filter @roo-code/vscode-webview build:serve")
		}

		if (allowlist?.length) {
			console.log(`[serve] ROO_WORKSPACE_ALLOWLIST: ${allowlist.join(", ")}`)
		} else {
			console.log("[serve] ROO_WORKSPACE_ALLOWLIST not set (any resolvable directory allowed)")
		}

		const storageRoot = process.env.ROO_CLI_STORAGE_ROOT?.trim() || "~/neontractor-storage (default)"
		console.log(`[serve] Optional POST field "userId" → per-user storage under ${storageRoot}/<userId> (not with ephemeral)`)

		const ttlLog = getAgentTtlMs()
		console.log(
			`[serve] agent max lifetime: ${ttlLog === 0 ? "disabled" : `${ttlLog}ms`} (ROO_SERVE_AGENT_TTL_MS; default 4h)`,
		)
	})

	const shutdownAll = async () => {
		for (const cancel of agentTtlCancel.values()) {
			cancel()
		}
		agentTtlCancel.clear()
		const list = [...agents.values()]
		agents.clear()
		await Promise.all(list.map((s) => s.shutdown()))
	}

	process.on("SIGINT", () => {
		void shutdownAll().finally(() => process.exit(0))
	})

	process.on("SIGTERM", () => {
		void shutdownAll().finally(() => process.exit(0))
	})
}
