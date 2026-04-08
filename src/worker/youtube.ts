/**
 * YouTube transcript extraction.
 *
 * Transcript fetching uses yt-dlp (shelled out via child_process). Direct HTTP
 * fetching of the captions endpoint is silently blocked by YouTube even from
 * residential IPs (200 OK with 0-byte body). yt-dlp uses alternate client
 * identities (Android VR, iOS, etc.) and signature deciphering to work around
 * this — and it's actively maintained against YouTube's evolving defenses.
 *
 * Channel listing still uses our own innertube/HTML scraping because that
 * endpoint isn't bot-protected.
 *
 * Env vars:
 *   - YT_PROXY_URL: single proxy URL (legacy)
 *   - YT_PROXY_URLS: comma-separated proxy pool, rotated round-robin
 *   - YT_COOKIES: browser cookies (optional, generally not needed with proxies)
 */
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execFileP = promisify(execFile)

/* ── Proxy pool with round-robin rotation ──────────────────────────────────── */
//
// IMPORTANT: we use undici's own `fetch` (not Node's global fetch). Node ships
// with a built-in copy of undici, but a userland `require('undici')` returns a
// SEPARATE instance. A ProxyAgent from userland undici is not compatible with
// the global fetch's dispatcher — you get silent "fetch failed" errors. Using
// undici's fetch + ProxyAgent from the same module avoids this trap.

interface ProxyEntry {
  agent: any
  url: string // raw URL with credentials, used by yt-dlp
  label: string // masked URL for logging
  exhausted: boolean // marked true after a TRAFFIC_EXHAUSTED / 407 response
}

let _undiciFetch: typeof fetch | null = null
let _proxyPool: ProxyEntry[] = []
let _proxyInited = false
let _proxyCursor = 0

function initProxyPool() {
  if (_proxyInited) return
  _proxyInited = true

  let undici: any
  try {
    undici = require('undici')
    _undiciFetch = undici.fetch
  } catch (e) {
    console.error(`[youtube] Failed to load undici:`, e)
    return
  }

  // Toggle to bypass the proxy without removing YT_PROXY_URLS from .env.
  // Useful for testing whether direct connections work (yt-dlp's Android VR
  // path often succeeds from datacenter IPs that the WEB endpoint blocks).
  const disabled = ['1', 'true', 'yes'].includes(
    (process.env.YT_DISABLE_PROXY || '').toLowerCase(),
  )
  if (disabled) {
    console.log(`[youtube] YT_DISABLE_PROXY set — using direct connections`)
    return
  }

  const urls = (process.env.YT_PROXY_URLS || process.env.YT_PROXY_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (urls.length === 0) {
    console.log(`[youtube] No proxies configured — using direct connections`)
    return
  }

  for (const url of urls) {
    try {
      _proxyPool.push({
        agent: new undici.ProxyAgent(url),
        url,
        label: url.replace(/\/\/([^@]+)@/, '//***@'),
        exhausted: false,
      })
    } catch (e) {
      console.error(`[youtube] Failed to create proxy agent for ${url}:`, e)
    }
  }

  console.log(`[youtube] Proxy pool initialized with ${_proxyPool.length} proxies`)
}

function nextProxy(): ProxyEntry | null {
  initProxyPool()
  if (_proxyPool.length === 0) return null

  // Skip exhausted proxies. Try at most pool.length entries before giving up.
  for (let attempts = 0; attempts < _proxyPool.length; attempts++) {
    const entry = _proxyPool[_proxyCursor++ % _proxyPool.length]
    if (!entry.exhausted) return entry
  }

  console.log(`[youtube] All ${_proxyPool.length} proxies exhausted — using direct connection`)
  return null
}

function markProxyExhausted(entry: ProxyEntry) {
  if (entry.exhausted) return
  entry.exhausted = true
  const remaining = _proxyPool.filter((p) => !p.exhausted).length
  console.log(
    `[youtube] Proxy ${entry.label} marked exhausted (${remaining}/${_proxyPool.length} remaining)`,
  )
}

async function ytFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const picked = nextProxy()
  const opts: any = { ...init }
  if (picked) opts.dispatcher = picked.agent
  // Use undici's fetch (not Node global) so the dispatcher is honored
  const f = _undiciFetch || fetch
  return f(url, opts) as Promise<Response>
}

