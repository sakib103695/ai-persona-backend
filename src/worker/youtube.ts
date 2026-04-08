/**
 * YouTube transcript extraction — uses innertube API + watch page scraping.
 * Supports:
 *   - YT_COOKIES env var: browser cookies for authenticated requests (bypasses bot detection)
 *   - YT_PROXY_URL env var: single proxy URL (legacy)
 *   - YT_PROXY_URLS env var: comma-separated proxy pool, rotated round-robin per request
 */
import { createHash } from 'crypto'

/* ── Proxy pool with round-robin rotation ──────────────────────────────────── */
//
// IMPORTANT: we use undici's own `fetch` (not Node's global fetch). Node ships
// with a built-in copy of undici, but a userland `require('undici')` returns a
// SEPARATE instance. A ProxyAgent from userland undici is not compatible with
// the global fetch's dispatcher — you get silent "fetch failed" errors. Using
// undici's fetch + ProxyAgent from the same module avoids this trap.

let _undiciFetch: typeof fetch | null = null
let _proxyAgents: any[] = []
let _proxyLabels: string[] = []
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

  const pool = (process.env.YT_PROXY_URLS || process.env.YT_PROXY_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (pool.length === 0) {
    console.log(`[youtube] No proxies configured — using direct connections`)
    return
  }

  for (const url of pool) {
    try {
      _proxyAgents.push(new undici.ProxyAgent(url))
      _proxyLabels.push(url.replace(/\/\/([^@]+)@/, '//***@'))
    } catch (e) {
      console.error(`[youtube] Failed to create proxy agent for ${url}:`, e)
    }
  }

  console.log(`[youtube] Proxy pool initialized with ${_proxyAgents.length} proxies`)
}

function nextProxyAgent(): { agent: any; label: string } | null {
  if (_proxyAgents.length === 0) return null
  const i = _proxyCursor++ % _proxyAgents.length
  return { agent: _proxyAgents[i], label: _proxyLabels[i] }
}

async function ytFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  initProxyPool()
  const picked = nextProxyAgent()
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

export async function getVideoTranscript(
  videoId: string,
): Promise<TranscriptResult> {
  // Cookies are optional. With a clean residential proxy, no cookies works
  // best (sending the default consent cookie triggers LOGIN_REQUIRED).

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
