// Verificação do token de WebviewSdk.getContext (ADR-005, RNF-002).
// O token é um JWT RS256 assinado pela Zendesk; as chaves públicas ficam em
// https://{subdomain}.zendesk.com/.well-known/jwks.json (limite: 5 req/min → cache).

import jwt, { type JwtPayload } from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { config, JWKS_URI } from './config.js';

export interface ZdContext extends JwtPayload {
  appuserId: string;
  subdomain: string;
  appId: string;
  integrationId?: string;
  conversationId: string;
  messageId?: string;
  messageMetadata?: Record<string, unknown>;
}

export class ContextError extends Error {
  constructor(public code: 'context_invalid' | 'context_expired') {
    super(code);
  }
}

const jwks = jwksRsa({
  jwksUri: JWKS_URI,
  cache: true,
  cacheMaxEntries: 10,
  cacheMaxAge: 10 * 60_000,
  rateLimit: true,
  jwksRequestsPerMinute: 4,
});

export async function verifyContext(token: string): Promise<ZdContext> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new ContextError('context_invalid');
  }

  let payload: ZdContext;
  try {
    const key = await jwks.getSigningKey(decoded.header.kid);
    payload = jwt.verify(token, key.getPublicKey(), { algorithms: ['RS256'] }) as ZdContext;
  } catch (e) {
    throw new ContextError((e as Error).name === 'TokenExpiredError' ? 'context_expired' : 'context_invalid');
  }

  // O token precisa ser desta conta e deste app; IDs nunca vêm do corpo da requisição (CA-11).
  if (payload.subdomain !== config.subdomain || payload.appId !== config.appId) {
    throw new ContextError('context_invalid');
  }
  if (!payload.conversationId || !payload.appuserId) throw new ContextError('context_invalid');
  return payload;
}
