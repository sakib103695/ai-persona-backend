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

    const videos = await getChannelVideoIds(url, videoLimit)
    console.log(`[channel-scrape] Found ${videos.length} videos${videoLimit > 0 ? ` (limit: ${videoLimit})` : ''}`)

    // Step 1: Insert all source records at once so the total count is accurate
    const insertedIds: { id: string; video_id: string }[] = []
    for (const video of videos) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO sources (persona_id, video_id, title, channel_url, status)
         VALUES ($1, $2, $3, $4, 'queued')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [persona_id, video.id, video.title, url],
      )
      if (rows[0]) {
        insertedIds.push({ id: rows[0].id, video_id: video.id })
      }
    }

    console.log(`[channel-scrape] Inserted ${insertedIds.length} new sources (${videos.length - insertedIds.length} already existed)`)

    // Update persona status to processing
    if (insertedIds.length > 0) {
      await pool.query(
        `UPDATE personas SET status = 'processing', updated_at = NOW() WHERE id = $1`,
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
