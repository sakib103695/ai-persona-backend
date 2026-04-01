import { Injectable, Inject, NotFoundException } from '@nestjs/common'
import { Pool } from 'pg'
import { DB_POOL } from '../db/db.module'

@Injectable()
export class PersonasService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async findAll() {
    const { rows } = await this.pool.query(
      `SELECT p.id, p.name, p.slug, p.bio, p.avatar_url, p.tags, p.total_chunks, p.created_at,
              CASE
                WHEN p.total_chunks > 0 THEN 'ready'
                WHEN p.persona_profile IS NOT NULL AND p.persona_profile != '{}'::jsonb THEN 'ready'
                WHEN EXISTS (SELECT 1 FROM sources s WHERE s.persona_id = p.id AND s.status IN ('queued', 'processing', 'transcribed')) THEN 'processing'
                WHEN EXISTS (SELECT 1 FROM sources s WHERE s.persona_id = p.id AND s.status NOT IN ('listed')) THEN 'ready'
                ELSE p.status
              END AS status
       FROM personas p
       ORDER BY p.created_at DESC`,
    )
    return rows
  }

  async findOne(id: string) {
    const { rows } = await this.pool.query(
      `SELECT p.*,
              CASE
                WHEN p.total_chunks > 0 THEN 'ready'
                WHEN p.persona_profile IS NOT NULL AND p.persona_profile != '{}'::jsonb THEN 'ready'
                WHEN EXISTS (SELECT 1 FROM sources s WHERE s.persona_id = p.id AND s.status IN ('queued', 'processing', 'transcribed')) THEN 'processing'
                WHEN EXISTS (SELECT 1 FROM sources s WHERE s.persona_id = p.id AND s.status NOT IN ('listed')) THEN 'ready'
                ELSE p.status
              END AS status
       FROM personas p WHERE p.id = $1`,
      [id],
    )
    if (!rows[0]) throw new NotFoundException(`Persona ${id} not found`)
    return rows[0]
  }

  async create(data: { name: string; slug: string; bio?: string }) {
    const { rows } = await this.pool.query(
      `INSERT INTO personas (name, slug, bio) VALUES ($1, $2, $3) RETURNING *`,
      [data.name, data.slug, data.bio ?? null],
    )
    return rows[0]
  }

  async updateStatus(id: string, status: string) {
    await this.pool.query(
      `UPDATE personas SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id],
    )
  }

  async updateProfile(id: string, profile: object, tags: string[]) {
    await this.pool.query(
      `UPDATE personas SET persona_profile = $1, tags = $2, status = 'ready', updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(profile), tags, id],
    )
  }

  async update(id: string, data: { name?: string; bio?: string; tags?: string[]; avatar_url?: string }) {
    const sets: string[] = []
    const values: any[] = []
    let idx = 1

    if (data.name !== undefined) { sets.push(`name = $${idx++}`); values.push(data.name) }
    if (data.bio !== undefined) { sets.push(`bio = $${idx++}`); values.push(data.bio) }
    if (data.tags !== undefined) { sets.push(`tags = $${idx++}`); values.push(data.tags) }
    if (data.avatar_url !== undefined) { sets.push(`avatar_url = $${idx++}`); values.push(data.avatar_url) }

    if (sets.length === 0) return this.findOne(id)

    sets.push(`updated_at = NOW()`)
    values.push(id)

    const { rows } = await this.pool.query(
      `UPDATE personas SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    )
    if (!rows[0]) throw new NotFoundException(`Persona ${id} not found`)
    return rows[0]
  }

  async delete(id: string) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM personas WHERE id = $1`,
      [id],
    )
    if (!rowCount) throw new NotFoundException(`Persona ${id} not found`)
    return { deleted: true }
  }

  /** Export all personas with sources and chunks as JSON */
  async exportAll() {
    const { rows: personas } = await this.pool.query(
      `SELECT * FROM personas ORDER BY created_at DESC`,
    )

    const result = []
    for (const persona of personas) {
      const { rows: sources } = await this.pool.query(
        `SELECT id, persona_id, video_id, title, channel_url, transcript_text, word_count,
                language, caption_type, status, error, created_at
         FROM sources WHERE persona_id = $1 ORDER BY created_at`,
        [persona.id],
      )

      const { rows: chunks } = await this.pool.query(
        `SELECT id, persona_id, source_id, chunk_index, chunk_text, topic_summary,
                embedding::text
         FROM knowledge_chunks WHERE persona_id = $1 ORDER BY chunk_index`,
        [persona.id],
      )

      result.push({ persona, sources, chunks })
    }

    return result
  }

  /** Import personas with sources and chunks from exported JSON */
  async importAll(data: any[]) {
    let personasImported = 0
    let sourcesImported = 0
    let chunksImported = 0

    for (const entry of data) {
      const p = entry.persona

      // Upsert persona
      await this.pool.query(
        `INSERT INTO personas (id, name, slug, bio, avatar_url, tags, status, persona_profile, total_chunks, channel_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, slug = EXCLUDED.slug, bio = EXCLUDED.bio,
           avatar_url = EXCLUDED.avatar_url, tags = EXCLUDED.tags, status = EXCLUDED.status,
           persona_profile = EXCLUDED.persona_profile, total_chunks = EXCLUDED.total_chunks,
           channel_url = EXCLUDED.channel_url, updated_at = NOW()`,
        [p.id, p.name, p.slug, p.bio, p.avatar_url, p.tags || [], p.status || 'ready',
         p.persona_profile || '{}', p.total_chunks || 0, p.channel_url, p.created_at],
      )
      personasImported++

      // Upsert sources
      for (const s of entry.sources || []) {
        await this.pool.query(
          `INSERT INTO sources (id, persona_id, video_id, title, channel_url, transcript_text, word_count,
                                language, caption_type, status, error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title, transcript_text = EXCLUDED.transcript_text,
             word_count = EXCLUDED.word_count, status = EXCLUDED.status, updated_at = NOW()`,
          [s.id, s.persona_id, s.video_id, s.title, s.channel_url, s.transcript_text,
           s.word_count, s.language, s.caption_type, s.status, s.error, s.created_at],
        )
        sourcesImported++
      }

      // Insert chunks (delete existing first to avoid duplicates)
      if (entry.chunks?.length > 0) {
        await this.pool.query(
          `DELETE FROM knowledge_chunks WHERE persona_id = $1`,
          [p.id],
        )

        for (const c of entry.chunks) {
          await this.pool.query(
            `INSERT INTO knowledge_chunks (id, persona_id, source_id, chunk_index, chunk_text, topic_summary, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
            [c.id, c.persona_id, c.source_id, c.chunk_index, c.chunk_text, c.topic_summary, c.embedding],
          )
          chunksImported++
        }
      }
    }

    return { personas: personasImported, sources: sourcesImported, chunks: chunksImported }
  }
}
