import { Injectable, Inject, NotFoundException } from '@nestjs/common'
import { Pool } from 'pg'
import { DB_POOL } from '../db/db.module'

@Injectable()
export class PersonasService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async findAll() {
    const { rows } = await this.pool.query(
      'SELECT id, name, slug, bio, avatar_url, tags, status, total_chunks, created_at FROM personas ORDER BY created_at DESC',
    )
    return rows
  }

  async findOne(id: string) {
    const { rows } = await this.pool.query(
      'SELECT * FROM personas WHERE id = $1',
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
}
