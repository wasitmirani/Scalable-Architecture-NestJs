import { Controller, Get, HttpCode, Param, Post, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { Public } from '../../common/decorators/public.decorator';
import { RecordsService } from '../records/records.service';
import { escapeHtml } from './email-render';
import { readUnsubscribeToken } from './unsubscribe-token';

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1d2939;padding:16px}
  main{max-width:420px;width:100%;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:32px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
  h1{font-size:20px;margin:0 0 8px;color:#101828}p{margin:0 0 20px;color:#5d6b82}
  button{font:inherit;font-weight:600;color:#fff;background:#4f46e5;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
  button:hover{background:#4338ca}button:focus-visible{outline:3px solid rgba(79,70,229,.35);outline-offset:2px}
</style></head><body><main>${body}</main></body></html>`;

/**
 * Unsubscribe links from marketing email (RFC 8058). GET only shows a
 * confirmation, because link scanners prefetch URLs; POST unsubscribes, from the
 * button or from the mail client's one-click `List-Unsubscribe-Post`.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'unsubscribe', version: VERSION_NEUTRAL })
export class UnsubscribeController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly records: RecordsService,
  ) {}

  private async workspaceName(tenantId: string) {
    const [row] = await this.dataSource.query<{ name: string }[]>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    return row?.name ?? null;
  }

  @Get(':token')
  async confirm(@Param('token') token: string, @Res() res: Response) {
    const who = readUnsubscribeToken(token);
    const name = who && (await this.workspaceName(who.tenantId));
    res.setHeader('Cache-Control', 'no-store');
    if (!who || !name) {
      res.status(404).type('html').send(page('Link not valid', '<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>'));
      return;
    }
    res.type('html').send(
      page(
        'Unsubscribe',
        `<h1>Unsubscribe from ${escapeHtml(name)}?</h1><p>You will stop receiving marketing emails from ${escapeHtml(name)}. Messages you need about your account may still arrive.</p>
         <form method="post"><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  }

  @Post(':token')
  @HttpCode(200)
  async unsubscribe(@Param('token') token: string, @Res() res: Response) {
    const who = readUnsubscribeToken(token);
    const name = who && (await this.workspaceName(who.tenantId));
    if (!who || !name) {
      res.status(404).type('html').send(page('Link not valid', '<h1>This link is not valid</h1>'));
      return;
    }
    const tenant = { tenantId: who.tenantId, memberId: null, roleKey: null, permissions: new Set<string>() };
    await this.records.run(tenant, 'Unsubscribe link', async (ctx) => {
      const contact = await ctx.store.findOrNull('contacts', who.contactId);
      if (!contact) return;
      const consents = (contact.consents ?? {}) as Record<string, string>;
      if (consents.email === 'unsubscribed') return; // idempotent: mail clients may retry
      const at = new Date().toISOString();
      await ctx.store.patch('contacts', contact.id, { consents: { ...consents, email: 'unsubscribed' }, lastActivityAt: at });
      await ctx.store.insert('activities', {
        contactId: contact.id,
        type: 'unsubscribed',
        channel: 'email',
        title: 'Unsubscribed from email',
        description: 'Used the unsubscribe link in an email.',
        authorName: 'Contact',
        at,
      });
    });
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(page('Unsubscribed', `<h1>You are unsubscribed</h1><p>You will no longer receive marketing emails from ${escapeHtml(name)}.</p>`));
  }
}
