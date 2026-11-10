import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { promises as dnsPromises } from 'dns';
import { TenantScoped } from '../../common/decorators/roles.decorator';
import {
  CurrentPrincipal,
  CurrentTenant,
} from '../../common/decorators/user.decorator';
import type { Principal, TenantContext } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import type { HookContext } from '../records/collection.types';
import { RecordsService } from '../records/records.service';

interface DnsRecord {
  type: 'TXT' | 'CNAME' | 'MX';
  purpose: string;
  host: string;
  value: string;
  status: 'pending' | 'verified' | 'failed';
}

const LOOKUP_TIMEOUT_MS = 5000;
const norm = (v: string) => v.trim().replace(/\.$/, '').toLowerCase();

/**
 * System resolver first. Some hosts point it at a local proxy that refuses direct
 * queries (Docker, VPNs), so refused/failed lookups retry on public resolvers
 * (`DNS_FALLBACK_SERVERS`, comma separated; default Cloudflare and Google).
 */
const system = new dnsPromises.Resolver({
  timeout: LOOKUP_TIMEOUT_MS,
  tries: 1,
});
const fallback = new dnsPromises.Resolver({
  timeout: LOOKUP_TIMEOUT_MS,
  tries: 1,
});
fallback.setServers(
  (process.env.DNS_FALLBACK_SERVERS || '1.1.1.1,8.8.8.8')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const RETRY_CODES = new Set([
  'ECONNREFUSED',
  'ESERVFAIL',
  'ETIMEOUT',
  'ECONNRESET',
  'EREFUSED',
]);

async function resolveWith<T>(
  query: (r: InstanceType<typeof dnsPromises.Resolver>) => Promise<T>,
): Promise<T> {
  try {
    return await withTimeout(query(system));
  } catch (error) {
    const code =
      (error as { code?: string; message?: string }).code ??
      (error as Error).message;
    if (!RETRY_CODES.has(code)) throw error;
    return withTimeout(query(fallback));
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('ETIMEOUT')), LOOKUP_TIMEOUT_MS + 1000),
    ),
  ]);
}

/**
 * Resolves one record. Missing records stay `pending` (not published yet);
 * a record that exists with a different value is `failed`.
 */
async function check(record: DnsRecord): Promise<DnsRecord['status']> {
  try {
    if (record.type === 'TXT') {
      const values = (await resolveWith((r) => r.resolveTxt(record.host))).map(
        (chunks) => chunks.join(''),
      );
      if (record.purpose === 'spf') {
        const spf = values.find((v) => v.toLowerCase().startsWith('v=spf1'));
        const include = record.value
          .split(/\s+/)
          .find((p) => p.startsWith('include:'));
        if (!spf) return 'pending';
        return include && spf.toLowerCase().includes(include.toLowerCase())
          ? 'verified'
          : 'failed';
      }
      if (record.purpose === 'dmarc') {
        return values.some((v) => v.toLowerCase().startsWith('v=dmarc1'))
          ? 'verified'
          : 'failed';
      }
      return values.some((v) => norm(v) === norm(record.value))
        ? 'verified'
        : 'failed';
    }
    if (record.type === 'CNAME') {
      const values = await resolveWith((r) => r.resolveCname(record.host));
      return values.some((v) => norm(v) === norm(record.value))
        ? 'verified'
        : 'failed';
    }
    const mx = await resolveWith((r) => r.resolveMx(record.host));
    return mx.some((m) => norm(m.exchange) === norm(record.value))
      ? 'verified'
      : 'failed';
  } catch {
    // ENOTFOUND / ENODATA / timeout: nothing published (yet).
    return 'pending';
  }
}

/** Channel setup actions (docs/API-CONTRACT.md, Phases 4–7). */
@ApiTags('Channels')
@Controller()
@TenantScoped()
export class ChannelsController {
  constructor(private readonly records: RecordsService) {}

  /** Looks up the sending domain's DNS records for real. */
  @Post('sender-domains/:id/verify')
  @HttpCode(200)
  async verify(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    // Resolve outside the transaction: DNS can take seconds.
    const domain = await this.records.exec(
      tenant,
      principal,
      'channels.manage',
      (ctx) => ctx.store.find('sender-domains', id),
    );
    const current = (domain.records as DnsRecord[]) ?? [];
    const records = await Promise.all(
      current.map(async (r) => ({ ...r, status: await check(r) })),
    );
    const status = records.every((r) => r.status === 'verified')
      ? 'verified'
      : records.some((r) => r.status === 'failed')
        ? 'failed'
        : 'pending';
    return ApiResponse.success(
      await this.records.exec(tenant, principal, 'channels.manage', (ctx) =>
        ctx.store.patch('sender-domains', id, {
          records,
          status,
          lastCheckedAt: new Date().toISOString(),
        }),
      ),
    );
  }

  /**
   * Provider health check. Provider APIs are not connected yet, so this records
   * the check time and returns the account as stored.
   */
  @Post('channel-accounts/:id/check')
  @HttpCode(200)
  async check(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ) {
    return ApiResponse.success(
      await this.records.exec(
        tenant,
        principal,
        'channels.manage',
        (ctx: HookContext) =>
          ctx.store.patch('channel-accounts', id, {
            lastCheckedAt: new Date().toISOString(),
          }),
      ),
    );
  }
}
