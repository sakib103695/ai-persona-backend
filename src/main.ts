import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { json } from 'express'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.use(json({ limit: '500mb' }))
  app.setGlobalPrefix('api')
  app.enableCors({
    origin: process.env.NODE_ENV === 'production'
      ? true
      : 'http://localhost:3000',
  })
  await app.listen(4000)
  console.log('API running on http://localhost:4000')
  if (process.send) process.send('ready')
}

bootstrap()
