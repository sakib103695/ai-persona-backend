import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { DbModule } from './db/db.module'
import { PersonasModule } from './personas/personas.module'
import { SourcesModule } from './sources/sources.module'
import { ChatModule } from './chat/chat.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    PersonasModule,
    SourcesModule,
    ChatModule,
  ],
})
export class AppModule {}
