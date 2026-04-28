import path, { resolve } from "path"
import fs from "fs"
import { execSync } from "child_process"

import { defineConfig, type PluginOption, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

import { sourcemapPlugin } from "./src/vite-plugins/sourcemapPlugin"

function getGitSha() {
	let gitSha: string | undefined = undefined

	try {
		gitSha = execSync("git rev-parse HEAD").toString().trim()
	} catch (_error) {
		// Do nothing.
	}

	return gitSha
}

const wasmPlugin = (): Plugin => ({
	name: "wasm",
	async load(id) {
		if (id.endsWith(".wasm")) {
			const wasmBinary = await import(id)

			return `
           			const wasmModule = new WebAssembly.Module(${wasmBinary.default});
           			export default wasmModule;
         		`
		}
	},
})

const VIRTUAL_SERVE_THEME_COLORS = "virtual:serve-theme-colors"
const RESOLVED_VIRTUAL_SERVE_THEME_COLORS = "\0" + VIRTUAL_SERVE_THEME_COLORS

/** Same line-strip as `getTheme.parseThemeString` for theme JSON with // comments. */
function stripThemeJsonComments(themeString: string): string {
	return themeString
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n")
}

/**
 * Merge `colors` along `include`: base theme first, then each file overrides (child wins on same key).
 */
function flattenThemeColorsFromFile(absPath: string, stack: Set<string> = new Set()): Record<string, string> {
	const real = path.resolve(absPath)
	if (stack.has(real)) {
		return {}
	}
	stack.add(real)
	try {
		const raw = fs.readFileSync(real, "utf8")
		const parsed = JSON.parse(stripThemeJsonComments(raw)) as {
			include?: string
			colors?: Record<string, string | null | undefined>
		}

		let merged: Record<string, string> = {}
		if (typeof parsed.include === "string" && parsed.include.length > 0) {
			const incPath = path.resolve(path.dirname(real), parsed.include.replace(/^\.\//, ""))
			merged = { ...flattenThemeColorsFromFile(incPath, stack) }
		}
		if (parsed.colors && typeof parsed.colors === "object") {
			for (const [k, v] of Object.entries(parsed.colors)) {
				if (typeof v === "string" && v.length > 0) {
					merged[k] = v
				}
			}
		}
		return merged
	} finally {
		stack.delete(real)
	}
}

function serveThemeColorsPlugin(mode: string): Plugin {
	return {
		name: "serve-theme-colors",
		resolveId(id) {
			if (id === VIRTUAL_SERVE_THEME_COLORS) {
				return RESOLVED_VIRTUAL_SERVE_THEME_COLORS
			}
			return undefined
		},
		load(id) {
			if (id !== RESOLVED_VIRTUAL_SERVE_THEME_COLORS) {
				return undefined
			}

			if (mode !== "serve") {
				return "export const THEME_COLORS = {};"
			}

			const themesDir = path.resolve(__dirname, "../src/integrations/theme/default-themes")
			const entry = path.join(themesDir, "light_modern.json")
			if (!fs.existsSync(entry)) {
				console.warn(`[serve-theme-colors] missing ${entry}; THEME_COLORS will be empty`)
				return "export const THEME_COLORS = {};"
			}

			const colors = flattenThemeColorsFromFile(entry)
			return `export const THEME_COLORS = ${JSON.stringify(colors)};`
		},
	}
}

const persistPortPlugin = (): Plugin => ({
	name: "write-port-to-file",
	configureServer(viteDevServer) {
		viteDevServer?.httpServer?.once("listening", () => {
			const address = viteDevServer?.httpServer?.address()
			const port = address && typeof address === "object" ? address.port : null

			if (port) {
				fs.writeFileSync(resolve(__dirname, "..", ".vite-port"), port.toString())
				console.log(`[Vite Plugin] Server started on port ${port}`)
			} else {
				console.warn("[Vite Plugin] Could not determine server port")
			}
		})
	},
})

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	let outDir = "../src/webview-ui/build"

	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "package.json"), "utf8"))
	const gitSha = getGitSha()

	const define: Record<string, any> = {
		"process.platform": JSON.stringify(process.platform),
		"process.env.VSCODE_TEXTMATE_DEBUG": JSON.stringify(process.env.VSCODE_TEXTMATE_DEBUG),
		"process.env.PKG_NAME": JSON.stringify(pkg.name),
		"process.env.PKG_VERSION": JSON.stringify(pkg.version),
		"process.env.PKG_OUTPUT_CHANNEL": JSON.stringify("Roo-Code"),
		...(gitSha ? { "process.env.PKG_SHA": JSON.stringify(gitSha) } : {}),
	}

	// TODO: We can use `@roo-code/build` to generate `define` once the
	// monorepo is deployed.
	if (mode === "nightly") {
		outDir = "../apps/vscode-nightly/build/webview-ui/build"

		const nightlyPkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "apps", "vscode-nightly", "package.nightly.json"), "utf8"),
		)

		define["process.env.PKG_NAME"] = JSON.stringify(nightlyPkg.name)
		define["process.env.PKG_VERSION"] = JSON.stringify(nightlyPkg.version)
		define["process.env.PKG_OUTPUT_CHANNEL"] = JSON.stringify("Roo-Code-Nightly")
	}

	if (mode === "serve") {
		outDir = "../apps/cli/static-webview/build"
		define["import.meta.env.VITE_ROO_SERVE"] = JSON.stringify("1")
	}

	const plugins: PluginOption[] = [
		serveThemeColorsPlugin(mode),
		react({
			babel: {
				plugins: [["babel-plugin-react-compiler", { target: "18" }]],
			},
		}),
		tailwindcss(),
		persistPortPlugin(),
		wasmPlugin(),
		sourcemapPlugin(),
	]

	return {
		base: mode === "serve" ? "/app/" : undefined,
		plugins,
		resolve: {
			alias: {
				"@": resolve(__dirname, "./src"),
				"@src": resolve(__dirname, "./src"),
				"@roo": resolve(__dirname, "../src/shared"),
				// Shared code (e.g. modes.ts → roo-config → ripgrep) imports `vscode`; only the
				// extension host has the real module — stub for dev/build resolution.
				vscode: resolve(__dirname, "./src/vite-stubs/vscode.ts"),
			},
		},
		build: {
			outDir,
			emptyOutDir: true,
			reportCompressedSize: false,
			// Generate complete source maps with original TypeScript sources
			sourcemap: true,
			// Ensure source maps are properly included in the build
			minify: mode === "production" ? "esbuild" : false,
			// Use a single combined CSS bundle so all webviews share styles
			cssCodeSplit: false,
			rollupOptions: {
				// Externalize vscode module - it's imported by file-search.ts which is
				// dynamically imported by roo-config/index.ts, but should never be bundled
				// in the webview since it's not available in the browser context
				external: ["vscode"],
				input: {
					index: resolve(__dirname, "index.html"),
				},
				output: {
					entryFileNames: `assets/[name].js`,
					chunkFileNames: (chunkInfo) => {
						if (chunkInfo.name === "mermaid-bundle") {
							return `assets/mermaid-bundle.js`
						}
						// Default naming for other chunks, ensuring uniqueness from entry
						return `assets/chunk-[hash].js`
					},
					assetFileNames: (assetInfo) => {
						const name = assetInfo.name || ""

						// Force all CSS into a single predictable file used by both webviews
						if (name.endsWith(".css")) {
							return "assets/index.css"
						}

						if (name.endsWith(".woff2") || name.endsWith(".woff") || name.endsWith(".ttf")) {
							return "assets/fonts/[name][extname]"
						}
						// Ensure source maps are included in the build
						if (name.endsWith(".map")) {
							return "assets/[name]"
						}
						return "assets/[name][extname]"
					},
					manualChunks: (id, { getModuleInfo }) => {
						// Consolidate all mermaid code and its direct large dependencies (like dagre)
						// into a single chunk. The 'channel.js' error often points to dagre.
						if (
							id.includes("node_modules/mermaid") ||
							id.includes("node_modules/dagre") || // dagre is a common dep for graph layout
							id.includes("node_modules/cytoscape") // another potential graph lib
							// Add other known large mermaid dependencies if identified
						) {
							return "mermaid-bundle"
						}

						// Check if the module is part of any explicitly defined mermaid-related dynamic import
						// This is a more advanced check if simple path matching isn't enough.
						const moduleInfo = getModuleInfo(id)
						if (moduleInfo?.importers.some((importer) => importer.includes("node_modules/mermaid"))) {
							return "mermaid-bundle"
						}
						if (
							moduleInfo?.dynamicImporters.some((importer) => importer.includes("node_modules/mermaid"))
						) {
							return "mermaid-bundle"
						}
					},
				},
			},
		},
		server: {
			hmr: {
				host: "localhost",
				protocol: "ws",
			},
			cors: {
				origin: "*",
				methods: "*",
				allowedHeaders: "*",
			},
		},
		define,
		optimizeDeps: {
			include: [
				"mermaid",
				// Mermaid pulls graph layout via `dagre-d3-es`, not a top-level `dagre` package.
			],
			exclude: ["@vscode/codicons", "vscode-oniguruma", "shiki"],
		},
		assetsInclude: ["**/*.wasm", "**/*.wav"],
	}
})
