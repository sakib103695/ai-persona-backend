import { Pool } from 'pg'
import * as dotenv from 'dotenv'
dotenv.config()

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'persona_ai',
  user: process.env.DB_USER || 'persona',
  password: process.env.DB_PASSWORD || 'persona_dev',
})
