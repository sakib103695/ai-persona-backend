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
}
