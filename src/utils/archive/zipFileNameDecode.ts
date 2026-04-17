import crc32 from "buffer-crc32"
import iconv from "iconv-lite"
import type { Entry } from "yauzl"

/**
 * CP437 decode table (same mapping as yauzl) for legacy ZIP entries without UTF-8 flag.
 */
const CP437 =
	'\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0'

function decodeCp437(buf: Buffer): string {
	let result = ""
	for (let i = 0; i < buf.length; i++) {
		result += CP437[buf[i]!]!
	}
	return result
}

function isWellFormedUtf8(buf: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buf)
		return true
	} catch {
		return false
	}
}

/**
 * Info-ZIP Unicode Path Extra Field (0x7075): UTF-8 file name when CRC matches raw name field.
 */
function readInfoZipUnicodePath(
	fileNameBuffer: Buffer,
	extraFields: Array<{ id: number; data: Buffer }>,
): string | undefined {
	for (const extraField of extraFields) {
		if (extraField.id !== 0x7075 || extraField.data.length < 6) {
			continue
		}
		if (extraField.data.readUInt8(0) !== 1) {
			continue
		}
		const oldNameCrc32 = extraField.data.readUInt32LE(1)
		if (crc32.unsigned(fileNameBuffer) !== oldNameCrc32) {
			continue
		}
		return extraField.data.toString("utf8", 5)
	}
	return undefined
}

/**
 * Decode ZIP entry file name bytes.
 *
 * Order: UTF-8 EFS flag (PKZIP bit 11) → Info-ZIP Unicode path (0x7075) → well-formed UTF-8 without flag
 * → GB18030 (legacy Chinese Windows) → CP437 (legacy DOS).
 *
 * **macOS Finder “Compress” / Archive Utility:** filenames are almost always UTF-8. Recent macOS often sets
 * the UTF-8 flag; older or edge cases may omit it but still store UTF-8 bytes — the UTF-8-without-flag step
 * fixes that (previously yauzl/CP437 would mangle CJK to mojibake). APFS/HFS+ names may be NFD-normalized
 * but remain valid UTF-8.
 */
export function decodeZipEntryFileName(entry: Entry): string {
	const raw = entry.fileName
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "binary")

	const gpbf = entry.generalPurposeBitFlag
	if (gpbf & 0x800) {
		return buf.toString("utf8").replace(/\\/g, "/")
	}

	const fromUnicodeExtra = readInfoZipUnicodePath(buf, entry.extraFields)
	if (fromUnicodeExtra) {
		return fromUnicodeExtra.replace(/\\/g, "/")
	}

	if (isWellFormedUtf8(buf)) {
		return buf.toString("utf8").replace(/\\/g, "/")
	}

	try {
		const gb = iconv.decode(buf, "gb18030")
		if (gb.length > 0) {
			return gb.replace(/\\/g, "/")
		}
	} catch {
		// ignore
	}

	return decodeCp437(buf).replace(/\\/g, "/")
}
