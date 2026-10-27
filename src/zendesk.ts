// Cliente mínimo da Sunshine Conversations API v2 (OpenAPI 17.13.2).
// Credenciais Basic (key id/secret) usadas só aqui, no servidor.

import { randomUUID } from 'node:crypto';
import { config, SC_BASE } from './config.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, public retryable = false) {
    super(code);
  }
}

const AUTH = 'Basic ' + Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');

async function scFetch(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(SC_BASE + path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: AUTH },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return res;

  const body = await res.text().catch(() => '');
  console.warn(`[zendesk] ${init.method ?? 'GET'} ${path.split('?')[0]} → ${res.status} ${body.slice(0, 300)}`);
  if (res.status === 404 || res.status === 423) throw new HttpError(409, 'conversation_unavailable');
  if (res.status === 413) throw new HttpError(413, 'too_large');
  if (res.status >= 500 || res.status === 429) throw new HttpError(502, 'zendesk_upstream', true);
  throw new HttpError(502, 'zendesk_rejected');
}

const appPath = `/v2/apps/${encodeURIComponent(config.appId)}`;

/** UploadAttachment: POST /v2/apps/{appId}/attachments (campo multipart `source`). */
export async function uploadAttachment(
  conversationId: string,
  data: Buffer,
  mediaType: string,
  filename: string,
): Promise<{ mediaUrl: string; mediaType: string }> {
  const form = new FormData();
  form.append('source', new Blob([new Uint8Array(data)], { type: mediaType }), filename);
  const query = new URLSearchParams({ access: 'public', for: 'message', conversationId });
  const res = await scFetch(`${appPath}/attachments?${query}`, { method: 'POST', body: form });
  const { attachment } = (await res.json()) as { attachment: { mediaUrl: string; mediaType: string } };
  return attachment;
}

/** PostMessage com autoria do end user (author.type = user). Nunca "business" simulando o cliente. */
export async function postUserFileMessage(
  conversationId: string,
  userId: string,
  mediaUrl: string,
  altText: string,
  metadata: Record<string, string | number | boolean>,
): Promise<string> {
  const res = await scFetch(`${appPath}/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: { type: 'user', userId },
      content: { type: 'file', mediaUrl, altText },
      metadata,
    }),
  });
  const { messages } = (await res.json()) as { messages: Array<{ id: string }> };
  return messages[0].id;
}

/** ListParticipants: o usuário (userId v2) participa da conversa? */
export async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const res = await scFetch(`${appPath}/conversations/${encodeURIComponent(conversationId)}/participants`, {
    method: 'GET',
  });
  const { participants } = (await res.json()) as { participants: Array<{ userId: string }> };
  return participants.some((p) => p.userId === userId);
}

/**
 * Mensagem de oferta (seção 5.1): texto do "business" com uma Webview action que abre o gravador.
 * O voiceOfferId volta em messageMetadata dentro do token do getContext.
 */
export async function sendVoiceOffer(conversationId: string): Promise<string> {
  if (!config.publicBaseUrl) throw new Error('PUBLIC_BASE_URL não configurada');
  const voiceOfferId = randomUUID();
  const recorderUrl = `${config.publicBaseUrl}/recorder`;
  const res = await scFetch(`${appPath}/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: { type: 'business' },
      content: {
        type: 'text',
        text: 'Prefere falar? Envie uma mensagem de voz:',
        actions: [
          {
            type: 'webview',
            text: '🎙️ Gravar áudio',
            uri: recorderUrl,
            fallback: `${recorderUrl}?fallback=1`,
            size: 'tall',
          },
        ],
      },
      metadata: { voiceOfferId },
    }),
  });
  const { messages } = (await res.json()) as { messages: Array<{ id: string }> };
  return messages[0].id;
}
