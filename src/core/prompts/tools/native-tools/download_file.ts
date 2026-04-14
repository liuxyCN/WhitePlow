import type OpenAI from "openai"

const DOWNLOAD_FILE_DESCRIPTION = `Download a file from a public HTTP or HTTPS URL and save it to the **workspace root directory only** (not in subfolders).

Parameters:
- url: (required) The full http:// or https:// URL to download from.
- filename: (required) The destination file name only (e.g. "data.json" or "archive.zip"). Must be a single path segment: no slashes, no "..", and no subdirectories. The file will always be written as "<workspace_root>/<filename>".

Use this to fetch dependencies, assets, or datasets when the user expects a file in the project root. Maximum response size is about 200 MiB. Do not use it to probe internal networks; only public URLs the user intended.

Example: { "url": "https://example.com/schema.json", "filename": "schema.json" }`

const URL_PARAMETER_DESCRIPTION = `Full http or https URL to download`

const FILENAME_PARAMETER_DESCRIPTION = `File name only, saved under the workspace root (no paths or subdirectories)`

export default {
	type: "function",
	function: {
		name: "download_file",
		description: DOWNLOAD_FILE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: URL_PARAMETER_DESCRIPTION,
				},
				filename: {
					type: "string",
					description: FILENAME_PARAMETER_DESCRIPTION,
				},
			},
			required: ["url", "filename"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
