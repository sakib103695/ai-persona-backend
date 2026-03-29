import { Worker } from 'bullmq'
import { pool } from '../db'
import { getVideoTranscript } from '../youtube'
import { chunkEmbedQueue } from '../queues'

const DELAY_MS = Number(process.env.YT_REQUEST_DELAY_MS) || 2000

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
}

export const videoTranscriptWorker = new Worker(
  'video-transcript',
  async (job) => {
    const { source_id, video_id, persona_id } = job.data
    console.log(`[video-transcript] ${video_id}`)

    // Mark as processing
    await pool.query(
      `UPDATE sources SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [source_id],
    )

    // Throttle
    await new Promise((r) => setTimeout(r, DELAY_MS))

    const transcript = await getVideoTranscript(video_id)

    if (transcript.error || !transcript.text) {
      await pool.query(
        `UPDATE sources SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`,
        [transcript.error || 'Empty transcript', source_id],
      )
      return { status: 'failed', error: transcript.error }
    }

    const wordCount = transcript.text.split(/\s+/).filter(Boolean).length

    await pool.query(
      `UPDATE sources
       SET status = 'transcribed', transcript_text = $1, word_count = $2,
           language = $3, caption_type = $4, updated_at = NOW()
       WHERE id = $5`,
      [transcript.text, wordCount, transcript.language, transcript.type, source_id],
    )

    await chunkEmbedQueue.add(
      'chunk',
      { source_id, persona_id },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    )

    console.log(`[video-transcript] ✅ ${wordCount} words (${transcript.type})`)
    return { status: 'transcribed', word_count: wordCount }
  },
  { connection, concurrency: 2 },
)

videoTranscriptWorker.on('failed', (job, err) => {
  console.error(`[video-transcript] Job ${job?.id} failed: ${err.message}`)
})
