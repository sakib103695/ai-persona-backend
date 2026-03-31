import { Worker } from 'bullmq'
import { pool } from '../db'
import { getChannelVideoIds } from '../youtube'
import { videoTranscriptQueue } from '../queues'

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
}

export const channelScrapeWorker = new Worker(
  'channel-scrape',
  async (job) => {
    const { url, persona_id } = job.data
    console.log(`[channel-scrape] ${url}`)

    // Read video limit from settings (0 = unlimited)
    const { rows: settingRows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'channel_video_limit'`,
    )
    const videoLimit = parseInt(settingRows[0]?.value ?? '0', 10)

    // Find which video IDs already exist for this persona
    const { rows: existingRows } = await pool.query<{ video_id: string }>(
      `SELECT video_id FROM sources WHERE persona_id = $1`,
      [persona_id],
    )
    const existingVideoIds = new Set(existingRows.map((r) => r.video_id))

    // Fetch more videos than the limit so we can skip existing ones
    // If limit is 10 and 10 already exist, we need to fetch at least 20 to find 10 new ones
    const fetchLimit = videoLimit > 0 ? videoLimit + existingVideoIds.size : 0
    const allVideos = await getChannelVideoIds(url, fetchLimit)

    // Filter out already-imported videos, then apply the limit
    let newVideos = allVideos.filter((v) => !existingVideoIds.has(v.id))
    if (videoLimit > 0 && newVideos.length > videoLimit) {
      newVideos = newVideos.slice(0, videoLimit)
    }
    console.log(`[channel-scrape] Found ${allVideos.length} total, ${existingVideoIds.size} already exist, ${newVideos.length} new${videoLimit > 0 ? ` (limit: ${videoLimit})` : ''}`)

    // Step 1: Insert new source records
    const insertedIds: { id: string; video_id: string }[] = []
    for (const video of newVideos) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO sources (persona_id, video_id, title, channel_url, status)
         VALUES ($1, $2, $3, $4, 'queued')
         ON CONFLICT (persona_id, video_id) DO NOTHING
         RETURNING id`,
        [persona_id, video.id, video.title, url],
      )
      if (rows[0]) {
        insertedIds.push({ id: rows[0].id, video_id: video.id })
      }
    }

    console.log(`[channel-scrape] Inserted ${insertedIds.length} new sources`)

    // Update persona status
    if (insertedIds.length > 0) {
      await pool.query(
        `UPDATE personas SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [persona_id],
      )
    } else {
      // No new videos — set back to ready (don't leave stuck in pending/processing)
      await pool.query(
        `UPDATE personas SET status = 'ready', updated_at = NOW() WHERE id = $1`,
        [persona_id],
      )
    }

    // Step 2: Queue transcript jobs for all new sources
    for (const { id, video_id } of insertedIds) {
      await videoTranscriptQueue.add(
        'transcript',
        { source_id: id, video_id, persona_id },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      )
    }

    return { videos_found: videos.length, videos_queued: insertedIds.length }
  },
  { connection, concurrency: 1 },
)

channelScrapeWorker.on('failed', (job, err) => {
  console.error(`[channel-scrape] Job ${job?.id} failed: ${err.message}`)
})
