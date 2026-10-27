// Verificação do token de WebviewSdk.getContext (ADR-005, RNF-002).
// O token é um JWT RS256 assinado pela Zendesk; as chaves públicas ficam em
// https://{subdomain do claim}.zendesk.com/.well-known/jwks.json (limite: 5 req/min → cache).

import jwt, { type JwtPayload } from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { config, JWKS_URI_OVERRIDE } from './config.js';
import { isParticipant } from './zendesk.js';

export interface ZdContext extends JwtPayload {
  /** Normalizado: o token real traz `appUserId`; a documentação cita `appuserId`. */
  appuserId: string;
  appUserId?: string;
  subdomain: string;
  appId: string;
  integrationId?: string;
  conversationId: string;
  messageId?: string;
  messageMetadata?: Record<string, unknown>;
}

export class ContextError extends Error {
  constructor(public code: 'context_invalid' | 'context_expired', detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

// Um cliente JWKS (com cache) por subdomínio permitido; nunca para subdomínios fora da lista.
const jwksClients = new Map<string, jwksRsa.JwksClient>();
function jwksFor(subdomain: string): jwksRsa.JwksClient {
  let client = jwksClients.get(subdomain);
  if (!client) {
    client = jwksRsa({
      jwksUri: JWKS_URI_OVERRIDE || `https://${subdomain}.zendesk.com/.well-known/jwks.json`,
      cache: true,
      cacheMaxEntries: 10,
      cacheMaxAge: 10 * 60_000,
      rateLimit: true,
      jwksRequestsPerMinute: 4,
    });
    jwksClients.set(subdomain, client);
  }
  return client;
}

export async function verifyContext(token: string): Promise<ZdContext> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string' || typeof decoded.payload === 'string') {
    throw new ContextError('context_invalid', 'not_a_jwt');
  }
  const claims = normalize(decoded.payload as ZdContext);
  const diag = `kid=${decoded.header.kid ?? '-'} alg=${decoded.header.alg} subdomain=${claims.subdomain} ` +
    `appIdOk=${claims.appId === config.appId} claims=${Object.keys(claims).join(',')}`;

  // O token precisa ser desta conta e deste app; IDs nunca vêm do corpo da requisição (CA-11).
  if (claims.appId !== config.appId || !config.tokenSubdomains.includes(claims.subdomain)) {
    throw new ContextError('context_invalid', `wrong_account ${diag}`);
  }
  if (!claims.conversationId || !claims.appuserId) throw new ContextError('context_invalid', `missing_claims ${diag}`);

  try {
    const key = await jwksFor(claims.subdomain).getSigningKey(decoded.header.kid);
    return normalize(jwt.verify(token, key.getPublicKey(), { algorithms: ['RS256'] }) as ZdContext);
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TokenExpiredError') throw new ContextError('context_expired', diag);
    if (name === 'SigningKeyNotFoundError' || name === 'JwksError') {
      if (config.demoAllowUnverifiedContext) return unverifiedDemoFallback(claims, diag);
      throw new ContextError('context_invalid', `signing_key_not_found ${diag}`);
    }
    throw new ContextError('context_invalid', `${name} ${diag}`);
  }
}

function normalize(claims: ZdContext): ZdContext {
  return { ...claims, appuserId: claims.appUserId ?? claims.appuserId };
}

/**
 * SÓ DEMO (DEMO_ALLOW_UNVERIFIED_CONTEXT=true): o JWKS da conta não publicou a chave do token.
 * Sem assinatura, compensamos conferindo exp e perguntando à API se o usuário do token participa
 * da conversa do token. Ainda é forjável por quem souber os dois IDs — não usar em produção.
 */
async function unverifiedDemoFallback(claims: ZdContext, diag: string): Promise<ZdContext> {
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new ContextError('context_expired', diag);
  const ok = await isParticipant(claims.conversationId, claims.appuserId).catch(() => false);
  if (!ok) throw new ContextError('context_invalid', `not_participant ${diag}`);
  console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'context_unverified_demo_fallback', diag }));
  return claims;
}
