// Teste ponta a ponta do backend contra uma Zendesk simulada (JWKS + Sunshine API v2).
// Requer ffmpeg no PATH para gerar os áudios de teste.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

const SUBDOMAIN = 'con-renansanchez';
const APP_ID = 'app_test_123';
const KID = 'test-key-1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

interface Recorded {
  path: string;
  body: Buffer;
}
const uploads: Recorded[] = [];
const messages: Array<{ path: string; json: any }> = [];
let failNextPostMessage = false;

let mock: Server;
let mockUrl = '';
const apps: ChildProcess[] = [];
let baseUrl = '';
const tmp = mkdtempSync(join(tmpdir(), 'voz-test-'));

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function makeAudio(name: string, seconds: number): Buffer {
  const file = join(tmp, name);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libopus', file]);
  return readFileSync(file);
}

function contextToken(
  overrides: Record<string, unknown> = {},
  expiresIn: string | number = '5m',
  signingKey = privateKey,
  kid = KID,
): string {
  return jwt.sign(
    {
      appUserId: 'user_abc', // nome real do claim no token da Zendesk
      subdomain: SUBDOMAIN,
      appId: APP_ID,
      integrationId: 'int_1',
      conversationId: 'conv_123456789',
      messageId: 'msg_offer_1',
      messageMetadata: { voiceOfferId: randomUUID() },
      ...overrides,
    },
    signingKey,
    { algorithm: 'RS256', keyid: kid, expiresIn: expiresIn as jwt.SignOptions['expiresIn'] },
  );
}

async function createSession(token: string, url = baseUrl) {
  const res = await fetch(`${url}/api/voice-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextToken: token }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function sendVoice(sessionId: string, idemKey: string, audio: Buffer, durationMs: number, type = 'audio/webm') {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(audio)], { type }), 'voz.webm');
  form.append('durationMs', String(durationMs));
  form.append('clientMime', type);
  const res = await fetch(`${baseUrl}/api/voice-messages`, {
    method: 'POST',
    headers: { Authorization: `VoiceSession ${sessionId}`, 'Idempotency-Key': idemKey },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  mock = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '';
    if (url === '/.well-known/jwks.json') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (req.method === 'POST' && url.startsWith(`/sc/v2/apps/${APP_ID}/attachments?`)) {
      uploads.push({ path: url, body });
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ attachment: { mediaUrl: `https://media.test/${uploads.length}.webm`, mediaType: 'audio/webm' } }));
    }
    const parts = url.match(new RegExp(`^/sc/v2/apps/${APP_ID}/conversations/([^/]+)/participants$`));
    if (req.method === 'GET' && parts) {
      res.setHeader('Content-Type', 'application/json');
      const participants = parts[1] === 'conv_part_0001' ? [{ id: 'p1', userId: 'user_part' }] : [];
      return res.end(JSON.stringify({ participants, meta: { hasMore: false } }));
    }
    const m = url.match(new RegExp(`^/sc/v2/apps/${APP_ID}/conversations/([^/]+)/messages$`));
    if (req.method === 'POST' && m) {
      if (failNextPostMessage) {
        failNextPostMessage = false;
        res.statusCode = 503;
        return res.end('{}');
      }
      messages.push({ path: url, json: JSON.parse(body.toString()) });
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ messages: [{ id: `msg_${messages.length}` }] }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  baseUrl = await startApp();
});

async function startApp(extraEnv: Record<string, string> = {}): Promise<string> {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      ZD_SUBDOMAIN: SUBDOMAIN,
      ZD_TOKEN_SUBDOMAINS: `${SUBDOMAIN},subdominio-original`,
      SC_APP_ID: APP_ID,
      SC_KEY_ID: 'key',
      SC_KEY_SECRET: 'secret',
      PUBLIC_BASE_URL: 'https://voz.test',
      SC_BASE_URL: `${mockUrl}/sc`,
      ZD_JWKS_URI: `${mockUrl}/.well-known/jwks.json`,
      MAX_DURATION_SEC: '10',
      MAX_BYTES: '1048576',
      WEBHOOK_SECRET: 'whsec_teste',
      OFFER_INTEGRATION_IDS: 'int_widget_teste',
      DEMO_OFFER_ENDPOINT: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  apps.push(proc);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return url;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('servidor não subiu');
}

