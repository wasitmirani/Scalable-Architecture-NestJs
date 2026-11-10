import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { TenantScoped } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/user.decorator';
import type { TenantContext } from '../../common/types/principal';
import { ApiResponse } from '../../common/utils/api.response';
import { channelAccountsCollection } from '../channels/channel-accounts';
import { fieldError, text } from '../records/record-store';
import { RecordsService } from '../records/records.service';
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL } from './email-transport';
import { publicApiUrl } from './unsubscribe-token';

type OAuthProvider = 'gmail' | 'outlook';

const CONFIG: Record<
  OAuthProvider,
  {
    env: string;
    label: string;
    authorize: string;
    token: string;
    scope: string;
    extra: Record<string, string>;
  }
> = {
  gmail: {
    env: 'GOOGLE',
    label: 'Gmail',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: GOOGLE_TOKEN_URL,
    scope: 'openid email https://mail.google.com/',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  outlook: {
    env: 'MICROSOFT',
    label: 'Outlook',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: MICROSOFT_TOKEN_URL,
    scope:
      'openid email profile offline_access https://outlook.office.com/SMTP.Send',
    extra: { response_mode: 'query', prompt: 'select_account' },
  },
};

const STATE_TTL_MS = 10 * 60_000;

function isProvider(p: string): p is OAuthProvider {
  return p === 'gmail' || p === 'outlook';
}

function app(p: OAuthProvider) {
  const id = process.env[`${CONFIG[p].env}_OAUTH_CLIENT_ID`] ?? '';
  const secret = process.env[`${CONFIG[p].env}_OAUTH_CLIENT_SECRET`] ?? '';
  return id && secret ? { id, secret } : null;
}

const redirectUri = (p: OAuthProvider) =>
  `${publicApiUrl()}/oauth/email/${p}/callback`;
const stateKey = () =>
  process.env.SECRETS_ENCRYPTION_KEY ||
  `linqflow-dev-oauth:${process.env.JWT_SECRET ?? ''}`;

interface State {
  t: string; // tenant
  p: OAuthProvider;
  n: string; // display name
  e: number; // expiry
  r: string; // nonce
}

function signState(s: State) {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${body}.${createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
}

function readState(raw: string): State | null {
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(
    createHmac('sha256', stateKey()).update(body).digest('base64url'),
  );
  if (
    expected.length !== Buffer.from(sig).length ||
    !timingSafeEqual(expected, Buffer.from(sig))
  )
    return null;
  const s = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf8'),
  ) as State;
  return s.e > Date.now() ? s : null;
}

/** Email address from the id_token returned by the token endpoint (received directly over TLS). */
function emailFromIdToken(idToken: unknown): string {
  const [, payload] = typeof idToken === 'string' ? idToken : ''.split('.');
  if (!payload) return '';
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  return text(claims.email || claims.preferred_username).toLowerCase();
}

/**
 * Connect Gmail or Outlook with OAuth 2.0. Sending uses their SMTP servers with
 * XOAUTH2 and the stored refresh token. Needs GOOGLE_OAUTH_CLIENT_ID/SECRET or
 * MICROSOFT_OAUTH_CLIENT_ID/SECRET, and the redirect URI
 * `<API_PUBLIC_URL>/oauth/email/<gmail|outlook>/callback` registered with the provider.
 */
@ApiTags('Channels')
@Controller()
@TenantScoped()
export class EmailOAuthStartController {
  constructor(private readonly records: RecordsService) {}

  /** `POST /api/v1/channel-accounts/oauth/:provider/start` → `{ url }` to open. */
  @Post('channel-accounts/oauth/:provider/start')
  @HttpCode(200)
  start(
    @Param('provider') provider: string,
    @Body() body: { name?: unknown },
    @CurrentTenant() t: TenantContext,
  ) {
    this.records.assertCan(t, 'channels.manage');
    if (!isProvider(provider))
      throw fieldError(
        422,
        'INVALID_PROVIDER',
        'provider',
        'Use gmail or outlook',
      );
    const creds = app(provider);
    if (!creds) {
      throw fieldError(
        409,
        'OAUTH_NOT_CONFIGURED',
        'provider',
        `${CONFIG[provider].label} sign-in is not configured on this server. Set ${CONFIG[provider].env}_OAUTH_CLIENT_ID and ${CONFIG[provider].env}_OAUTH_CLIENT_SECRET.`,
      );
    }
    const state = signState({
      t: t.tenantId,
      p: provider,
      n:
        text(body?.name).trim().slice(0, 80) ||
        `${CONFIG[provider].label} account`,
      e: Date.now() + STATE_TTL_MS,
      r: randomBytes(8).toString('hex'),
    });
    const url = new URL(CONFIG[provider].authorize);
    for (const [k, v] of Object.entries({
      client_id: creds.id,
      redirect_uri: redirectUri(provider),
      response_type: 'code',
      scope: CONFIG[provider].scope,
      state,
      ...CONFIG[provider].extra,
    }))
      url.searchParams.set(k, v);
    return ApiResponse.success({ url: url.toString() });
  }
}

/** Public OAuth redirect target: `GET /oauth/email/:provider/callback` (outside the API prefix). */
@ApiExcludeController()
@Public()
@Controller({ version: VERSION_NEUTRAL })
export class EmailOAuthCallbackController {
  constructor(private readonly records: RecordsService) {}

  @Get('oauth/email/:provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query() q: Record<string, string>,
    @Res() res: Response,
  ) {
    const back = (params: Record<string, string>) =>
      res.redirect(
        `${(process.env.FRONTEND_URL ?? '').replace(/\/$/, '')}/channels/email?${new URLSearchParams(params).toString()}`,
      );
    const state = q.state ? readState(q.state) : null;
    if (!isProvider(provider) || !state || state.p !== provider)
      return back({
        oauth_error: 'The sign-in link expired. Try connecting again.',
      });
    if (q.error) return back({ oauth_error: q.error_description || q.error });
    const creds = app(provider);
    if (!creds || !q.code)
      return back({
        oauth_error: 'Sign-in did not return an authorization code.',
      });

    try {
      const tokenRes = await fetch(CONFIG[provider].token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          client_id: creds.id,
          client_secret: creds.secret,
          redirect_uri: redirectUri(provider),
          ...(provider === 'outlook' ? { scope: CONFIG.outlook.scope } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const tokens = (await tokenRes.json()) as Record<string, unknown>;
      if (!tokenRes.ok)
        return back({
          oauth_error:
            text(tokens.error_description || tokens.error) ||
            'Token exchange failed.',
        });
      const refreshToken = text(tokens.refresh_token);
      const email = emailFromIdToken(tokens.id_token);
      if (!refreshToken || !email)
        return back({
          oauth_error:
            'The provider did not grant offline access. Try again and accept all permissions.',
        });

      const tenant = {
        tenantId: state.t,
        memberId: null,
        roleKey: null,
        permissions: new Set<string>(),
      };
      await this.records.run(
        tenant,
        `${CONFIG[provider].label} sign-in`,
        async (ctx) => {
          const data = await channelAccountsCollection.beforeCreate!(ctx, {
            channel: 'email',
            provider: CONFIG[provider].label,
            name: state.n,
            identifier: email,
            credentials: { email, refreshToken },
          });
          await ctx.store.insert('channel-accounts', data);
        },
      );
      return back({ connected: provider, account: email });
    } catch (error) {
      const e = error as {
        response?: {
          data?: { details?: { errors?: string[] }[]; message?: string };
        };
        message?: string;
      };
      return back({
        oauth_error:
          e?.response?.data?.message ?? e?.message ?? 'Connecting failed.',
      });
    }
  }
}
