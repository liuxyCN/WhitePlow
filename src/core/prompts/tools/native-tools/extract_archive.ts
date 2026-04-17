import type OpenAI from "openai"

const EXTRACT_ARCHIVE_DESCRIPTION = `Extract an archive file inside the workspace into a destination folder (also under the workspace).

Supported formats:
- .zip — extracted in-process (handles UTF-8 file names from macOS Finder “Compress”, Windows, etc.; legacy encodings are heuristically decoded).
- .tar, .tar.gz, .tgz — extracted in-process.
- .rar — requires a system tool on PATH (e.g. unar, unrar, or 7z/7zz). If none is installed, extraction fails with a clear error.

Parameters:
- archive_path: (required) Path to the archive relative to the workspace root (e.g. "deps/lib.zip" or "release/app.tar.gz").
- destination_path: (required) Folder to extract into, relative to the workspace root. The directory will be created if needed. Must not escape the workspace (no ".." segments that leave the workspace).

Security: Very large archives or excessive entry counts are rejected. Symbolic links inside .tar are skipped. ZIP extraction uses path checks to prevent zip-slip.

Example: { "archive_path": "vendor/sdk.zip", "destination_path": "vendor/sdk" }`

const ARCHIVE_PATH_DESCRIPTION = `Path to the archive file, relative to the workspace root`

const DESTINATION_PATH_DESCRIPTION = `Directory to extract into, relative to the workspace root (created if missing)`

export default {
	type: "function",
	function: {
		name: "extract_archive",
		description: EXTRACT_ARCHIVE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				archive_path: {
					type: "string",
					description: ARCHIVE_PATH_DESCRIPTION,
				},
				destination_path: {
					type: "string",
					description: DESTINATION_PATH_DESCRIPTION,
				},
			},
			required: ["archive_path", "destination_path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
