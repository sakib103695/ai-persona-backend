import { Module } from '@nestjs/common'
import { SourcesController } from './sources.controller'
import { SourcesService } from './sources.service'
import { PersonasModule } from '../personas/personas.module'

@Module({
  imports: [PersonasModule],
  controllers: [SourcesController],
  providers: [SourcesService],
  exports: [SourcesService],
})
export class SourcesModule {}
