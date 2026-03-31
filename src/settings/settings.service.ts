import { Injectable, Inject, OnModuleInit } from '@nestjs/common'
import { Pool } from 'pg'
import { DB_POOL } from '../db/db.module'
import OpenAI from 'openai'

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6'

@Injectable()
export class SettingsService implements OnModuleInit {
  private cache: Record<string, string> = {}

  private openrouter = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  })

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    try {
      const { rows } = await this.pool.query('SELECT key, value FROM app_settings')
      for (const row of rows) this.cache[row.key] = row.value
    } catch {
      // table may not exist yet — fall back to defaults
    }
    if (!this.cache['chat_model']) this.cache['chat_model'] = DEFAULT_MODEL
    if (!this.cache['channel_video_limit']) this.cache['channel_video_limit'] = '0'
    if (!this.cache['chunk_model']) this.cache['chunk_model'] = 'mistralai/mistral-7b-instruct'
  }

  get(key: string): string {
    return this.cache[key] ?? (key === 'chat_model' ? DEFAULT_MODEL : '')
  }

  async set(key: string, value: string): Promise<void> {
    this.cache[key] = value
    await this.pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    )
  }

  async getAll(): Promise<Record<string, string>> {
    return { ...this.cache }
  }

  async fetchOpenRouterModels() {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      })
      const data = await res.json() as { data: { id: string; name: string; context_length: number; pricing: { prompt: string } }[] }
      return data.data
        .map((m) => ({
          id: m.id,
          name: m.name,
          context_length: m.context_length,
          price_per_1k: (parseFloat(m.pricing?.prompt ?? '0') * 1000).toFixed(4),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    } catch {
      return []
    }
  }
}
