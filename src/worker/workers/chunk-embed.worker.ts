import { Worker } from 'bullmq'
import { pool } from '../db'
import { personaProfileQueue } from '../queues'
import OpenAI from 'openai'

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
}

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

interface Chunk {
  topic_summary: string
  text: string
}

const WINDOW_SIZE = 10000
const WINDOW_OVERLAP = 1500

function splitIntoWindows(text: string): string[] {
  const stride = WINDOW_SIZE - WINDOW_OVERLAP
  const windows: string[] = []
  for (let i = 0; i < text.length; i += stride) {
    windows.push(text.slice(i, i + WINDOW_SIZE))
    if (i + WINDOW_SIZE >= text.length) break
  }
  return windows.length > 0 ? windows : [text]
}

function deduplicateChunks(chunks: Chunk[]): Chunk[] {
  const unique: Chunk[] = []
  for (const chunk of chunks) {
    const isDuplicate = unique.some((existing) => {
      const shorter = chunk.text.length < existing.text.length ? chunk.text : existing.text
      const longer = chunk.text.length >= existing.text.length ? chunk.text : existing.text
      return longer.includes(shorter.slice(0, Math.floor(shorter.length * 0.8)))
    })
    if (!isDuplicate) unique.push(chunk)
  }
  return unique
}

async function chunkWindow(window: string): Promise<Chunk[]> {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'chunk_model'`)
  const model = rows[0]?.value || 'mistralai/mistral-7b-instruct'

  const response = await openrouter.chat.completions.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Split this transcript into topic-based chunks. Each chunk should cover one coherent topic and be 400-800 words.

Return a JSON array of objects with:
- "topic_summary": 1 sentence describing the topic (max 100 chars)
- "text": the chunk text

Return ONLY valid JSON, no other text.

Transcript:
${window}`,
      },
    ],
  })

  const raw = (response.choices[0].message.content ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

function fallbackChunk(transcript: string): Chunk[] {
  const words = transcript.split(/\s+/)
  const chunks: Chunk[] = []
  const CHUNK_SIZE = 600
  const STRIDE = 500
  for (let i = 0; i < words.length; i += STRIDE) {
    chunks.push({
      topic_summary: `Content segment ${Math.floor(i / STRIDE) + 1}`,
      text: words.slice(i, i + CHUNK_SIZE).join(' '),
    })
  }
  return chunks
}

async function chunkTranscript(transcript: string): Promise<Chunk[]> {
  const windows = splitIntoWindows(transcript)
  const allChunks: Chunk[] = []

  for (const window of windows) {
    try {
      const windowChunks = await chunkWindow(window)
      allChunks.push(...windowChunks)
    } catch {
      allChunks.push(...fallbackChunk(window))
    }
  }

  const result = allChunks.length > 0 ? deduplicateChunks(allChunks) : fallbackChunk(transcript)
  return result
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  })
  return res.data.map((d) => d.embedding)
}

export const chunkEmbedWorker = new Worker(
  'chunk-and-embed',
  async (job) => {
    const { source_id, persona_id } = job.data
    console.log(`[chunk-embed] source ${source_id}`)

    const { rows } = await pool.query<{ transcript_text: string }>(
      `SELECT transcript_text FROM sources WHERE id = $1`,
      [source_id],
    )
    if (!rows[0]?.transcript_text) {
      throw new Error('No transcript text found')
    }

    const chunks = await chunkTranscript(rows[0].transcript_text)
    console.log(`[chunk-embed] ${chunks.length} chunks`)

    const BATCH = 20
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH)
      const embeddings = await embedTexts(batch.map((c) => c.text))

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]
        const embedding = embeddings[j]
        const embeddingStr = `[${embedding.join(',')}]`

        await pool.query(
          `INSERT INTO knowledge_chunks (persona_id, source_id, chunk_index, chunk_text, topic_summary, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)`,
          [persona_id, source_id, i + j, chunk.text, chunk.topic_summary, embeddingStr],
        )
      }
    }

    await pool.query(
      `UPDATE sources SET status = 'done', updated_at = NOW() WHERE id = $1`,
      [source_id],
    )

    await pool.query(
      `UPDATE personas SET total_chunks = total_chunks + $1, updated_at = NOW() WHERE id = $2`,
      [chunks.length, persona_id],
    )

    const { rows: pending } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM sources WHERE persona_id = $1 AND status NOT IN ('done', 'failed')`,
      [persona_id],
    )
    if (Number(pending[0].cnt) === 0) {
      await personaProfileQueue.add('profile', { persona_id })
    }

    return { chunks_created: chunks.length }
  },
  { connection, concurrency: 1, lockDuration: 300000, lockRenewTime: 60000 },
)

chunkEmbedWorker.on('failed', (job, err) => {
  console.error(`[chunk-embed] Job ${job?.id} failed: ${err.message}`)
})
