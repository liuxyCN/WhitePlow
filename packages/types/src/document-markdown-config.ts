import { z } from "zod"

/**
 * Global settings for workspace document → Markdown conversion (independent of codebase index).
 */
export const documentMarkdownConfigSchema = z.object({
	/** Master switch; when false, no conversion runs in any workspace. Omitted/true preserves legacy behavior. */
	documentMarkdownEnabled: z.boolean().optional(),
})

export type DocumentMarkdownConfig = z.infer<typeof documentMarkdownConfigSchema>
