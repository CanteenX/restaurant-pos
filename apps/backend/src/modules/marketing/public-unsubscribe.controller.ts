import { Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MarketingService } from './marketing.service';

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body></html>`;

// Deliberately unauthenticated: a recipient clicking the link in an email has
// no account. The signed, expiring per-recipient token is the credential, and
// the responses never say whether a customer exists.
@ApiTags('public')
@Controller('v1/public/unsubscribe')
export class PublicUnsubscribeController {
  constructor(private readonly marketing: MarketingService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async page(@Param('token') token: string) {
    return (await this.marketing.unsubscribe(token))
      ? page(
          'You are unsubscribed',
          'You will no longer receive marketing messages from us.',
        )
      : page(
          'Link not valid',
          'This unsubscribe link is invalid or has expired.',
        );
  }

  // RFC 8058 one-click: mail clients POST `List-Unsubscribe=One-Click`.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':token')
  @HttpCode(200)
  async oneClick(@Param('token') token: string) {
    await this.marketing.unsubscribe(token);
    return { ok: true };
  }
}
