import { Module, Global } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool } from 'pg'

export const DB_POOL = 'DB_POOL'

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          host: config.get('DB_HOST', 'localhost'),
          port: config.get<number>('DB_PORT', 5432),
          database: config.get('DB_NAME', 'persona_ai'),
          user: config.get('DB_USER', 'persona'),
          password: config.get('DB_PASSWORD', 'persona_dev'),
        }),
    },
  ],
  exports: [DB_POOL],
})
export class DbModule {}