after(() => {
  apps.forEach((p) => p.kill());
  mock?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('rejeita token inválido, expirado ou de outro app', async () => {
  assert.equal((await createSession('lixo')).status, 401);
  const expired = await createSession(contextToken({}, -10));
  assert.deepEqual([expired.status, expired.body.error], [401, 'context_expired']);
  const otherApp = await createSession(contextToken({ appId: 'outro_app' }));
  assert.deepEqual([otherApp.status, otherApp.body.error], [401, 'context_invalid']);
});

test('aceita o subdomínio alternativo e rejeita subdomínio fora da lista', async () => {
  assert.equal((await createSession(contextToken({ subdomain: 'subdominio-original' }))).status, 201);
  assert.equal((await createSession(contextToken({ subdomain: 'outra-conta' }))).status, 401);
});

test('aceita também o claim `appuserId` citado na documentação', async () => {
  const res = await createSession(contextToken({ appUserId: undefined, appuserId: 'user_doc' }));
  assert.equal(res.status, 201);
});

test('token assinado por chave fora do JWKS é rejeitado por padrão', async () => {
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const res = await createSession(contextToken({}, '5m', otherKey, 'kid-desconhecido'));
  assert.deepEqual([res.status, res.body.error], [401, 'context_invalid']);
});

test('DEMO_ALLOW_UNVERIFIED_CONTEXT: sem chave no JWKS, exige participação confirmada pela API', async () => {
  const demoUrl = await startApp({ DEMO_ALLOW_UNVERIFIED_CONTEXT: 'true' });
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = (claims: Record<string, unknown>, exp: string | number = '5m') =>
    contextToken(claims, exp, otherKey, 'kid-desconhecido');

  const participant = await createSession(token({ conversationId: 'conv_part_0001', appUserId: 'user_part' }), demoUrl);
  assert.equal(participant.status, 201);
  const stranger = await createSession(token({ conversationId: 'conv_part_0001', appUserId: 'intruso' }), demoUrl);
  assert.equal(stranger.status, 401);
  const expired = await createSession(token({ conversationId: 'conv_part_0001', appUserId: 'user_part' }, -10), demoUrl);
  assert.equal(expired.status, 401);
  // Assinatura válida continua passando pelo caminho normal.
  assert.equal((await createSession(contextToken(), demoUrl)).status, 201);
});

test('fluxo feliz: publica uma mensagem file com autoria do cliente, idempotente', async () => {
  const session = await createSession(contextToken({ conversationId: 'conv_feliz_001', appUserId: 'user_feliz' }));
  assert.equal(session.status, 201);
  assert.equal(session.body.maxDurationSec, 10);

  const audio = makeAudio('feliz.webm', 3);
  const idem = randomUUID();
  const before = messages.length;
  const sent = await sendVoice(session.body.sessionId, idem, audio, 3000);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.mediaType, 'audio/webm');
  assert.ok(Math.abs(sent.body.durationMs - 3000) < 300, `duração medida ${sent.body.durationMs}`);

  const msg = messages.at(-1)!;
  assert.match(msg.path, /conversations\/conv_feliz_001\/messages$/);
  assert.deepEqual(msg.json.author, { type: 'user', userId: 'user_feliz' });
  assert.equal(msg.json.content.type, 'file');
  assert.equal(msg.json.content.altText, 'Mensagem de voz (3 s)');
  assert.match(uploads.at(-1)!.path, /access=public&for=message&conversationId=conv_feliz_001/);

  // Duplo clique / retry com a mesma chave → mesma resposta, nenhuma mensagem nova.
  const replay = await sendVoice(session.body.sessionId, idem, audio, 3000);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.messageId, sent.body.messageId);
  assert.equal(messages.length, before + 1);
});

test('o mesmo convite permite enviar vários áudios', async () => {
  const offer = randomUUID();
  const token = () => contextToken({ conversationId: 'conv_varios_01', messageMetadata: { voiceOfferId: offer } });
  const session = await createSession(token());
  assert.equal(session.status, 201);
  const first = await sendVoice(session.body.sessionId, randomUUID(), makeAudio('varios1.webm', 2), 2000);
  const second = await sendVoice(session.body.sessionId, randomUUID(), makeAudio('varios2.webm', 2), 2000);
  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.notEqual(first.body.messageId, second.body.messageId);
  // Reabrir o gravador pelo mesmo botão também funciona.
  const reopened = await createSession(token());
  assert.equal(reopened.status, 201);
  assert.equal((await sendVoice(reopened.body.sessionId, randomUUID(), makeAudio('varios3.webm', 2), 2000)).status, 201);
  const audios = messages.filter((m) => m.path.includes('conv_varios_01') && m.json.author.type === 'user');
  assert.equal(audios.length, 3);
});

