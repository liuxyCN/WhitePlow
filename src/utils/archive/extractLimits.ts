/** Maximum on-disk size of the archive file before extraction. */
export const EXTRACT_MAX_ARCHIVE_FILE_BYTES = 500 * 1024 * 1024

/** Maximum total uncompressed size (sum of declared entry sizes where available). */
export const EXTRACT_MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024

/** Maximum number of archive entries to process. */
export const EXTRACT_MAX_ENTRY_COUNT = 50_000

/** Maximum declared size for a single entry. */
export const EXTRACT_MAX_SINGLE_ENTRY_BYTES = 200 * 1024 * 1024

/** Maximum files to register in file context after extraction. */
export const EXTRACT_MAX_TRACKED_FILES = 10_000