/* ── Cookie auth ───────────────────────────────────────────────────────────── */

function getYtCookies(): string {
  // IMPORTANT: do NOT return a default "CONSENT=PENDING" cookie. That tells
  // YouTube the user hasn't accepted the consent banner yet, which forces a
  // consent-flow redirect and triggers LOGIN_REQUIRED bot challenges. Sending
  // no cookies at all is treated as a clean anonymous visitor and works fine.
  return process.env.YT_COOKIES || ''
}

function extractCookieValue(name: string): string | null {
  const cookies = getYtCookies()
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : null
}

/**
 * Generate SAPISIDHASH for authenticated YouTube API requests.
 * Required when using logged-in cookies with innertube API.
 */
function getSapisidHash(origin = 'https://www.youtube.com'): string | null {
  const sapisid = extractCookieValue('SAPISID') || extractCookieValue('__Secure-3PAPISID')
  if (!sapisid) return null
  const timestamp = Math.floor(Date.now() / 1000)
  const input = `${timestamp} ${sapisid} ${origin}`
  const hash = createHash('sha1').update(input).digest('hex')
  return `SAPISIDHASH ${timestamp}_${hash}`
}

/* ── Constants ─────────────────────────────────────────────────────────────── */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function getBrowserHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }
  const cookies = getYtCookies()
  if (cookies) headers.Cookie = cookies
  const sapisid = getSapisidHash()
  if (sapisid) {
    headers['Authorization'] = sapisid
    headers['X-Origin'] = 'https://www.youtube.com'
  }
  return headers
}

function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getBrowserHeaders(),
  }
  return headers
}

const ANDROID_UA = 'com.google.android.youtube/19.29.37 (Linux; U; Android 14)'
const ANDROID_CONTEXT = {
  client: {
    clientName: 'ANDROID',
    clientVersion: '19.29.37',
    androidSdkVersion: 34,
  },
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function extractJson(html: string, varName: string): any {
  const patterns = [
    new RegExp(`var\\s+${varName}\\s*=\\s*`, 's'),
    new RegExp(`${varName}\\s*=\\s*`, 's'),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (!match) continue
    const startIdx = match.index! + match[0].length
    let depth = 0
    let inString = false
    let escape = false
    for (let i = startIdx; i < html.length; i++) {
      const ch = html[i]
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{' || ch === '[') depth++
      if (ch === '}' || ch === ']') depth--
      if (depth === 0) {
        try { return JSON.parse(html.substring(startIdx, i + 1)) } catch { break }
      }
    }
  }
  return null
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10)),
    )
}

function parseCaptionXml(xml: string): string[] {
  const segments: string[] = []

  // New format: <p t="..." d="..."><s>word</s>...</p>
  const pRegex = /<p\s+t="\d+"\s+d="\d+"[^>]*>([\s\S]*?)<\/p>/g
  let pMatch: RegExpExecArray | null
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const inner = pMatch[1]
    let text = ''
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g
    let sMatch: RegExpExecArray | null
    while ((sMatch = sRegex.exec(inner)) !== null) text += sMatch[1]
    if (!text) text = inner.replace(/<[^>]+>/g, '')
    text = decodeEntities(text).trim()
    if (text) segments.push(text)
  }

  // Legacy format
  if (segments.length === 0) {
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g
    let tMatch: RegExpExecArray | null
    while ((tMatch = textRegex.exec(xml)) !== null) {
      const text = decodeEntities(tMatch[1].replace(/<[^>]+>/g, ''))
        .replace(/\n/g, ' ')
        .trim()
      if (text) segments.push(text)
    }
  }

  return segments
}

function selectBestTrack(captions: any[]): any {
  return (
    captions.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ||
    captions.find((t: any) => t.languageCode === 'en') ||
    captions.find((t: any) => t.kind !== 'asr') ||
    captions[0]
  )
}

