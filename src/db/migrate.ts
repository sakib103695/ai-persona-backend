/**
 * Run with: npx ts-node src/db/migrate.ts
 * Or after build: node dist/db/migrate.js
 */
import { Pool } from 'pg'
import * as dotenv from 'dotenv'
dotenv.config()

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'persona_ai',
  user: process.env.DB_USER || 'persona',
  password: process.env.DB_PASSWORD || 'persona_dev',
})

const SQL = `
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Personas
CREATE TABLE IF NOT EXISTS personas (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  bio           TEXT,
  avatar_url    TEXT,
  tags          TEXT[] DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending',
  persona_profile JSONB DEFAULT '{}',
  total_chunks  INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Sources (individual videos)
CREATE TABLE IF NOT EXISTS sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  video_id        TEXT NOT NULL,
  title           TEXT,
  channel_url     TEXT,
  transcript_text TEXT,
  word_count      INTEGER DEFAULT 0,
  language        TEXT,
  caption_type    TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  error           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Knowledge chunks (embeddings live here)
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id      UUID NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  source_id       UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  chunk_text      TEXT NOT NULL,
  topic_summary   TEXT,
  embedding       vector(1536),
  tsvector_content tsvector GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Chat sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_ids UUID[] NOT NULL,
  source_ids  UUID[] DEFAULT NULL,
  mode        TEXT NOT NULL DEFAULT 'learn',
  title       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS source_ids UUID[] DEFAULT NULL;

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  chunk_ids       UUID[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- App settings (key-value)
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Channel URL on persona (so we can validate imports)
ALTER TABLE personas ADD COLUMN IF NOT EXISTS channel_url TEXT;

-- Backfill channel_url from sources
UPDATE personas p
SET channel_url = (
  SELECT DISTINCT s.channel_url FROM sources s
  WHERE s.persona_id = p.id AND s.channel_url IS NOT NULL
  LIMIT 1
)
WHERE p.channel_url IS NULL;

-- Unique constraint: one source per video per persona
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_persona_video ON sources (persona_id, video_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chunks_persona ON knowledge_chunks (persona_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tsvector ON knowledge_chunks USING gin (tsvector_content);
CREATE INDEX IF NOT EXISTS idx_sources_status ON sources (status);
CREATE INDEX IF NOT EXISTS idx_sources_persona ON sources (persona_id);
CREATE INDEX IF NOT EXISTS idx_personas_tags ON personas USING gin (tags);

-- Cache lookups: when a video is imported across multiple personas, we
-- copy the existing transcript instead of re-fetching from YouTube. This
-- partial index keeps the lookup cheap by only indexing rows that have a
-- transcript available to copy.
CREATE INDEX IF NOT EXISTS idx_sources_video_id_with_transcript
  ON sources (video_id)
  WHERE transcript_text IS NOT NULL;

-- Vector index (created conditionally after data exists)
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM knowledge_chunks) > 100 THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'idx_chunks_embedding'
    ) THEN
      CREATE INDEX idx_chunks_embedding ON knowledge_chunks
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
    END IF;
  END IF;
END $$;
`

async function run() {
  const client = await pool.connect()
  try {
    console.log('Running migrations...')
    await client.query(SQL)
    console.log('Done.')
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
