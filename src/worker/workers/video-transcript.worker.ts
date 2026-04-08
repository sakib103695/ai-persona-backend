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

    // ── Cache check ─────────────────────────────────────────────────────────
    // If any other source (any persona) already has a transcript for this
    // video_id, copy it instead of fetching again. Saves bandwidth + proxy
    // budget for popular videos imported across multiple personas.
    const { rows: cachedRows } = await pool.query<{
      transcript_text: string
      word_count: number
      language: string | null
      caption_type: string | null
    }>(
      `SELECT transcript_text, word_count, language, caption_type
       FROM sources
       WHERE video_id = $1 AND id != $2
         AND transcript_text IS NOT NULL AND transcript_text != ''
       ORDER BY updated_at DESC
       LIMIT 1`,
      [video_id, source_id],
    )

    if (cachedRows.length > 0) {
      const cached = cachedRows[0]
      await pool.query(
        `UPDATE sources
         SET status = 'transcribed', transcript_text = $1, word_count = $2,
             language = $3, caption_type = $4, updated_at = NOW()
         WHERE id = $5`,
        [cached.transcript_text, cached.word_count, cached.language, cached.caption_type, source_id],
      )
      await chunkEmbedQueue.add(
        'chunk',
        { source_id, persona_id },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      )
      console.log(`[video-transcript] ✅ ${cached.word_count} words (cached from another persona)`)
      return { status: 'transcribed', word_count: cached.word_count, cached: true }
    }

    // Throttle (only when actually hitting YouTube)
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
