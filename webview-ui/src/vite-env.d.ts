/// <reference types="vite/client" />

declare module "virtual:serve-theme-colors" {
	/** Workbench color keys from theme JSON (`editor.background`, …), not yet `--vscode-*`. */
	export const THEME_COLORS: Record<string, string>
}
