import { Queue } from 'bullmq'
import * as dotenv from 'dotenv'
dotenv.config()

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
}

export const channelScrapeQueue = new Queue('channel-scrape', { connection })
export const videoTranscriptQueue = new Queue('video-transcript', { connection })
export const chunkEmbedQueue = new Queue('chunk-and-embed', { connection })
export const personaProfileQueue = new Queue('persona-profile', { connection })
