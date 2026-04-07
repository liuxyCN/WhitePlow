import { z } from "zod"

/**
 * Global settings for workspace document → Markdown conversion (independent of codebase index).
 */
export const documentMarkdownConfigSchema = z.object({
	/** Master switch; when false, no conversion runs in any workspace. Omitted/true preserves legacy behavior. */
	documentMarkdownEnabled: z.boolean().optional(),
	/** Word/Excel/PowerPoint. Omitted defaults to true. */
	documentMarkdownConvertOffice: z.boolean().optional(),
	/** PDF. Omitted defaults to true. */
	documentMarkdownConvertPdf: z.boolean().optional(),
	/** JPG/JPEG/PNG via OCR. Omitted defaults to false. */
	documentMarkdownConvertImages: z.boolean().optional(),
})

export type DocumentMarkdownConfig = z.infer<typeof documentMarkdownConfigSchema>

export type DocumentMarkdownTypeFilters = { office: boolean; pdf: boolean; images: boolean }

/** Resolved type toggles: Office + PDF on by default; images off unless explicitly enabled. */
export function resolveDocumentMarkdownTypeOptions(
	cfg: DocumentMarkdownConfig | undefined | null,
): DocumentMarkdownTypeFilters {
	return {
		office: cfg?.documentMarkdownConvertOffice !== false,
		pdf: cfg?.documentMarkdownConvertPdf !== false,
		images: cfg?.documentMarkdownConvertImages === true,
	}
}
