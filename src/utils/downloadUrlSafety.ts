import dns from "node:dns/promises"
import net from "node:net"

/**
 * Maximum download size for download_file tool (200 MiB).
 */
export const DOWNLOAD_FILE_MAX_BYTES = 200 * 1024 * 1024

const MAX_REDIRECTS = 5

function parseIPv4ToUint32(ip: string): number | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
	if (!m) {
		return null
	}
	const octets = [m[1], m[2], m[3], m[4]].map((x) => Number(x))
	if (octets.some((n) => Number.isNaN(n) || n > 255)) {
		return null
	}
	return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function isIPv4PrivateOrBlocked(n: number): boolean {
	const a = n >>> 24
	const b = (n >>> 16) & 0xff
	if (a === 127) {
		return true
	}
	if (a === 10) {
		return true
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return true
	}
	if (a === 192 && b === 168) {
		return true
	}
	if (a === 169 && b === 254) {
		return true
	}
	if (a === 0) {
		return true
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return true
	}
	return false
}

function isIPv6Blocked(addr: string): boolean {
	const a = addr.toLowerCase()
	if (a === "::1") {
		return true
	}
	const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a)
	if (mapped) {
		const n = parseIPv4ToUint32(mapped[1])
		return n !== null && isIPv4PrivateOrBlocked(n)
	}
	const first = a.split(":")[0] ?? ""
	if (first.startsWith("fe8") || first.startsWith("fe9") || first.startsWith("fea") || first.startsWith("feb")) {
		return true
	}
	if (first.startsWith("fc") || first.startsWith("fd")) {
		return true
	}
	if (first.startsWith("ff")) {
		return true
	}
	return false
}

function assertAddressNotPrivate(address: string, family: 4 | 6): void {
	if (family === 4) {
		const n = parseIPv4ToUint32(address)
		if (n === null || isIPv4PrivateOrBlocked(n)) {
			throw new Error(`Download blocked: address "${address}" is not reachable (private or loopback network).`)
		}
		return
	}
	if (isIPv6Blocked(address)) {
		throw new Error(`Download blocked: address "${address}" is not reachable (private or loopback network).`)
	}
}

/**
 * Resolve hostname and ensure no resolved IP is private/loopback/link-local.
 */
export async function assertHostnameSafeForDownload(hostname: string): Promise<void> {
	const h = hostname.trim().toLowerCase()
	if (h === "localhost" || h.endsWith(".localhost")) {
		throw new Error("Download blocked: localhost is not allowed.")
	}
	if (h.endsWith(".local") || h.endsWith(".internal")) {
		throw new Error("Download blocked: local/internal hostnames are not allowed.")
	}

	if (net.isIPv4(h)) {
		assertAddressNotPrivate(h, 4)
		return
	}
	if (net.isIPv6(h)) {
		assertAddressNotPrivate(h, 6)
		return
	}

	const results = await dns.lookup(h, { all: true })
	for (const { address, family } of results) {
		assertAddressNotPrivate(address, family as 4 | 6)
	}
}

/**
 * Parse and validate an http(s) URL string for downloads (scheme + hostname safety).
 */
export async function resolveSafeHttpUrlForDownload(urlString: string): Promise<URL> {
	let u: URL
	try {
		u = new URL(urlString.trim())
	} catch {
		throw new Error("Invalid URL.")
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error("Only http and https URLs are allowed.")
	}
	if (!u.hostname) {
		throw new Error("URL is missing a hostname.")
	}
	await assertHostnameSafeForDownload(u.hostname)
	return u
}

/**
 * Follow redirects manually with SSRF checks on each hop.
 */
export async function fetchWithSsrfSafeRedirects(
	initialUrl: string,
	init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
	const { timeoutMs = 60_000, ...rest } = init
	const signal = rest.signal ?? AbortSignal.timeout(timeoutMs)

	let current = await resolveSafeHttpUrlForDownload(initialUrl)
	let redirects = 0

	for (;;) {
		const res = await fetch(current.href, {
			...rest,
			signal,
			redirect: "manual",
		})

		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location")
			if (!loc) {
				throw new Error(`Redirect response (${res.status}) missing Location header.`)
			}
			if (redirects >= MAX_REDIRECTS) {
				throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`)
			}
			redirects++
			const next = new URL(loc, current.href)
			current = await resolveSafeHttpUrlForDownload(next.href)
			continue
		}

		return res
	}
}
