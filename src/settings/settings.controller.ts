import { Controller, Get, Patch, Body } from '@nestjs/common'
import { SettingsService } from './settings.service'

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  getAll() {
    return this.settings.getAll()
  }

  @Patch()
  async update(@Body() body: Record<string, string>) {
    for (const [key, value] of Object.entries(body)) {
      await this.settings.set(key, value)
    }
    return this.settings.getAll()
  }

  @Get('models')
  getModels() {
    return this.settings.fetchOpenRouterModels()
  }
}
