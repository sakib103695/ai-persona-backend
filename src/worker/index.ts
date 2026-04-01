import * as dotenv from 'dotenv'
dotenv.config()

import { channelScrapeWorker } from './workers/channel-scrape.worker'
import { videoTranscriptWorker } from './workers/video-transcript.worker'
import { chunkEmbedWorker } from './workers/chunk-embed.worker'
import { personaProfileWorker } from './workers/persona-profile.worker'

console.log('🚀 Workers started')
console.log('  ✓ channel-scrape')
console.log('  ✓ video-transcript')
console.log('  ✓ chunk-and-embed')
console.log('  ✓ persona-profile')
console.log(`  YouTube auth: ${process.env.YT_COOKIES ? '✅ cookies configured' : '⚠️  no YT_COOKIES — may be blocked on datacenter IPs'}`)

process.on('SIGTERM', async () => {
  console.log('Shutting down workers...')
  await Promise.all([
    channelScrapeWorker.close(),
    videoTranscriptWorker.close(),
    chunkEmbedWorker.close(),
    personaProfileWorker.close(),
  ])
  process.exit(0)
})
