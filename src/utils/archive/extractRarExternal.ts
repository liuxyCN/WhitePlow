import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const RAR_EXTRACT_TIMEOUT_MS = 300_000
const RAR_MAX_BUFFER = 16 * 1024 * 1024

type RarBackend = "unar" | "unrar" | "7z"

async function tryExec(cmd: string, args: string[]): Promise<void> {
	await execFileAsync(cmd, args, {
		timeout: RAR_EXTRACT_TIMEOUT_MS,
		maxBuffer: RAR_MAX_BUFFER,
		windowsHide: true,
	})
}

/**
 * Extract .rar using a system tool from PATH (no bundled binary).
 * Tries: unar, unrar, 7zz/7z in order.
 */
export async function extractRarWithExternalTool(archiveAbs: string, destAbs: string): Promise<RarBackend> {
	const attempts: Array<{ name: RarBackend; cmd: string; args: string[] }> = [
		{ name: "unar", cmd: "unar", args: ["-o", destAbs, "-f", archiveAbs] },
		{ name: "unrar", cmd: "unrar", args: ["x", "-o+", "-y", archiveAbs, destAbs] },
		{ name: "7z", cmd: "7zz", args: ["x", "-y", `-o${destAbs}`, archiveAbs] },
		{ name: "7z", cmd: "7z", args: ["x", "-y", `-o${destAbs}`, archiveAbs] },
	]

	let lastErr: Error | undefined
	for (const a of attempts) {
		try {
			await tryExec(a.cmd, a.args)
			return a.name
		} catch (e) {
			const err = e as NodeJS.ErrnoException
			lastErr = err instanceof Error ? err : new Error(String(e))
			if (err.code === "ENOENT") {
				continue
			}
			throw lastErr
		}
	}

	throw new Error(
		"Could not extract RAR: no supported tool found in PATH (tried unar, unrar, 7zz, 7z). " +
			"Install one of them or extract on the host manually.",
	)
}
