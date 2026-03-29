import { Controller, Post, Get, Param, Query, Body } from '@nestjs/common'
import { SourcesService } from './sources.service'

@Controller('sources')
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Post('channel')
  importChannels(@Body() body: { urls: string[] }) {
    return this.sources.importChannels(body.urls)
  }

  /** GET /api/sources?persona_id=xxx — used by persona detail page */
  @Get()
  getByPersona(@Query('persona_id') personaId: string) {
    return this.sources.getByPersona(personaId)
  }

  /** GET /api/sources/status/:personaId — polled by ImportModal */
  @Get('status/:personaId')
  getStatus(@Param('personaId') personaId: string) {
    return this.sources.getImportStatus(personaId)
  }
}
