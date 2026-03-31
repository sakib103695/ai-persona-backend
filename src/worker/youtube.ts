/**
 * YouTube transcript extraction — ported from yt-transcript-extractor/index.js
 * Uses Android innertube API to bypass PoToken requirement.
 */

const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'
const ANDROID_CONTEXT = {
  client: { clientName: 'ANDROID', clientVersion: '20.10.38' },
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
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
      const text = decodeEntities(tMatch[1].replace(/<[^>]+>/g, '')).replace(/\n/g, ' ').trim()
      if (text) segments.push(text)
    }
  }

  return segments
}

export interface VideoMeta {
  id: string
  title: string
}

export async function getChannelVideoIds(channelUrl: string): Promise<VideoMeta[]> {
  let url = channelUrl.replace(/\/$/, '')
  if (!url.includes('/videos')) url += '/videos'

  const res = await fetch(url, { headers: BROWSER_HEADERS })
  if (!res.ok) throw new Error(`Failed to fetch channel: ${res.status}`)

  const html = await res.text()
  const data = extractJson(html, 'ytInitialData')
  if (!data) throw new Error('Could not extract ytInitialData')

  // Extract API key and client context for continuation requests
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
  const apiKey = apiKeyMatch?.[1] || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
  const clientVersionMatch = html.match(/"clientVersion":"([^"]+)"/)
  const clientVersion = clientVersionMatch?.[1] || '2.20240101.00.00'

  const videoIds: VideoMeta[] = []
  const seen = new Set<string>()

  function findVideos(obj: any) {
    if (!obj || typeof obj !== 'object') return
    if (obj.videoId && !seen.has(obj.videoId)) {
      seen.add(obj.videoId)
      videoIds.push({
        id: obj.videoId,
        title: obj.title?.runs?.[0]?.text || obj.title?.simpleText || 'Unknown',
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

  // Follow continuation tokens to get all videos
  while (continuation) {
    const browseRes = await fetch(
      `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB', clientVersion: clientVersion, hl: 'en', gl: 'US' },
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

    // No new videos found — stop
    if (videoIds.length === prevCount) break

    console.log(`[channel-scrape] Paginated: ${videoIds.length} videos so far`)
  }

  return videoIds.filter((v) => v.id.length === 11 && /^[a-zA-Z0-9_-]+$/.test(v.id))
}

export interface TranscriptResult {
  text?: string
  language?: string
  type?: string
  error?: string
}

export async function getVideoTranscript(videoId: string): Promise<TranscriptResult> {
  // Try WEB client first (more reliable on datacenter IPs), fall back to ANDROID
  const attempts = [
    {
      context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en', gl: 'US' } },
      headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS },
    },
    {
      context: ANDROID_CONTEXT,
      headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_UA },
    },
  ]

  for (const attempt of attempts) {
    const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: attempt.headers,
      body: JSON.stringify({ context: attempt.context, videoId }),
    })

    if (!playerRes.ok) continue

    const playerData = await playerRes.json() as any
    if (playerData?.playabilityStatus?.status !== 'OK') continue

    const captions = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (!captions?.length) continue

    const track =
      captions.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ||
      captions.find((t: any) => t.languageCode === 'en') ||
      captions.find((t: any) => t.kind !== 'asr') ||
      captions[0]

    const ua = attempt.headers['User-Agent'] || BROWSER_HEADERS['User-Agent']
    const captionRes = await fetch(track.baseUrl, { headers: { 'User-Agent': ua } })
    if (!captionRes.ok) continue

    const xml = await captionRes.text()
    const segments = parseCaptionXml(xml)

    if (segments.length > 0) {
      return {
        text: segments.join(' '),
        language: track.languageCode,
        type: track.kind === 'asr' ? 'auto-generated' : 'manual',
      }
    }
  }

  // All attempts failed — try scraping the watch page directly for captions
  const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: BROWSER_HEADERS })
  if (watchRes.ok) {
    const html = await watchRes.text()
    const playerData = extractJson(html, 'ytInitialPlayerResponse')
    if (playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
      const captions = playerData.captions.playerCaptionsTracklistRenderer.captionTracks
      const track =
        captions.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ||
        captions.find((t: any) => t.languageCode === 'en') ||
        captions.find((t: any) => t.kind !== 'asr') ||
        captions[0]

      const captionRes = await fetch(track.baseUrl, { headers: BROWSER_HEADERS })
      if (captionRes.ok) {
        const xml = await captionRes.text()
        const segments = parseCaptionXml(xml)
        if (segments.length > 0) {
          return {
            text: segments.join(' '),
            language: track.languageCode,
            type: track.kind === 'asr' ? 'auto-generated' : 'manual',
          }
        }
      }
    }
  }

  return { error: 'Video not playable: all transcript methods failed' }
}
