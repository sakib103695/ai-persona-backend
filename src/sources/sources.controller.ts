import { Controller, Post, Get, Delete, Param, Query, Body, HttpCode, Res, NotFoundException } from '@nestjs/common'
import { Response } from 'express'
import * as archiver from 'archiver'
import { SourcesService } from './sources.service'

@Controller('sources')
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Post('channel')
  importChannels(@Body() body: { urls: string[] }) {
    return this.sources.importChannels(body.urls)
  }

  /** POST /api/sources/add — add videos to an existing persona */
  @Post('add')
  addToPersona(@Body() body: { persona_id: string; url: string }) {
    return this.sources.addToPersona(body.persona_id, body.url)
  }

  /** GET /api/sources?persona_id=xxx&page=1&limit=50&filter=all */
  @Get()
  getByPersona(
    @Query('persona_id') personaId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('filter') filter?: string,
  ) {
    return this.sources.getByPersona(
      personaId,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 50,
      filter || 'all',
    )
  }

  /** POST /api/sources/download-transcripts — ZIP of multiple transcripts */
  @Post('download-transcripts')
  @HttpCode(200)
  async downloadTranscriptsZip(@Body() body: { source_ids: string[] }, @Res() res: Response) {
    const rows = await this.sources.getTranscripts(body.source_ids)
    if (rows.length === 0) throw new NotFoundException('No transcripts available for the selected sources')

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="transcripts.zip"`)

    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.pipe(res)

    for (const row of rows) {
      const filename = `${row.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_transcript.txt`
      archive.append(row.transcript_text!, { name: filename })
    }

    await archive.finalize()
  }

  /** GET /api/sources/:id/transcript — download transcript as plain text */
  @Get(':id/transcript')
  async downloadTranscript(@Param('id') sourceId: string, @Res() res: Response) {
    const { title, transcript_text } = await this.sources.getTranscript(sourceId)
    if (!transcript_text) throw new NotFoundException('No transcript available for this source')
    const filename = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_transcript.txt`
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(transcript_text)
  }

  /** GET /api/sources/status/:personaId — polled by ImportModal */
  @Get('status/:personaId')
  getStatus(@Param('personaId') personaId: string) {
    return this.sources.getImportStatus(personaId)
  }

  /** DELETE /api/sources — body: { source_ids: string[] } */
  @Delete()
  deleteSources(@Body() body: { source_ids: string[] }) {
    return this.sources.deleteSources(body.source_ids)
  }

  /** POST /api/sources/reprocess — body: { source_ids: string[] } */
  @Post('reprocess')
  reprocessSources(@Body() body: { source_ids: string[] }) {
    return this.sources.reprocessSources(body.source_ids)
  }

  /** POST /api/sources/rebuild/:personaId — rebuild all knowledge from transcripts */
  @Post('rebuild/:personaId')
  rebuildKnowledge(@Param('personaId') personaId: string) {
    return this.sources.rebuildKnowledge(personaId)
  }

  /** POST /api/sources/cancel/:personaId — stop an in-progress import safely */
  @Post('cancel/:personaId')
  @HttpCode(200)
  cancelImport(@Param('personaId') personaId: string) {
    return this.sources.cancelImport(personaId)
  }
}