test('valida conteúdo: rejeita arquivo disfarçado, sem chave e sessão inválida', async () => {
  const session = await createSession(contextToken());
  const fakePdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'.repeat(20));
  const disguised = await sendVoice(session.body.sessionId, randomUUID(), fakePdf, 3000);
  assert.deepEqual([disguised.status, disguised.body.error], [415, 'unsupported_media_type']);

  const noKey = await fetch(`${baseUrl}/api/voice-messages`, {
    method: 'POST',
    headers: { Authorization: `VoiceSession ${session.body.sessionId}` },
  });
  assert.equal(noKey.status, 400);

  const badSession = await sendVoice('vs_inexistente', randomUUID(), fakePdf, 3000);
  assert.deepEqual([badSession.status, badSession.body.error], [401, 'session_expired']);
});

test('rejeita áudio acima da duração máxima', async () => {
  const session = await createSession(contextToken());
  const long = await sendVoice(session.body.sessionId, randomUUID(), makeAudio('longo.webm', 14), 9000);
  assert.deepEqual([long.status, long.body.error], [400, 'invalid_duration']);
});

test('retry após falha da Zendesk reaproveita o upload e publica uma única vez', async () => {
  const session = await createSession(contextToken());
  const audio = makeAudio('retry.webm', 2);
  const idem = randomUUID();
  const uploadsBefore = uploads.length;
  const messagesBefore = messages.length;

  failNextPostMessage = true;
  const failed = await sendVoice(session.body.sessionId, idem, audio, 2000);
  assert.deepEqual([failed.status, failed.body.error, failed.body.retryable], [502, 'zendesk_upstream', true]);

  const retried = await sendVoice(session.body.sessionId, idem, audio, 2000);
  assert.equal(retried.status, 201);
  assert.equal(uploads.length, uploadsBefore + 1, 'o arquivo não deve subir duas vezes');
  assert.equal(messages.length, messagesBefore + 1);
});

// ---------- Convite automático ----------

async function postWebhook(events: unknown[], apiKey = 'whsec_teste') {
  return fetch(`${baseUrl}/webhooks/zendesk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ app: { id: APP_ID }, webhook: { id: 'wh', version: 'v2' }, events }),
  });
}

const offersTo = (conversationId: string) =>
  messages.filter((m) => m.path.endsWith(`/conversations/${conversationId}/messages`) && m.json.author.type === 'business');

const settle = () => new Promise((r) => setTimeout(r, 300));

function createEvent(conversationId: string, integrationId: string) {
  return {
    id: randomUUID(),
    type: 'conversation:create',
    payload: { conversation: { id: conversationId }, creationReason: 'message', source: { type: 'web', integrationId } },
  };
}

test('webhook conversation:create envia um convite por conversa, só para o widget permitido', async () => {
  assert.equal((await postWebhook([createEvent('conv_auto_0001', 'int_widget_teste')], 'errada')).status, 401);

  assert.equal((await postWebhook([createEvent('conv_auto_0001', 'int_widget_teste')])).status, 200);
  await postWebhook([createEvent('conv_auto_0001', 'int_widget_teste')]); // evento repetido da mesma conversa
  await postWebhook([createEvent('conv_cliente_real', 'int_cliente_real')]);
  await settle();

  const offers = offersTo('conv_auto_0001');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].json.content.actions[0].type, 'webview');
  assert.equal(offers[0].json.content.actions[0].uri, 'https://voz.test/recorder');
  assert.ok(offers[0].json.metadata.voiceOfferId);
  assert.equal(offersTo('conv_cliente_real').length, 0);
});

test('webhook conversation:message com "áudio" envia convite; outros textos não', async () => {
  const msg = (conversationId: string, text: string) => ({
    id: randomUUID(),
    type: 'conversation:message',
    payload: {
      conversation: { id: conversationId },
      message: { author: { type: 'user' }, content: { type: 'text', text }, source: { type: 'web', integrationId: 'int_widget_teste' } },
    },
  });
  await postWebhook([msg('conv_kw_00001', 'bom dia')]);
  await postWebhook([msg('conv_kw_00002', 'posso mandar um áudio?')]);
  await settle();
  assert.equal(offersTo('conv_kw_00001').length, 0);
  assert.equal(offersTo('conv_kw_00002').length, 1);
});

test('página de teste: convite automático no máximo uma vez por conversa', async () => {
  const ask = (auto: boolean) =>
    fetch(`${baseUrl}/api/demo/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'conv_pagina_01', auto }),
    });
  assert.equal((await ask(true)).status, 201);
  assert.equal((await ask(true)).status, 200); // já enviado
  assert.equal((await ask(false)).status, 201); // botão "reenviar" sempre envia
  assert.equal(offersTo('conv_pagina_01').length, 2);
});
