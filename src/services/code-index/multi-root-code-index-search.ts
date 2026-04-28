import * as vscode from "vscode"
import path from "path"

import { CodeIndexManager } from "./manager"
import type { VectorStoreSearchResult } from "./interfaces"

/** How to apply optional `path` filter for one workspace root's index. */
export function directoryPrefixForSearchRoot(
	directoryPrefix: string | undefined,
	rootFsPath: string,
): { skip: boolean; prefix: string | undefined } {
	if (!directoryPrefix?.trim()) {
		return { skip: false, prefix: undefined }
	}
	const raw = directoryPrefix.trim()
	const root = path.normalize(rootFsPath)
	if (!path.isAbsolute(raw)) {
		return { skip: false, prefix: raw }
	}
	const abs = path.normalize(raw)
	if (abs === root) {
		return { skip: false, prefix: undefined }
	}
	const rel = path.relative(root, abs)
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return { skip: true, prefix: undefined }
	}
	return { skip: false, prefix: rel.replace(/\\/g, "/") }
}

export function resolveSearchWorkspaceFolders(workspacePath: string | undefined): vscode.WorkspaceFolder[] {
	const wf = vscode.workspace.workspaceFolders
	if (wf && wf.length > 0) {
		return [...wf]
	}
	const w = workspacePath?.trim()
	if (!w) {
		return []
	}
	return [{ uri: vscode.Uri.file(w), name: path.basename(w), index: 0 } as vscode.WorkspaceFolder]
}

export function dedupeSearchResultsByChunk(results: VectorStoreSearchResult[]): VectorStoreSearchResult[] {
	const best = new Map<string, VectorStoreSearchResult>()
	for (const r of results) {
		if (!r.payload || !("filePath" in r.payload)) {
			continue
		}
		const fp = (r.payload as { filePath: string }).filePath
		const startLine = (r.payload as { startLine: number }).startLine
		const endLine = (r.payload as { endLine: number }).endLine
		const key = `${fp}\0${startLine}\0${endLine}`
		const prev = best.get(key)
		if (!prev || r.score > prev.score) {
			best.set(key, r)
		}
	}
	return [...best.values()]
}

export type MergeSearchIndexAcrossWorkspaceRootsOptions = {
	/** When `workspace.workspaceFolders` is empty, build a single synthetic folder from this path. */
	workspacePathFallback: string | undefined
	query: string
	directoryPrefix?: string
}

export type MergeSearchIndexAcrossWorkspaceRootsResult = {
	results: VectorStoreSearchResult[]
	multiRoot: boolean
}

/**
 * Semantic code-index search across every workspace root (each `vec.bin`), merged like `codebase_search`.
 * Throws the same probe errors as the `codebase_search` tool when the feature is unavailable.
 * Throws the first search error if every attempted search failed and there are no hits.
 */
export async function mergeSearchIndexAcrossWorkspaceRoots(
	context: vscode.ExtensionContext,
	options: MergeSearchIndexAcrossWorkspaceRootsOptions,
): Promise<MergeSearchIndexAcrossWorkspaceRootsResult> {
	const { workspacePathFallback, query, directoryPrefix } = options
	const folders = resolveSearchWorkspaceFolders(workspacePathFallback)
	if (folders.length === 0) {
		throw new Error("No workspace folders available for search.")
	}

	const probe = CodeIndexManager.getInstance(context, folders[0]!.uri.fsPath)
	if (!probe) {
		throw new Error("CodeIndexManager is not available.")
	}
	if (!probe.isFeatureEnabled) {
		throw new Error("Code Indexing is disabled in the settings.")
	}
	if (!probe.isFeatureConfigured) {
		throw new Error(
			"Code Indexing is not configured (missing embedder credentials or vector database settings).",
		)
	}

	const maxMerged = probe.currentSearchMaxResults
	const multiRoot = folders.length > 1
	const searchErrors: Error[] = []
	const combined: VectorStoreSearchResult[] = []

	for (const folder of folders) {
		const { skip, prefix } = directoryPrefixForSearchRoot(directoryPrefix, folder.uri.fsPath)
		if (skip) {
			continue
		}

		const manager = CodeIndexManager.getInstance(context, folder.uri.fsPath)
		if (!manager?.isFeatureEnabled || !manager.isFeatureConfigured || !manager.isInitialized) {
			continue
		}

		const { systemStatus } = manager.getCurrentStatus()
		if (systemStatus !== "Indexed" && systemStatus !== "Indexing") {
			continue
		}

		try {
			const part = await manager.searchIndex(query, prefix)
			combined.push(...part)
		} catch (err) {
			searchErrors.push(err instanceof Error ? err : new Error(String(err)))
		}
	}

	const results = dedupeSearchResultsByChunk(combined)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxMerged)

	if (results.length === 0 && searchErrors.length > 0) {
		throw searchErrors[0]
	}

	return { results, multiRoot }
}
