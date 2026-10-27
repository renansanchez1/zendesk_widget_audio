// Backend de voz — demo da variante A1 (Webview action + gravador próprio).
// Fluxo: oferta (Webview action) → gravador chama getContext → POST /api/voice-sessions
// → grava → POST /api/voice-messages → UploadAttachment + PostMessage(author.type=user).

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { ContextError, verifyContext } from './context.js';
import { probeDurationMs, sniffAudio } from './audio.js';
import { store } from './store.js';
import { HttpError, postUserFileMessage, sendVoiceOffer, uploadAttachment } from './zendesk.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const SESSION_TTL_SEC = 600;
const IDEM_TTL_SEC = 24 * 3600;
const OFFER_KEYWORDS = /\b(áudio|audio|voz|gravar)\b/i;

interface VoiceSession {
  userId: string;
  conversationId: string;
  offerId: string;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- Páginas ----------

// Página de teste: carrega o Web Widget da conta (ze-snippet).
app.get('/', async (_req, res) => {
  const html = await readFile(PUBLIC_DIR + 'index.html', 'utf8');
  res
    .type('html')
    .send(
      html
        .replaceAll('__ZENDESK_WIDGET_KEY__', encodeURIComponent(config.widgetKey))
        .replaceAll('__DEMO_OFFER_ENDPOINT__', String(config.demoOfferEndpoint)),
    );
});

// Gravador aberto como Webview pelo widget.
app.get('/recorder', (_req, res) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://static.zdassets.com",
      "connect-src 'self' https://static.zdassets.com",
      "media-src 'self' blob:",
      "img-src 'self' data:",
      "style-src 'self'",
      `frame-ancestors ${config.frameAncestors}`,
    ].join('; '),
    'Permissions-Policy': 'microphone=(self)',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.sendFile(PUBLIC_DIR + 'recorder.html');
});

app.use('/assets', express.static(PUBLIC_DIR + 'assets', { maxAge: '5m' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- API do gravador ----------

const sessionLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.post('/api/voice-sessions', sessionLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  const correlationId = randomUUID();
  try {
    const ctx = await verifyContext(String(req.body?.contextToken ?? ''));
    // Nonce da oferta; se a metadata não vier no token, o id da mensagem de oferta serve de chave.
    const offerId = String(ctx.messageMetadata?.voiceOfferId ?? ctx.messageId ?? '');
    if (!offerId) return res.status(401).json({ error: 'context_invalid' });
    if (store.get(`offer-used:${offerId}`)) return res.status(409).json({ error: 'offer_already_used' });

    const sessionId = `vs_${randomUUID()}`;
    const session: VoiceSession = { userId: ctx.appuserId, conversationId: ctx.conversationId, offerId };
    store.set(`vs:${sessionId}`, JSON.stringify(session), SESSION_TTL_SEC);
    log('voice_session_created', { correlationId, conv: hash(ctx.conversationId), user: hash(ctx.appuserId) });

    return res.status(201).json({
      sessionId,
      expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString(),
      maxDurationSec: config.maxDurationSec,
      maxBytes: config.maxBytes,
    });
  } catch (e) {
    const code = e instanceof ContextError ? e.code : 'context_invalid';
    log('voice_session_rejected', { correlationId, code, detail: (e as Error).message });
    return res.status(401).json({ error: code });
  }
});

// Autentica a sessão e a Idempotency-Key ANTES de aceitar o corpo do upload.
function requireVoiceSession(req: Request, res: Response, next: NextFunction) {
  const idemKey = req.header('Idempotency-Key') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(idemKey)) return res.status(400).json({ error: 'missing_idempotency_key' });
  const sid = (req.header('Authorization') ?? '').replace(/^VoiceSession\s+/, '');
  const raw = sid && store.get(`vs:${sid}`);
  if (!raw) return res.status(401).json({ error: 'session_expired' });
  res.locals.session = JSON.parse(raw) as VoiceSession;
  res.locals.idemRedisKey = `idem:${sid}:${idemKey}`;
  next();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxBytes, files: 1 } });

