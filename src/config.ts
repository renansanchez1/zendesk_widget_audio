// Configuração lida das variáveis de ambiente (ver .env.example).
// Segredos ficam só no servidor — nada aqui é enviado ao navegador (RNF-001).

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

const subdomain = required('ZD_SUBDOMAIN');

export const config = {
  subdomain,
  // Subdomínios aceitos no claim `subdomain` do token (a conta pode ter mais de um, ex.: o original).
  tokenSubdomains: optional('ZD_TOKEN_SUBDOMAINS', subdomain).split(',').map((s) => s.trim()).filter(Boolean),
  appId: required('SC_APP_ID'),
  keyId: required('SC_KEY_ID'),
  keySecret: required('SC_KEY_SECRET'),
  widgetKey: optional('ZENDESK_WIDGET_KEY'),
  publicBaseUrl: optional('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  port: Number(optional('PORT', '8080')),
  webhookSecret: optional('WEBHOOK_SECRET'),
  maxDurationSec: Number(optional('MAX_DURATION_SEC', '180')),
  maxBytes: Number(optional('MAX_BYTES', String(10 * 1024 * 1024))),
  frameAncestors: optional('FRAME_ANCESTORS', '*'),
  // Só demo: deixa a página de teste pedir a oferta para a conversa aberta no widget.
  demoOfferEndpoint: optional('DEMO_OFFER_ENDPOINT') === 'true',
  // Só demo: se o JWKS da conta não tiver a chave do token, aceita o token sem assinatura
  // desde que a API confirme que o usuário participa da conversa. NÃO usar em produção.
  demoAllowUnverifiedContext: optional('DEMO_ALLOW_UNVERIFIED_CONTEXT') === 'true',
};

// Overrides usados só pelos testes automatizados (servidor Zendesk simulado).
export const SC_BASE = optional('SC_BASE_URL', `https://${config.subdomain}.zendesk.com/sc`);
export const JWKS_URI_OVERRIDE = optional('ZD_JWKS_URI');
