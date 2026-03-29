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

    const videos = await getChannelVideoIds(url)
    console.log(`[channel-scrape] Found ${videos.length} videos`)

    for (const video of videos) {
      // Create source record
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO sources (persona_id, video_id, title, channel_url, status)
         VALUES ($1, $2, $3, $4, 'queued')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [persona_id, video.id, video.title, url],
      )

      if (rows[0]) {
        await videoTranscriptQueue.add(
          'transcript',
          { source_id: rows[0].id, video_id: video.id, persona_id },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
      }
    }

    return { videos_queued: videos.length }
  },
  { connection, concurrency: 1 },
)

channelScrapeWorker.on('failed', (job, err) => {
  console.error(`[channel-scrape] Job ${job?.id} failed: ${err.message}`)
})
