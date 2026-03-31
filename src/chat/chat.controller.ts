import { Controller, Post, Get, Body, Param, Res, HttpCode } from '@nestjs/common'
import { Response } from 'express'
import { ChatService } from './chat.service'

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('sessions')
  createSession(@Body() body: { persona_ids: string[]; mode: 'learn' | 'advisor' | 'research'; source_ids?: string[] }) {
    return this.chat.createSession(body.persona_ids, body.mode, body.source_ids)
  }

  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    return this.chat.getSession(id)
  }

  @Get('sessions/:id/messages')
  getMessages(@Param('id') id: string) {
    return this.chat.getMessages(id)
  }

  @Post('sessions/:id/messages')
  @HttpCode(200)
  async sendMessage(
    @Param('id') sessionId: string,
    @Body() body: { message: string },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    try {
      for await (const event of this.chat.streamResponse(sessionId, body.message)) {
        res.write(`data: ${event}\n\n`)
      }
      res.write('data: [DONE]\n\n')
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
    }

    res.end()
  }
}
