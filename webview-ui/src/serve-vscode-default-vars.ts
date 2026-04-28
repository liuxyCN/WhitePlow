import { THEME_COLORS } from "virtual:serve-theme-colors"

/**
 * VS Code maps theme color keys `editor.background` → CSS custom property `--vscode-editor-background`
 * (segments joined with `-`).
 */
function themeColorKeyToCssVarName(key: string): string {
	return `--vscode-${key.split(".").join("-")}`
}

/**
 * Theme JSON does not define UI font tokens; workbench sets these separately in VS Code.
 */
const SERVE_FONT_FALLBACKS: Record<string, string> = {
	"vscode-font-family": "'Segoe WPC', 'Segoe UI', system-ui, sans-serif",
	"vscode-font-size": "18px",
}

/**
 * In VS Code, the webview host injects `--vscode-*` workbench theme variables on the document.
 * In `pnpm build:serve` / roo serve, load merged colors from the same default-themes JSON chain
 * as the extension (`light_modern.json` + includes), via Vite virtual module `virtual:serve-theme-colors`.
 */
export function applyServeModeVscodeCssVariableDefaults(): void {
	if (typeof document === "undefined") {
		return
	}
	const root = document.documentElement

	for (const [key, value] of Object.entries(SERVE_FONT_FALLBACKS)) {
		root.style.setProperty(`--${key}`, value)
	}

	for (const [themeKey, value] of Object.entries(THEME_COLORS)) {
		root.style.setProperty(themeColorKeyToCssVarName(themeKey), value)
	}
}
