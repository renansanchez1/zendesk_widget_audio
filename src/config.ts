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

export const config = {
  subdomain: required('ZD_SUBDOMAIN'),
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
};

// Overrides usados só pelos testes automatizados (servidor Zendesk simulado).
export const SC_BASE = optional('SC_BASE_URL', `https://${config.subdomain}.zendesk.com/sc`);
export const JWKS_URI = optional('ZD_JWKS_URI', `https://${config.subdomain}.zendesk.com/.well-known/jwks.json`);
