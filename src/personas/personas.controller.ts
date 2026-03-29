import { Controller, Get, Param } from '@nestjs/common'
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
}
