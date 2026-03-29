import { Injectable, Inject } from '@nestjs/common'
import { Pool } from 'pg'
import { DB_POOL } from '../db/db.module'
import OpenAI from 'openai'

type Mode = 'learn' | 'advisor' | 'research'

const PERSONA_COLORS = [
  '#6366f1', '#10b981', '#ec4899', '#f97316',
  '#0ea5e9', '#d946ef', '#f59e0b', '#f43f5e',
]

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  learn: `Your role is to help the user learn and understand the ideas, frameworks, and strategies
    covered in the knowledge base. Explain concepts clearly. Use specific examples. Break down
    complex ideas step by step. Reference specific topics when relevant. Use [1], [2] etc to
    cite sources inline when making claims from the knowledge base.`,

  advisor: `Your role is to apply the knowledge base to the user's specific situation.
    Give actionable advice grounded in the frameworks and terminology from the sources.
    Be direct and specific — no generic advice. Use [1], [2] etc to cite sources inline.`,

  research: `Answer with strict accuracy. Cite the source video using [1], [2] etc for every claim.
    Only use information directly present in the knowledge base.
    If information is not in the knowledge base, say so clearly. Never infer or extrapolate.`,
}

@Injectable()
export class ChatService {
  private openrouter = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  })

  private openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async createSession(personaIds: string[], mode: Mode) {
    const { rows } = await this.pool.query(
      `INSERT INTO chat_sessions (persona_ids, mode) VALUES ($1, $2) RETURNING *`,
      [personaIds, mode],
    )
    return rows[0]
  }

  async getSession(sessionId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM chat_sessions WHERE id = $1`,
      [sessionId],
    )
    return rows[0]
  }

  async getMessages(sessionId: string) {
    const { rows } = await this.pool.query(
      `SELECT role, content, created_at FROM chat_messages
       WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    )
    return rows
  }

  /** Hybrid vector + BM25 retrieval */
  async retrieveChunks(personaIds: string[], queryEmbedding: number[], query: string) {
    const embeddingStr = `[${queryEmbedding.join(',')}]`

    const { rows: vectorRows } = await this.pool.query(
      `SELECT kc.id, kc.chunk_text, kc.topic_summary, kc.source_id, kc.persona_id,
              1 - (kc.embedding <=> $1::vector) AS vector_score
       FROM knowledge_chunks kc
       WHERE kc.persona_id = ANY($2) AND kc.embedding IS NOT NULL
       ORDER BY kc.embedding <=> $1::vector
       LIMIT 20`,
      [embeddingStr, personaIds],
    )

    const { rows: keywordRows } = await this.pool.query(
      `SELECT kc.id, kc.chunk_text, kc.topic_summary, kc.source_id, kc.persona_id,
              ts_rank(kc.tsvector_content, plainto_tsquery('english', $1)) AS keyword_score
       FROM knowledge_chunks kc
       WHERE kc.persona_id = ANY($2)
         AND kc.tsvector_content @@ plainto_tsquery('english', $1)
       ORDER BY keyword_score DESC
       LIMIT 20`,
      [query, personaIds],
    )

    const merged = new Map<string, any>()
    for (const r of vectorRows) {
      merged.set(r.id, { ...r, final_score: 0.7 * Number(r.vector_score) })
    }
    for (const r of keywordRows) {
      if (merged.has(r.id)) {
        merged.get(r.id).final_score += 0.3 * Number(r.keyword_score)
      } else {
        merged.set(r.id, { ...r, final_score: 0.3 * Number(r.keyword_score) })
      }
    }

    return [...merged.values()]
      .sort((a, b) => b.final_score - a.final_score)
      .slice(0, 5)
  }

  /** Enrich raw chunks with source + persona metadata for the sources panel */
  async enrichChunks(chunks: any[]) {
    if (chunks.length === 0) return []

    const sourceIds = [...new Set(chunks.map((c) => c.source_id))]
    const personaIds = [...new Set(chunks.map((c) => c.persona_id))]

    const { rows: sources } = await this.pool.query(
      `SELECT id, video_id, title, word_count FROM sources WHERE id = ANY($1)`,
      [sourceIds],
    )
    const { rows: personas } = await this.pool.query(
      `SELECT id, name FROM personas WHERE id = ANY($1)`,
      [personaIds],
    )

    const sourceMap = Object.fromEntries(sources.map((s) => [s.id, s]))
    const personaMap = Object.fromEntries(personas.map((p) => [p.id, p]))

    const personaColorIdx: Record<string, number> = {}
    personaIds.forEach((pid, i) => { personaColorIdx[pid] = i })

    return chunks.map((chunk, i) => {
      const src = sourceMap[chunk.source_id] ?? {}
      const persona = personaMap[chunk.persona_id] ?? {}
      const colorIdx = personaColorIdx[chunk.persona_id] ?? 0

      return {
        chunk_id: chunk.id,
        citation_index: i + 1,
        persona_name: persona.name ?? 'Unknown',
        persona_color: PERSONA_COLORS[colorIdx % PERSONA_COLORS.length],
        video_title: src.title ?? 'Untitled',
        video_id: src.video_id ?? '',
        topic_summary: chunk.topic_summary ?? '',
        chunk_preview: chunk.chunk_text?.substring(0, 300) ?? '',
        word_count: src.word_count ?? 0,
        confidence: Number(chunk.final_score?.toFixed(3) ?? 0),
      }
    })
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    })
    return res.data[0].embedding
  }

  /** Stream response tokens, then emit a final sources event */
  async *streamResponse(sessionId: string, userMessage: string): AsyncGenerator<string> {
    const session = await this.getSession(sessionId)
    if (!session) throw new Error('Session not found')

    const mode: Mode = session.mode

    await this.pool.query(
      `INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
      [sessionId, userMessage],
    )

    const embedding = await this.embedQuery(userMessage)
    const chunks = await this.retrieveChunks(session.persona_ids, embedding, userMessage)
    const enrichedSources = await this.enrichChunks(chunks)

    const contextBlock = chunks
      .map((c, i) =>
        `[${i + 1}] ${c.topic_summary ? `Topic: ${c.topic_summary}\n` : ''}${c.chunk_text}`,
      )
      .join('\n\n---\n\n')

    const systemPrompt = `You are an AI assistant with deep knowledge from the following sources.

${MODE_INSTRUCTIONS[mode]}

Use [1], [2], etc. to cite sources inline when drawing from the knowledge below.

Relevant knowledge:
${contextBlock || 'No relevant knowledge found in the database yet.'}`

    let fullContent = ''

    const stream = await this.openrouter.chat.completions.create({
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 2048,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    })

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content
      if (token) {
        fullContent += token
        yield JSON.stringify({ token })
      }
    }

    if (enrichedSources.length > 0) {
      yield JSON.stringify({ sources: enrichedSources })
    }

    const chunkIds = chunks.map((c) => c.id)
    await this.pool.query(
      `INSERT INTO chat_messages (session_id, role, content, chunk_ids)
       VALUES ($1, 'assistant', $2, $3)`,
      [sessionId, fullContent, chunkIds],
    )
  }
}