app.post('/api/voice-messages', uploadLimiter, requireVoiceSession, upload.single('audio'), async (req, res) => {
  const correlationId = req.header('X-Correlation-Id') || randomUUID();
  const session = res.locals.session as VoiceSession;
  const idemKey = res.locals.idemRedisKey as string;

  // Idempotência (RF-009): mesma chave → mesmo resultado, nunca duas mensagens.
  const prior = store.get(idemKey);
  if (prior === 'processing') return res.status(202).json({ status: 'processing' });
  if (prior) return res.status(200).json({ ...JSON.parse(prior), replayed: true });
  if (!store.setIfAbsent(idemKey, 'processing', 120)) return res.status(202).json({ status: 'processing' });

  try {
    if (store.get(`offer-used:${session.offerId}`)) throw new HttpError(409, 'offer_already_used');
    const file = req.file;
    if (!file) throw new HttpError(400, 'invalid_audio');

    const sniffed = await sniffAudio(file.buffer);
    if (!sniffed) throw new HttpError(415, 'unsupported_media_type');

    const declaredMs = Number(req.body?.durationMs);
    const realMs = (await probeDurationMs(file.buffer, sniffed.ext).catch(() => {
      throw new HttpError(400, 'invalid_audio');
    })) ?? declaredMs;
    if (!Number.isFinite(realMs) || realMs < 1000 || realMs > config.maxDurationSec * 1000 + 2000) {
      throw new HttpError(400, 'invalid_duration');
    }

    // Reaproveita o upload se uma tentativa anterior já subiu o arquivo e falhou só no PostMessage.
    let mediaUrl = store.get(`${idemKey}:media`);
    if (!mediaUrl) {
      const attachment = await uploadAttachment(
        session.conversationId,
        file.buffer,
        sniffed.mediaType,
        `mensagem-de-voz.${sniffed.ext}`,
      );
      mediaUrl = attachment.mediaUrl;
      store.set(`${idemKey}:media`, mediaUrl, IDEM_TTL_SEC);
    }

    const seconds = Math.round(realMs / 1000);
    const messageId = await postUserFileMessage(
      session.conversationId,
      session.userId,
      mediaUrl,
      `Mensagem de voz (${seconds} s)`,
      { voiceMessage: true, durationMs: Math.round(realMs), voiceOfferId: session.offerId },
    );

    const result = { messageId, mediaType: sniffed.mediaType, durationMs: Math.round(realMs), correlationId };
    store.set(idemKey, JSON.stringify(result), IDEM_TTL_SEC);
    store.set(`offer-used:${session.offerId}`, '1', IDEM_TTL_SEC);
    log('voice_message_published', {
      correlationId,
      conv: hash(session.conversationId),
      ms: Math.round(realMs),
      bytes: file.size,
      mime: sniffed.mediaType,
    });
    return res.status(201).json(result);
  } catch (e) {
    store.delete(idemKey); // libera para retry; o :media fica para reaproveitar o upload
    const err = e instanceof HttpError ? e : new HttpError(500, 'internal');
    log('voice_message_failed', { correlationId, code: err.code, detail: (e as Error).message });
    return res.status(err.status).json({ error: err.code, retryable: err.retryable, correlationId });
  }
});

// ---------- Webhook (opcional): envia a oferta quando o cliente fala em "áudio" ----------

function validWebhookKey(received: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(config.webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface WebhookEvent {
  id: string;
  type: string;
  payload?: {
    conversation?: { id: string };
    message?: { author?: { type?: string }; content?: { type?: string; text?: string } };
  };
}

app.post('/webhooks/zendesk', express.json({ limit: '1mb' }), (req, res) => {
  if (!config.webhookSecret || !validWebhookKey(req.header('X-API-Key') ?? '')) {
    return res.status(401).end();
  }
  res.status(200).end(); // responde rápido; processa em seguida

  const events = (req.body?.events ?? []) as WebhookEvent[];
  for (const event of events) {
    const message = event.payload?.message;
    const conversationId = event.payload?.conversation?.id;
    if (event.type !== 'conversation:message' || !conversationId) continue;
    if (message?.author?.type !== 'user' || message.content?.type !== 'text') continue;
    if (!OFFER_KEYWORDS.test(message.content.text ?? '')) continue;
    if (!store.setIfAbsent(`evt:${event.id}`, '1', 3600)) continue; // reentrega do webhook

    sendVoiceOffer(conversationId)
      .then((messageId) => log('voice_offer_sent', { conv: hash(conversationId), messageId, via: 'webhook' }))
      .catch((e) => log('voice_offer_failed', { conv: hash(conversationId), detail: (e as Error).message }));
  }
});

// ---------- Só demo: botão "enviar convite" da página de teste ----------
// Aceita o conversationId do navegador, mas só publica a oferta (texto + botão do business);
// o áudio continua exigindo o token verificado do getContext daquela conversa.

if (config.demoOfferEndpoint) {
  const offerLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  app.post('/api/demo/offers', offerLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    const conversationId = String(req.body?.conversationId ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(conversationId)) return res.status(400).json({ error: 'invalid_conversation' });
    try {
      const messageId = await sendVoiceOffer(conversationId);
      log('voice_offer_sent', { conv: hash(conversationId), messageId, via: 'demo_page' });
      return res.status(201).json({ messageId });
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal');
      log('voice_offer_failed', { conv: hash(conversationId), detail: (e as Error).message });
      return res.status(err.status).json({ error: err.code });
    }
  });
}

// ---------- Erros ----------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'too_large' : 'invalid_audio' });
  }
  log('unhandled_error', { detail: (err as Error)?.message });
  res.status(500).json({ error: 'internal' });
});

app.listen(config.port, () => {
  log('server_started', { port: config.port, subdomain: config.subdomain, publicBaseUrl: config.publicBaseUrl });
});
