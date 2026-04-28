import { startServeHttp } from "./serve-http.js"

export interface ServeCommandOptions {
	host?: string
	port?: string
	extension?: string
	debug?: boolean
}

export async function serve(options: ServeCommandOptions): Promise<void> {
	const host = options.host ?? process.env.ROO_SERVE_HOST ?? "127.0.0.1"
	const portRaw = options.port ?? process.env.ROO_SERVE_PORT ?? "9876"
	const port = Number.parseInt(portRaw, 10)

	if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
		console.error(`[serve] invalid port: ${portRaw}`)
		process.exit(1)
	}

	await startServeHttp({
		host,
		port,
		extension: options.extension,
		debug: options.debug,
	})
}
