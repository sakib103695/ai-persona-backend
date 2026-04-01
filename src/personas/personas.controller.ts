import { Controller, Get, Post, Patch, Delete, Param, Body, Res, Query } from '@nestjs/common'
import { Response } from 'express'
import { PersonasService } from './personas.service'

@Controller('personas')
export class PersonasController {
  constructor(private readonly personas: PersonasService) {}

  @Get()
  findAll() {
    return this.personas.findAll()
  }

  @Get('export')
  async exportAll(@Res() res: Response, @Query('ids') ids?: string) {
    const idList = ids ? ids.split(',').filter(Boolean) : undefined
    const data = await this.personas.exportAll(idList)
    const json = JSON.stringify(data, null, 2)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="persona-export-${Date.now()}.json"`)
    res.send(json)
  }

  @Post('import')
  async importAll(@Body() body: any[]) {
    return this.personas.importAll(body)
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.personas.findOne(id)
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; bio?: string; tags?: string[]; avatar_url?: string },
  ) {
    return this.personas.update(id, body)
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.personas.delete(id)
  }
}
