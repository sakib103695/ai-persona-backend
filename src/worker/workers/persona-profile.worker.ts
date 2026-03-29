import { Worker } from 'bullmq'
import { pool } from '../db'
import OpenAI from 'openai'

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
}

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

export const personaProfileWorker = new Worker(
  'persona-profile',
  async (job) => {
    const { persona_id } = job.data
    console.log(`[persona-profile] building profile for ${persona_id}`)

    const { rows } = await pool.query<{ topic_summary: string; persona_name: string }>(
      `SELECT kc.topic_summary, p.name AS persona_name
       FROM knowledge_chunks kc
       JOIN personas p ON p.id = kc.persona_id
       WHERE kc.persona_id = $1 AND kc.topic_summary IS NOT NULL
       LIMIT 200`,
      [persona_id],
    )

    if (rows.length === 0) return { status: 'no_chunks' }

    const personaName = rows[0].persona_name
    const summaries = rows.map((r) => r.topic_summary).join('\n')

    const response = await openrouter.chat.completions.create({
      model: 'anthropic/claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Based on these topic summaries from ${personaName}'s content, generate a persona profile.

Topics covered:
${summaries}

Return a JSON object with:
- "tone": describing communication style (e.g. "direct, data-driven, no-fluff")
- "expertise": array of expertise areas (e.g. ["pricing", "SaaS metrics"])
- "speaking_style": brief description
- "key_opinions": array of 3-5 strong opinions they hold
- "topics_to_avoid": array of topics they rarely or never discuss
- "catchphrases": array of 3-5 characteristic phrases or terms they use
- "tags": array of 5-15 lowercase hyphenated topic tags (e.g. ["cold-email", "saas-pricing"])

Return ONLY valid JSON.`,
        },
      ],
    })

    let profile: object = {}
    let tags: string[] = []

    try {
      const raw = response.choices[0].message.content ?? ''
      profile = JSON.parse(raw)
      tags = (profile as any).tags || []
    } catch {
      console.error(`[persona-profile] Failed to parse profile JSON`)
    }

    await pool.query(
      `UPDATE personas
       SET persona_profile = $1, tags = $2, status = 'ready', updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify(profile), tags, persona_id],
    )

    console.log(`[persona-profile] ✅ Profile built for ${personaName}`)
    return { status: 'done', tags }
  },
  { connection, concurrency: 1 },
)

personaProfileWorker.on('failed', (job, err) => {
  console.error(`[persona-profile] Job ${job?.id} failed: ${err.message}`)
})