async function fetchCaptionText(
  track: any,
  ua?: string,
): Promise<TranscriptResult | null> {
  const headers: Record<string, string> = {
    'User-Agent': ua || BROWSER_UA,
  }
  const cookies = getYtCookies()
  if (cookies) headers.Cookie = cookies
  const captionRes = await ytFetch(track.baseUrl, { headers })
  if (!captionRes.ok) return null

  const xml = await captionRes.text()
  const segments = parseCaptionXml(xml)
  if (segments.length === 0) return null

  return {
    text: segments.join(' '),
    language: track.languageCode,
    type: track.kind === 'asr' ? 'auto-generated' : 'manual',
  }
}

/* ── Channel video listing ─────────────────────────────────────────────────── */

export interface VideoMeta {
  id: string
  title: string
}

export interface ChannelResult {
  videos: VideoMeta[]
  avatar_url: string | null
}

function extractAvatarUrl(data: any): string | null {
  // Channel avatar is in header: c4TabbedHeaderRenderer or pageHeaderRenderer
  try {
    const header =
      data?.header?.c4TabbedHeaderRenderer ||
      data?.header?.pageHeaderRenderer
    const thumbs =
      header?.avatar?.thumbnails ||
      header?.content?.pageHeaderViewModel?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources
    if (thumbs?.length) {
      // Pick the largest thumbnail
      const sorted = [...thumbs].sort((a: any, b: any) => (b.width || 0) - (a.width || 0))
      const url: string = sorted[0].url
      // Strip size params to get full resolution
      return url.replace(/=s\d+.*$/, '=s800-c-k-c0x00ffffff-no-rj')
    }
  } catch {}
  return null
}

