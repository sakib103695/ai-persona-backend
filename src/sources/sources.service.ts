import { Injectable, Inject } from '@nestjs/common'
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

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly personas: PersonasService,
  ) {
    this.channelQueue = new Queue('channel-scrape', {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
      },
    })
  }

  /** Accepts multiple channel URLs — creates one persona per channel URL and enqueues jobs */
  async importChannels(urls: string[]) {
    const results: Array<{ url: string; persona_id: string }> = []

    for (const url of urls) {
      const name = extractChannelName(url)
      const slug = slugify(name)

      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO personas (name, slug, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (slug) DO UPDATE SET status = 'pending', updated_at = NOW()
         RETURNING id`,
        [name, slug],
      )
      const persona_id = rows[0].id

      await this.channelQueue.add('scrape', { url, persona_id })
      results.push({ url, persona_id })
    }

    return results
  }

  /** All sources for a given persona, ordered newest first */
  async getByPersona(personaId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, video_id, title, word_count, status, caption_type, error, created_at, updated_at
       FROM sources
       WHERE persona_id = $1
       ORDER BY created_at DESC`,
      [personaId],
    )
    return rows
  }

  /** Live import progress for a persona — polled by the ImportModal */
  async getImportStatus(personaId: string) {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'done')        AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')      AS failed,
         COUNT(*) FILTER (WHERE status = 'processing')  AS in_progress_count,
         COUNT(*)                                        AS total,
         COALESCE(SUM(word_count), 0)                   AS total_words,
         (SELECT title FROM sources
          WHERE persona_id = $1 AND status = 'processing'
          ORDER BY updated_at DESC LIMIT 1)              AS current_video
       FROM sources
       WHERE persona_id = $1`,
      [personaId],
    )
    const r = rows[0]
    const total = Number(r.total)
    const completed = Number(r.completed)
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0

    return {
      total_videos: total,
      completed,
      failed: Number(r.failed),
      in_progress: r.current_video || '',
      current_step: Number(r.in_progress_count) > 0 ? 'extracting-transcript' : 'queued',
      total_words_extracted: Number(r.total_words),
      percent,
    }
  }
}
