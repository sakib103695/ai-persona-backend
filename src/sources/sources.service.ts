import { Injectable, Inject, BadRequestException } from '@nestjs/common'
import { Pool } from 'pg'
import { Queue } from 'bullmq'
import { DB_POOL } from '../db/db.module'
import { PersonasService } from '../personas/personas.service'

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function extractChannelName(url: string) {
  const m = url.match(/@([^/?]+)/)
  if (m) return m[1]
  const m2 = url.match(/\/c\/([^/?]+)/)
  if (m2) return m2[1]
  return `persona-${Date.now()}`
}

@Injectable()
export class SourcesService {
  private channelQueue: Queue
  private chunkEmbedQueue: Queue
  private personaProfileQueue: Queue
  private readonly redisConnection = {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
  }

  private videoTranscriptQueue: Queue

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly personas: PersonasService,
  ) {
    this.channelQueue = new Queue('channel-scrape', { connection: this.redisConnection })
    this.videoTranscriptQueue = new Queue('video-transcript', { connection: this.redisConnection })
    this.chunkEmbedQueue = new Queue('chunk-and-embed', { connection: this.redisConnection })
    this.personaProfileQueue = new Queue('persona-profile', { connection: this.redisConnection })
  }

  /** Accepts multiple channel URLs — creates one persona per channel URL and enqueues jobs */
  async importChannels(urls: string[]) {
    const results: Array<{ url: string; persona_id: string }> = []

    for (const url of urls) {
      const name = extractChannelName(url)
      const slug = slugify(name)

      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO personas (name, slug, status, channel_url)
         VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (slug) DO UPDATE SET status = 'pending', updated_at = NOW()
         RETURNING id`,
        [name, slug, url],
      )
      const persona_id = rows[0].id

      await this.channelQueue.add('scrape', { url, persona_id })
      results.push({ url, persona_id })
    }

    return results
  }

  /** Add videos to an existing persona — validates channel URL or allows individual video URLs */
  async addToPersona(personaId: string, url: string) {
    const { rows: personaRows } = await this.pool.query<{ id: string; channel_url: string | null }>(
      `SELECT id, channel_url FROM personas WHERE id = $1`,
      [personaId],
    )
    if (personaRows.length === 0) throw new BadRequestException('Persona not found')
    const persona = personaRows[0]

    const isChannelUrl = /youtube\.com\/(@|c\/|channel\/)/.test(url)
    const isVideoUrl = /youtube\.com\/watch\?v=|youtu\.be\//.test(url)

    if (isChannelUrl) {
      // Validate channel matches
      const incomingChannel = extractChannelName(url).toLowerCase()
      if (persona.channel_url) {
        const existingChannel = extractChannelName(persona.channel_url).toLowerCase()
        if (incomingChannel !== existingChannel) {
          throw new BadRequestException(
            `This persona belongs to @${existingChannel}. You can't import a different channel (@${incomingChannel}). Use individual video URLs to add content from other channels.`
          )
        }
      } else {
        // First channel import — set it
        await this.pool.query(
          `UPDATE personas SET channel_url = $1, updated_at = NOW() WHERE id = $2`,
          [url, personaId],
        )
      }

      await this.pool.query(
        `UPDATE personas SET status = 'pending', updated_at = NOW() WHERE id = $1`,
        [personaId],
      )
      await this.channelQueue.add('scrape', { url, persona_id: personaId })
      return { type: 'channel', persona_id: personaId }
    }

    if (isVideoUrl) {
      // Extract video ID
      const videoIdMatch = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
      if (!videoIdMatch) throw new BadRequestException('Invalid YouTube video URL')
      const videoId = videoIdMatch[1]

      // Insert source and queue for transcript
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO sources (persona_id, video_id, title, status)
         VALUES ($1, $2, $3, 'queued')
         ON CONFLICT (persona_id, video_id) DO NOTHING
         RETURNING id`,
        [personaId, videoId, 'Loading...'],
      )
      if (rows[0]) {
        await this.pool.query(
          `UPDATE personas SET status = 'processing', updated_at = NOW() WHERE id = $1`,
          [personaId],
        )
        await this.videoTranscriptQueue.add(
          'transcript',
          { source_id: rows[0].id, video_id: videoId, persona_id: personaId },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
        return { type: 'video', persona_id: personaId, source_id: rows[0].id }
      }
      return { type: 'video', persona_id: personaId, already_exists: true }
    }

    throw new BadRequestException('URL must be a YouTube channel or video URL')
  }

  /** Fetch transcript text for a single source */
  async getTranscript(sourceId: string): Promise<{ title: string; transcript_text: string | null }> {
    const { rows } = await this.pool.query(
      `SELECT title, transcript_text FROM sources WHERE id = $1`,
      [sourceId],
    )
    if (rows.length === 0) throw new Error('Source not found')
    return rows[0]
  }

  /** Fetch transcripts for multiple sources */
  async getTranscripts(sourceIds: string[]): Promise<Array<{ title: string; transcript_text: string | null }>> {
    const { rows } = await this.pool.query(
      `SELECT title, transcript_text FROM sources WHERE id = ANY($1) AND transcript_text IS NOT NULL ORDER BY title`,
      [sourceIds],
    )
    return rows
  }

  /** Paginated sources for a persona with filter counts */
  async getByPersona(personaId: string, page = 1, limit = 50, filter = 'all') {
    // Status filter clause
    const filterClause =
      filter === 'done'       ? `AND status IN ('done', 'embedded')` :
      filter === 'failed'     ? `AND status = 'failed'` :
      filter === 'processing' ? `AND status IN ('processing', 'queued', 'transcribed')` :
      ''

    const offset = (page - 1) * limit

    const [itemsResult, countsResult] = await Promise.all([
      this.pool.query(
        `SELECT id, video_id, title, word_count, status, caption_type, error, created_at, updated_at
         FROM sources
         WHERE persona_id = $1 ${filterClause}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [personaId, limit, offset],
      ),
      this.pool.query(
        `SELECT
           COUNT(*)                                                        AS total,
           COUNT(*) FILTER (WHERE status IN ('done', 'embedded'))         AS done,
           COUNT(*) FILTER (WHERE status = 'failed')                      AS failed,
           COUNT(*) FILTER (WHERE status IN ('processing','queued','transcribed')) AS processing,
           COUNT(*) FILTER (WHERE status = 'listed')                      AS listed
         FROM sources WHERE persona_id = $1`,
        [personaId],
      ),
    ])

    const counts = countsResult.rows[0]
    const filteredTotal =
      filter === 'done'       ? Number(counts.done) :
      filter === 'failed'     ? Number(counts.failed) :
      filter === 'processing' ? Number(counts.processing) :
      Number(counts.total)

    return {
      items: itemsResult.rows,
      total: filteredTotal,
      total_pages: Math.ceil(filteredTotal / limit),
      page,
      limit,
      counts: {
        all:        Number(counts.total),
        done:       Number(counts.done),
        failed:     Number(counts.failed),
        processing: Number(counts.processing),
        listed:     Number(counts.listed),
      },
    }
  }

  /** Live import progress for a persona — polled by the ImportModal */
  async getImportStatus(personaId: string) {
    // Exclude 'listed' sources — they're just catalogued, not being processed
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'queued')                AS queued,
         COUNT(*) FILTER (WHERE status = 'processing')            AS transcribing,
         COUNT(*) FILTER (WHERE status = 'transcribed')           AS chunking,
         COUNT(*) FILTER (WHERE status IN ('done', 'embedded'))   AS done,
         COUNT(*) FILTER (WHERE status = 'failed')                AS failed,
         COUNT(*)                                                  AS total,
         COUNT(*) FILTER (WHERE status = 'listed')                AS listed,
         COALESCE(SUM(word_count) FILTER (WHERE status != 'listed'), 0) AS total_words,
         (SELECT title FROM sources
          WHERE persona_id = $1 AND status IN ('processing', 'transcribed')
          ORDER BY updated_at DESC LIMIT 1)                        AS current_video
       FROM sources
       WHERE persona_id = $1`,
      [personaId],
    )
    const r = rows[0]
    const listed = Number(r.listed)
    const activeTotal = Number(r.total) - listed
    const done = Number(r.done)
    const failed = Number(r.failed)
    const transcribing = Number(r.transcribing)
    const chunking = Number(r.chunking)
    const queued = Number(r.queued)
    const percent = activeTotal > 0 ? Math.round(((done + failed) / activeTotal) * 100) : 0

    let current_step = 'queued'
    if (chunking > 0) current_step = 'chunking-and-embedding'
    else if (transcribing > 0) current_step = 'extracting-transcript'
    else if (activeTotal > 0 && queued === 0 && transcribing === 0 && chunking === 0) current_step = 'complete'

    return {
      total_videos: activeTotal,
      completed: done,
      failed,
      queued,
      transcribing,
      chunking,
      listed,
      in_progress: r.current_video || '',
      current_step,
      total_words_extracted: Number(r.total_words),
      percent,
    }
  }

  /** Cancel an in-progress import — drains queued jobs and marks unstarted sources as failed */
  async cancelImport(personaId: string) {
    // Drain waiting jobs for this persona across all queues
    let jobsRemoved = 0
    for (const queue of [this.channelQueue, this.videoTranscriptQueue, this.chunkEmbedQueue, this.personaProfileQueue]) {
      const jobs = await queue.getJobs(['waiting', 'delayed'])
      for (const job of jobs) {
        if (job.data.persona_id === personaId) {
          await job.remove()
          jobsRemoved++
        }
      }
    }

    // Mark all queued (unstarted) sources as failed so they don't get picked up
    const { rowCount } = await this.pool.query(
      `UPDATE sources SET status = 'failed', error = 'Import cancelled', updated_at = NOW()
       WHERE persona_id = $1 AND status IN ('queued', 'processing')`,
      [personaId],
    )

    // Update persona status: if all sources are done/failed, mark as ready
    const { rows: pending } = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM sources WHERE persona_id = $1 AND status NOT IN ('done', 'embedded', 'failed')`,
      [personaId],
    )
    if (Number(pending[0].cnt) === 0) {
      await this.pool.query(
        `UPDATE personas SET status = 'ready', updated_at = NOW() WHERE id = $1`,
        [personaId],
      )
    }

    return { cancelled: true, jobs_removed: jobsRemoved, sources_cancelled: rowCount ?? 0 }
  }

  /** Delete specific sources (and their chunks) by ID */
  async deleteSources(sourceIds: string[]) {
    if (sourceIds.length === 0) return { deleted: 0 }
    await this.pool.query(
      `DELETE FROM knowledge_chunks WHERE source_id = ANY($1)`,
      [sourceIds],
    )
    const { rowCount } = await this.pool.query(
      `DELETE FROM sources WHERE id = ANY($1)`,
      [sourceIds],
    )
    // Recalculate total_chunks for affected personas
    await this.pool.query(
      `UPDATE personas p
       SET total_chunks = (SELECT COUNT(*) FROM knowledge_chunks kc WHERE kc.persona_id = p.id),
           updated_at = NOW()
       WHERE p.id IN (SELECT DISTINCT persona_id FROM sources WHERE id = ANY($1))
          OR p.id IN (
            SELECT DISTINCT s.persona_id FROM sources s
            INNER JOIN (SELECT unnest($1::uuid[]) AS id) ids ON ids.id = s.id
          )`,
      [sourceIds],
    )
    return { deleted: rowCount ?? 0 }
  }

  /** Reprocess sources: delete their chunks, reset status, re-queue */
  async reprocessSources(sourceIds: string[]) {
    if (sourceIds.length === 0) return { queued: 0 }
    // Delete existing chunks
    await this.pool.query(
      `DELETE FROM knowledge_chunks WHERE source_id = ANY($1)`,
      [sourceIds],
    )
    // Get source info for re-queuing
    const { rows: sources } = await this.pool.query<{
      id: string; video_id: string; persona_id: string; transcript_text: string | null
    }>(
      `UPDATE sources
       SET status = 'queued', error = NULL, updated_at = NOW()
       WHERE id = ANY($1)
       RETURNING id, video_id, persona_id, transcript_text`,
      [sourceIds],
    )
    // Reset persona chunks count
    const personaIds = [...new Set(sources.map((s) => s.persona_id))]
    for (const pid of personaIds) {
      await this.pool.query(
        `UPDATE personas SET total_chunks = (SELECT COUNT(*) FROM knowledge_chunks WHERE persona_id = $1), updated_at = NOW() WHERE id = $1`,
        [pid],
      )
    }
    // Re-queue at chunk-embed stage if transcript exists, otherwise at video-transcript
    const videoTranscriptQueue = new Queue('video-transcript', { connection: this.redisConnection })
    let queued = 0
    for (const src of sources) {
      if (src.transcript_text) {
        await this.pool.query(`UPDATE sources SET status = 'transcribed' WHERE id = $1`, [src.id])
        await this.chunkEmbedQueue.add('embed', { source_id: src.id, persona_id: src.persona_id }, {
          attempts: 3, backoff: { type: 'exponential', delay: 5000 },
        })
      } else {
        await videoTranscriptQueue.add('transcript', { source_id: src.id, video_id: src.video_id, persona_id: src.persona_id }, {
          attempts: 3, backoff: { type: 'exponential', delay: 5000 },
        })
      }
      queued++
    }
    return { queued }
  }

  /** Rebuild all knowledge for a persona: delete chunks, re-queue all transcribed sources */
  async rebuildKnowledge(personaId: string) {
    // Delete all chunks for this persona
    await this.pool.query(`DELETE FROM knowledge_chunks WHERE persona_id = $1`, [personaId])
    await this.pool.query(
      `UPDATE personas SET total_chunks = 0, persona_profile = '{}', status = 'processing', updated_at = NOW() WHERE id = $1`,
      [personaId],
    )
    // Reset done/failed sources to transcribed so they get re-chunked, and include already-transcribed sources
    const { rows: sources } = await this.pool.query<{ id: string; persona_id: string }>(
      `UPDATE sources SET status = 'transcribed', updated_at = NOW()
       WHERE persona_id = $1 AND status IN ('done', 'embedded', 'failed', 'transcribed') AND transcript_text IS NOT NULL
       RETURNING id, persona_id`,
      [personaId],
    )
    // Queue all for chunk-embed
    for (const src of sources) {
      await this.chunkEmbedQueue.add('embed', { source_id: src.id, persona_id: src.persona_id }, {
        attempts: 3, backoff: { type: 'exponential', delay: 5000 },
      })
    }
    return { queued: sources.length }
  }
}
