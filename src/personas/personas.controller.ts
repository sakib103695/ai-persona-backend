import { Controller, Get, Patch, Delete, Param, Body } from '@nestjs/common'
import { PersonasService } from './personas.service'

@Controller('personas')
export class PersonasController {
  constructor(private readonly personas: PersonasService) {}

  @Get()
  findAll() {
    return this.personas.findAll()
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
