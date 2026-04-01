/**
 * YouTube transcript extraction — uses innertube API + watch page scraping.
 * Supports proxy via YT_PROXY_URL environment variable (needed for datacenter IPs).
 */

/* ── Proxy support ─────────────────────────────────────────────────────────── */

let _proxyAgent: any = null
let _proxyInited = false

function getProxyAgent() {
  if (_proxyInited) return _proxyAgent
  _proxyInited = true
  const url = process.env.YT_PROXY_URL
  if (!url) return null
  try {
    // undici is built into Node.js 18+ (ships with the runtime)
    const { ProxyAgent } = require('undici')
    _proxyAgent = new ProxyAgent(url)
    console.log(`[youtube] Using proxy: ${url.replace(/\/\/([^@]+)@/, '//***@')}`)
  } catch (e) {
    console.error(`[youtube] Failed to create proxy agent:`, e)
  }
  return _proxyAgent
}

async function ytFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const agent = getProxyAgent()
  const opts: any = { ...init }
  if (agent) opts.dispatcher = agent
  return fetch(url, opts)
}

/* ── Constants ─────────────────────────────────────────────────────────────── */

const CONSENT_COOKIES =
  'CONSENT=PENDING+987; SOCS=CAESEwgDEgk2NjU5MjUyNjkaBgiArKu1Bg'

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Cookie: CONSENT_COOKIES,
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
    'User-Agent': ua || BROWSER_HEADERS['User-Agent'],
    Cookie: CONSENT_COOKIES,
  }
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

export async function getChannelVideoIds(
  channelUrl: string,
  limit = 0,
): Promise<VideoMeta[]> {
  let url = channelUrl.replace(/\/$/, '')
  if (!url.includes('/videos')) url += '/videos'

  const res = await ytFetch(url, { headers: BROWSER_HEADERS })
  if (!res.ok) throw new Error(`Failed to fetch channel: ${res.status}`)

  const html = await res.text()
  const data = extractJson(html, 'ytInitialData')
  if (!data) throw new Error('Could not extract ytInitialData')

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
        headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
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
  return limit > 0 ? filtered.slice(0, limit) : filtered
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
    clientConfig.headers['User-Agent'] || BROWSER_HEADERS['User-Agent']
  return fetchCaptionText(track, ua)
}

export async function getVideoTranscript(
  videoId: string,
): Promise<TranscriptResult> {
  // ── Method 1: Scrape watch page ──────────────────────────────────────────
  // This is the most reliable method — it gets the full page with embedded
  // player data, and the consent cookies help bypass EU consent screens.
  try {
    const watchRes = await ytFetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      { headers: BROWSER_HEADERS },
    )
    if (watchRes.ok) {
      const html = await watchRes.text()

      // Extract session data for later API calls
      const visitorData =
        html.match(/"visitorData":"([^"]+)"/)?.[1] || ''
      const pageApiKey =
        html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] || ''
      const pageClientVersion =
        html.match(/"clientVersion":"([^"]+)"/)?.[1] || '2.20260101.00.00'

      // Try getting captions from inline player data
      const playerData = extractJson(html, 'ytInitialPlayerResponse')
      if (playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
        const captions =
          playerData.captions.playerCaptionsTracklistRenderer.captionTracks
        const track = selectBestTrack(captions)
        const result = await fetchCaptionText(track)
        if (result) {
          console.log(`[transcript] ✅ ${videoId} via watch page inline`)
          return result
        }
      } else {
        const playability = playerData?.playabilityStatus?.status
        console.log(
          `[transcript] Watch page: no inline captions (playability=${playability || 'missing'})`,
        )
      }

      // Try innertube API with session data from the page (visitorData helps)
      if (visitorData || pageApiKey) {
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
          headers: {
            'Content-Type': 'application/json',
            ...BROWSER_HEADERS,
            ...(visitorData
              ? { 'X-Goog-Visitor-Id': visitorData }
              : {}),
          },
        })
        if (sessionResult) {
          console.log(
            `[transcript] ✅ ${videoId} via WEB+session innertube`,
          )
          return sessionResult
        }
      }
    } else {
      console.log(
        `[transcript] Watch page: HTTP ${watchRes.status}`,
      )
    }
  } catch (e: any) {
    console.log(
      `[transcript] Watch page method failed for ${videoId}: ${e.message}`,
    )
  }

  // ── Method 2: WEB innertube (stateless) ──────────────────────────────────
  try {
    const result = await tryInnertubePlayer(videoId, {
      label: 'WEB',
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20260101.00.00',
          hl: 'en',
          gl: 'US',
        },
      },
      headers: {
        'Content-Type': 'application/json',
        ...BROWSER_HEADERS,
      },
    })
    if (result) {
      console.log(`[transcript] ✅ ${videoId} via WEB innertube`)
      return result
    }
  } catch (e: any) {
    console.log(
      `[transcript] WEB innertube failed for ${videoId}: ${e.message}`,
    )
  }

  // ── Method 3: ANDROID innertube ──────────────────────────────────────────
  try {
    const result = await tryInnertubePlayer(videoId, {
      label: 'ANDROID',
      context: ANDROID_CONTEXT,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ANDROID_UA,
        Cookie: CONSENT_COOKIES,
      },
    })
    if (result) {
      console.log(`[transcript] ✅ ${videoId} via ANDROID innertube`)
      return result
    }
  } catch (e: any) {
    console.log(
      `[transcript] ANDROID innertube failed for ${videoId}: ${e.message}`,
    )
  }

  // ── Method 4: Embedded player client ─────────────────────────────────────
  // TVHTML5_SIMPLY_EMBEDDED_PLAYER sometimes bypasses datacenter IP blocks
  try {
    const result = await tryInnertubePlayer(videoId, {
      label: 'TVHTML5_EMBEDDED',
      context: {
        client: {
          clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
          clientVersion: '2.0',
        },
        thirdParty: { embedUrl: 'https://www.youtube.com' },
      },
      headers: {
        'Content-Type': 'application/json',
        ...BROWSER_HEADERS,
      },
    })
    if (result) {
      console.log(
        `[transcript] ✅ ${videoId} via TVHTML5_EMBEDDED innertube`,
      )
      return result
    }
  } catch (e: any) {
    console.log(
      `[transcript] TVHTML5_EMBEDDED failed for ${videoId}: ${e.message}`,
    )
  }

  return { error: 'Video not playable: all transcript methods failed' }
}
