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

    // Fetch ALL videos from the channel (just IDs + titles — fast)
    const { videos: allVideos, avatar_url } = await getChannelVideoIds(url)
    console.log(`[channel-scrape] Found ${allVideos.length} videos on channel`)

    // Save avatar if found and persona doesn't have one yet
    if (avatar_url) {
      await pool.query(
        `UPDATE personas SET avatar_url = $1, updated_at = NOW() WHERE id = $2 AND (avatar_url IS NULL OR avatar_url = '')`,
        [avatar_url, persona_id],
      )
      console.log(`[channel-scrape] Avatar saved`)
    }

    // Find which video IDs already exist for this persona
    const { rows: existingRows } = await pool.query<{ video_id: string }>(
      `SELECT video_id FROM sources WHERE persona_id = $1`,
      [persona_id],
    )
    const existingVideoIds = new Set(existingRows.map((r) => r.video_id))

    // Insert ALL videos as sources (so full list is visible in UI)
    // New ones get status 'listed', existing ones are skipped
    let totalInserted = 0
    for (const video of allVideos) {
      const { rowCount } = await pool.query(
        `INSERT INTO sources (persona_id, video_id, title, channel_url, status)
         VALUES ($1, $2, $3, $4, 'listed')
         ON CONFLICT (persona_id, video_id) DO NOTHING`,
        [persona_id, video.id, video.title, url],
      )
      if (rowCount && rowCount > 0) totalInserted++
    }
    console.log(`[channel-scrape] Inserted ${totalInserted} new sources (${existingVideoIds.size} already existed)`)

    // Pick the latest N unfetched videos to actually process
    // "unfetched" = status is 'listed' (just catalogued, never processed)
    const { rows: toProcess } = await pool.query<{ id: string; video_id: string }>(
      `SELECT id, video_id FROM sources
       WHERE persona_id = $1 AND status = 'listed'
       ORDER BY created_at ASC
       ${videoLimit > 0 ? `LIMIT ${videoLimit}` : ''}`,
      [persona_id],
    )

    if (toProcess.length > 0) {
      // Mark them as queued
      const queueIds = toProcess.map((r) => r.id)
      await pool.query(
        `UPDATE sources SET status = 'queued', updated_at = NOW() WHERE id = ANY($1)`,
        [queueIds],
      )

      await pool.query(
        `UPDATE personas SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [persona_id],
      )

      // Queue transcript jobs
      for (const { id, video_id } of toProcess) {
        await videoTranscriptQueue.add(
          'transcript',
          { source_id: id, video_id, persona_id },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
      }

      console.log(`[channel-scrape] Queued ${toProcess.length} videos for processing`)
    } else {
      // No new videos to process — set back to ready
      await pool.query(
        `UPDATE personas SET status = 'ready', updated_at = NOW() WHERE id = $1`,
        [persona_id],
      )
      console.log(`[channel-scrape] No new videos to process`)
    }

    return { videos_found: allVideos.length, new_sources: totalInserted, queued: toProcess.length }
  },
  { connection, concurrency: 1 },
)

channelScrapeWorker.on('failed', (job, err) => {
  console.error(`[channel-scrape] Job ${job?.id} failed: ${err.message}`)
})
