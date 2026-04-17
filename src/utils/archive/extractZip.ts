import type { MakeDirectoryOptions } from "fs"
import { createWriteStream, promises as fsp } from "fs"
import path from "path"
import { pipeline } from "stream/promises"
import type { Readable } from "stream"
import { promisify } from "util"
import getStream from "get-stream"
import yauzl from "yauzl"
import type { Entry, ZipFile } from "yauzl"

import {
	EXTRACT_MAX_ENTRY_COUNT,
	EXTRACT_MAX_SINGLE_ENTRY_BYTES,
	EXTRACT_MAX_TOTAL_UNCOMPRESSED_BYTES,
} from "./extractLimits"
import { decodeZipEntryFileName } from "./zipFileNameDecode"

const openZip = promisify(yauzl.open) as (path: string, options: yauzl.Options) => Promise<ZipFile>

function openReadStream(zipfile: ZipFile, entry: Entry): Promise<Readable> {
	return new Promise((resolve, reject) => {
		zipfile.openReadStream(entry, (err, stream) => {
			if (err || !stream) {
				reject(err ?? new Error("openReadStream returned no stream"))
			} else {
				resolve(stream as Readable)
			}
		})
	})
}

function getExtractedMode(entryMode: number, isDir: boolean): number {
	const IFMT = 61440
	let mode = entryMode
	if (mode === 0) {
		if (isDir) {
			mode = 0o755
		} else {
			mode = 0o644
		}
	}
	return mode & 0o777
}

/**
 * Extract a .zip with yauzl using raw file name bytes and heuristic decoding (UTF-8 / GB18030 / CP437)
 * so Chinese Windows–created archives decode correctly.
 */
export async function extractZipWithLimits(zipPath: string, destDir: string): Promise<void> {
	if (!path.isAbsolute(destDir)) {
		throw new Error("extractZipWithLimits: destDir must be absolute")
	}

	await fsp.mkdir(destDir, { recursive: true })
	const realDest = await fsp.realpath(destDir)

	const zipfile = await openZip(zipPath, {
		lazyEntries: true,
		decodeStrings: false,
		strictFileNames: false,
	})

	let entryIndex = 0
	let totalDeclared = 0
	let canceled = false

	await new Promise<void>((resolve, reject) => {
		zipfile.on("error", (err) => {
			canceled = true
			reject(err)
		})

		zipfile.on("close", () => {
			if (!canceled) {
				resolve()
			}
		})

		zipfile.readEntry()

		zipfile.on("entry", (entry: Entry) => {
			void (async () => {
				if (canceled) {
					return
				}

				const fileName = decodeZipEntryFileName(entry)

				entryIndex++
				if (entryIndex > EXTRACT_MAX_ENTRY_COUNT) {
					throw new Error(
						`ZIP has too many entries (>${EXTRACT_MAX_ENTRY_COUNT}). Refusing to extract further.`,
					)
				}
				const size = entry.uncompressedSize
				if (size > EXTRACT_MAX_SINGLE_ENTRY_BYTES) {
					throw new Error(
						`ZIP entry "${fileName}" is too large (${size} bytes, max ${EXTRACT_MAX_SINGLE_ENTRY_BYTES}).`,
					)
				}
				totalDeclared += size
				if (totalDeclared > EXTRACT_MAX_TOTAL_UNCOMPRESSED_BYTES) {
					throw new Error(
						`ZIP total uncompressed size exceeds limit (${EXTRACT_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes).`,
					)
				}

				if (fileName.startsWith("__MACOSX/")) {
					zipfile.readEntry()
					return
				}

				const destDirPath = path.dirname(path.join(realDest, fileName))

				try {
					await fsp.mkdir(destDirPath, { recursive: true })
					const canonicalDestDir = await fsp.realpath(destDirPath)
					const relativeDestDir = path.relative(realDest, canonicalDestDir)
					if (relativeDestDir.split(path.sep).includes("..")) {
						throw new Error(
							`Out of bound path "${canonicalDestDir}" found while processing file ${fileName}`,
						)
					}

					const dest = path.join(realDest, fileName)

					const mode = (entry.externalFileAttributes >> 16) & 0xffff
					const IFMT = 61440
					const IFDIR = 16384
					const IFLNK = 40960
					const symlink = (mode & IFMT) === IFLNK
					let isDir = (mode & IFMT) === IFDIR
					if (!isDir && fileName.endsWith("/")) {
						isDir = true
					}
					const madeBy = entry.versionMadeBy >> 8
					if (!isDir) {
						isDir = madeBy === 0 && entry.externalFileAttributes === 16
					}

					const procMode = getExtractedMode(mode, isDir) & 0o777
					const mkdirFor = isDir ? dest : path.dirname(dest)
					const mkdirOptions: MakeDirectoryOptions = { recursive: true }
					if (isDir) {
						mkdirOptions.mode = procMode
					}
					await fsp.mkdir(mkdirFor, mkdirOptions)
					if (isDir) {
						zipfile.readEntry()
						return
					}

					const readStream = await openReadStream(zipfile, entry)
					if (symlink) {
						const link = await getStream(readStream)
						await fsp.symlink(link, dest)
					} else {
						await pipeline(readStream, createWriteStream(dest, { mode: procMode }))
					}

					zipfile.readEntry()
				} catch (err) {
					canceled = true
					zipfile.close()
					reject(err)
				}
			})().catch((err) => {
				canceled = true
				zipfile.close()
				reject(err)
			})
		})
	})
}