export async function getChannelVideoIds(
  channelUrl: string,
  limit = 0,
): Promise<ChannelResult> {
  let url = channelUrl.replace(/\/$/, '')
  if (!url.includes('/videos')) url += '/videos'

  const res = await ytFetch(url, { headers: getBrowserHeaders() })
  if (!res.ok) throw new Error(`Failed to fetch channel: ${res.status}`)

  const html = await res.text()
  const data = extractJson(html, 'ytInitialData')
  if (!data) throw new Error('Could not extract ytInitialData')

  const avatar_url = extractAvatarUrl(data)

  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
  const apiKey =
    apiKeyMatch?.[1] || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
  const clientVersionMatch = html.match(/"clientVersion":"([^"]+)"/)
  const clientVersion = clientVersionMatch?.[1] || '2.20260101.00.00'

  const videoIds: VideoMeta[] = []
  const seen = new Set<string>()

  function findVideos(obj: any) {
    if (!obj || typeof obj !== 'object') return
    if (obj.videoId && !seen.has(obj.videoId)) {
      seen.add(obj.videoId)
      videoIds.push({
        id: obj.videoId,
        title:
          obj.title?.runs?.[0]?.text || obj.title?.simpleText || 'Unknown',
      })
    }
    if (Array.isArray(obj)) obj.forEach(findVideos)
    else Object.values(obj).forEach(findVideos)
  }

  function findContinuation(obj: any): string | null {
    if (!obj || typeof obj !== 'object') return null
    if (obj.continuationCommand?.token) return obj.continuationCommand.token
    if (obj.token && obj.continuationEndpoint) return obj.token
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const result = findContinuation(item)
        if (result) return result
      }
    } else {
      for (const val of Object.values(obj)) {
        const result = findContinuation(val)
        if (result) return result
      }
    }
    return null
  }

  findVideos(data)
  let continuation = findContinuation(data)

  while (continuation && (limit === 0 || videoIds.length < limit)) {
    const browseRes = await ytFetch(
      `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
      {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: clientVersion,
              hl: 'en',
              gl: 'US',
            },
          },
          continuation,
        }),
      },
    )

    if (!browseRes.ok) break

    const browseData = await browseRes.json()
    const prevCount = videoIds.length
    findVideos(browseData)
    continuation = findContinuation(browseData)

    if (videoIds.length === prevCount) break

    console.log(
      `[channel-scrape] Paginated: ${videoIds.length} videos so far`,
    )
  }

  const filtered = videoIds.filter(
    (v) => v.id.length === 11 && /^[a-zA-Z0-9_-]+$/.test(v.id),
  )
  return { videos: limit > 0 ? filtered.slice(0, limit) : filtered, avatar_url }
}

/* ── Transcript extraction ─────────────────────────────────────────────────── */

export interface TranscriptResult {
  text?: string
  language?: string
  type?: string
  error?: string
}

/**
 * Attempt innertube /player API with a given client config.
 * Returns captions from the player response, or null if unavailable.
 */
async function tryInnertubePlayer(
  videoId: string,
  clientConfig: {
    context: any
    headers: Record<string, string>
    label: string
  },
): Promise<TranscriptResult | null> {
  const playerRes = await ytFetch(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      headers: clientConfig.headers,
      body: JSON.stringify({ context: clientConfig.context, videoId }),
    },
  )

  if (!playerRes.ok) {
    console.log(
      `[transcript] ${clientConfig.label}: HTTP ${playerRes.status}`,
    )
    return null
  }

  const playerData = (await playerRes.json()) as any
  const playability = playerData?.playabilityStatus?.status
  if (playability !== 'OK') {
    const reason =
      playerData?.playabilityStatus?.reason ||
      playerData?.playabilityStatus?.messages?.[0] ||
      'unknown'
    console.log(
      `[transcript] ${clientConfig.label}: playability=${playability} reason=${reason}`,
    )
    return null
  }

  const captions =
    playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  if (!captions?.length) {
    console.log(`[transcript] ${clientConfig.label}: no caption tracks`)
    return null
  }

  const track = selectBestTrack(captions)
  const ua =
    clientConfig.headers['User-Agent'] || BROWSER_UA
  return fetchCaptionText(track, ua)
}

/* ── yt-dlp transcript path ────────────────────────────────────────────────── */

/**
 * Strip VTT formatting and return plain text. Auto-generated captions repeat
 * each line for the rolling display effect, so we deduplicate consecutive
 * identical segments.
 */
function parseVtt(vtt: string): string {
  const segments: string[] = []
  let last = ''
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('WEBVTT')) continue
    if (line.startsWith('Kind:') || line.startsWith('Language:')) continue
    if (line.startsWith('NOTE')) continue
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(line)) continue
    if (/^\d+$/.test(line)) continue // numeric cue identifiers

    // Strip inline timing tags <00:00:19.039>, color tags <c>...</c>, any other
    let text = line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
    text = text.replace(/<\/?c[^>]*>/g, '')
    text = text.replace(/<[^>]+>/g, '')
    text = decodeEntities(text).trim()

    if (!text || text === last) continue
    segments.push(text)
    last = text
  }
  return segments.join(' ')
}

/**
 * Run yt-dlp to fetch the captions for a video. Uses a proxy from the pool if
 * one is configured. Returns null on failure (caller falls back to other
 * methods or marks the video as failed).
 */
async function getTranscriptViaYtDlp(
  videoId: string,
): Promise<TranscriptResult | null> {
  const proxy = nextProxy()
  let workDir: string | null = null
  try {
    workDir = await mkdtemp(join(tmpdir(), 'ytdlp-'))
    const outputTemplate = join(workDir, '%(id)s.%(ext)s')

    const args: string[] = []
    if (proxy) args.push('--proxy', proxy.url)
    args.push(
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', 'en.*,en',
      '--sub-format', 'vtt',
      '--no-warnings',
      '--no-playlist',
      '--no-progress',
      '-o', outputTemplate,
      `https://www.youtube.com/watch?v=${videoId}`,
    )

    const { stderr } = await execFileP('yt-dlp', args, {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    })

    // yt-dlp may "succeed" overall but still log proxy exhaustion in stderr.
    if (proxy && /TRAFFIC_EXHAUSTED|407/.test(stderr || '')) {
      markProxyExhausted(proxy)
    }

    // yt-dlp writes <id>.<lang>.vtt — find whichever language landed
    const fs = await import('fs/promises')
    const files = await fs.readdir(workDir)
    const vttFile = files.find((f) => f.endsWith('.vtt'))
    if (!vttFile) {
      console.log(`[transcript] yt-dlp ${videoId}: no VTT file produced`)
      return null
    }

    const vtt = await readFile(join(workDir, vttFile), 'utf-8')
    const text = parseVtt(vtt)
    if (!text) {
      console.log(`[transcript] yt-dlp ${videoId}: VTT parsed empty`)
      return null
    }

    // Filename like dQw4w9WgXcQ.en.vtt → "en"
    const langMatch = vttFile.match(/\.([a-zA-Z-]+)\.vtt$/)
    return {
      text,
      language: langMatch?.[1] || 'en',
      type: 'auto-generated',
    }
  } catch (e: any) {
    const fullMsg = (e?.stderr || e?.message || '').toString()
    if (proxy && /TRAFFIC_EXHAUSTED|407/.test(fullMsg)) {
      markProxyExhausted(proxy)
    }
    console.log(`[transcript] yt-dlp ${videoId} failed: ${fullMsg.slice(0, 300)}`)
    return null
  } finally {
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true })
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}

export async function getVideoTranscript(
  videoId: string,
): Promise<TranscriptResult> {
  // ── Primary: yt-dlp ──────────────────────────────────────────────────────
  // yt-dlp uses alternate client identities (Android VR, etc.) and signature
  // deciphering to bypass the bot detection that blocks our raw HTTP path.
  const ytdlpResult = await getTranscriptViaYtDlp(videoId)
  if (ytdlpResult) {
    console.log(`[transcript] ✅ ${videoId} via yt-dlp`)
    return ytdlpResult
  }

  // ── Fallback methods (rarely succeed in 2026, but kept as safety net) ────

  // ── Method 1: Scrape watch page ──────────────────────────────────────────
  try {
    const watchRes = await ytFetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      { headers: getBrowserHeaders() },
    )
    if (watchRes.ok) {
      const html = await watchRes.text()

      const visitorData = html.match(/"visitorData":"([^"]+)"/)?.[1] || ''
      const pageApiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || ''
      const pageClientVersion =
        html.match(/"clientVersion":"([^"]+)"/)?.[1] || '2.20260101.00.00'

      const playerData = extractJson(html, 'ytInitialPlayerResponse')
      if (playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
        const captions = playerData.captions.playerCaptionsTracklistRenderer.captionTracks
        const track = selectBestTrack(captions)
        const result = await fetchCaptionText(track)
        if (result) {
          console.log(`[transcript] ✅ ${videoId} via watch page inline`)
          return result
        }
      } else {
        const playability = playerData?.playabilityStatus?.status
        console.log(`[transcript] Watch page: no inline captions (playability=${playability || 'missing'})`)
      }

      // Try innertube with session context from the page
      if (visitorData || pageApiKey) {
        const sessionHeaders = getApiHeaders()
        if (visitorData) sessionHeaders['X-Goog-Visitor-Id'] = visitorData

        const sessionResult = await tryInnertubePlayer(videoId, {
          label: 'WEB+session',
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: pageClientVersion,
              hl: 'en',
              gl: 'US',
              visitorData,
            },
          },
          headers: sessionHeaders,
        })
        if (sessionResult) {
          console.log(`[transcript] ✅ ${videoId} via WEB+session innertube`)
          return sessionResult
        }
      }
    } else {
      console.log(`[transcript] Watch page: HTTP ${watchRes.status}`)
    }
  } catch (e: any) {
    console.log(`[transcript] Watch page failed for ${videoId}: ${e.message}`)
  }

  // ── Method 2: WEB innertube (stateless) ──────────────────────────────────
  try {
    const result = await tryInnertubePlayer(videoId, {
      label: 'WEB',
      context: {
        client: { clientName: 'WEB', clientVersion: '2.20260101.00.00', hl: 'en', gl: 'US' },
      },
      headers: getApiHeaders(),
    })
    if (result) {
      console.log(`[transcript] ✅ ${videoId} via WEB innertube`)
      return result
    }
  } catch (e: any) {
    console.log(`[transcript] WEB innertube failed for ${videoId}: ${e.message}`)
  }

  // ── Method 3: ANDROID innertube ──────────────────────────────────────────
  try {
    const result = await tryInnertubePlayer(videoId, {
      label: 'ANDROID',
      context: ANDROID_CONTEXT,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ANDROID_UA,
        Cookie: getYtCookies(),
      },
    })
    if (result) {
      console.log(`[transcript] ✅ ${videoId} via ANDROID innertube`)
      return result
    }
  } catch (e: any) {
    console.log(`[transcript] ANDROID innertube failed for ${videoId}: ${e.message}`)
  }

  return { error: 'Video not playable: all transcript methods failed' }
}
