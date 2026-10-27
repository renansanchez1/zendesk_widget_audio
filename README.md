# Mensagens de voz no Zendesk Messaging Web Widget — demo

Versão inicial **apenas para demonstração** da variante **A1** da especificação
(*Especificação Técnica — Áudio Bidirecional Zendesk Messaging v2.0*): o cliente toca em
**🎙️ Gravar áudio** numa mensagem da conversa, grava num gravador que abre por cima do chat
(Conversation Extension / Webview) e o áudio entra na conversa como **mensagem do próprio cliente**
(`author.type = "user"`). O agente vê o anexo no Agent Workspace e responde anexando um áudio,
o que já é nativo.

> Não existe API pública para colocar um microfone fixo ao lado do campo de texto do widget,
> nem para trocar o player da bolha (spec §1.5, F13/F14). O botão de gravação fica numa mensagem
> da conversa.

## Como funciona

```
Web Widget ──(mensagem business com Webview action "🎙️ Gravar áudio")── Sunshine API v2
    │ cliente toca no botão
    ▼
/recorder (este servidor, dentro do iframe do widget)
    │ WebviewSdk.getContext() → JWT RS256 da Zendesk
    ├─► POST /api/voice-sessions   verifica o JWT via JWKS; cria sessão curta (10 min)
    │ getUserMedia + MediaRecorder → pré-escuta
    └─► POST /api/voice-messages   valida magic bytes e duração (ffmpeg), idempotência,
                                    UploadAttachment → PostMessage(author.type=user, content.type=file)
```

| Caminho | O que é |
|---|---|
| `src/server.ts` | Rotas HTTP: páginas, API do gravador, webhook e convite da página de teste |
| `src/context.ts` | Verificação do token `getContext` (RS256 + JWKS em cache, `subdomain`/`appId` conferidos) |
| `src/zendesk.ts` | Cliente da Sunshine Conversations API v2: upload, publicação, mensagem de oferta |
| `src/audio.ts` | Detecção do formato pelo conteúdo e medição da duração com ffmpeg |
| `src/store.ts` | Chave/valor em memória com TTL (faz o papel do Redis na demo) |
| `public/recorder.html`, `public/assets/recorder.js` | Gravador (Webview) |
| `public/index.html`, `public/assets/demo.js` | Página de teste com o Web Widget |
| `scripts/send-offer.ts` | Envia a mensagem de oferta para uma conversa |
| `test/e2e.test.ts` | Testes ponta a ponta contra uma Zendesk simulada |

## Pré-requisitos

- Node.js ≥ 20 e **ffmpeg** no PATH. Sem o ffmpeg, a duração declarada pelo navegador é aceita sem conferência.
- Conta Zendesk `con-renansanchez` com Messaging ativo e um Web Widget.
- Uma URL **HTTPS pública** apontando para este servidor. Para a demo, um túnel basta:
  `cloudflared tunnel --url http://localhost:8080` ou `ngrok http 8080`.

### Configuração na Zendesk

1. **Chave da Conversations API.** No Admin Center, vá em *Apps e integrações → APIs → Conversations API*
   e crie uma chave de API. Anote **App ID**, **Key ID** e **Secret**.
2. **Chave do Web Widget.** No Admin Center, vá em *Canais → Messaging*, abra o seu Web Widget e entre
   em *Instalação*. O valor de `key=` no snippet é a chave.
3. *(Recomendado)* Ative **anexos privados** e **Secure Downloads** para messaging.
4. *(Opcional)* **Webhook** para a oferta automática: crie uma integração de webhook da
   Conversations API com o gatilho `conversation:message`, a URL `https://<sua-url>/webhooks/zendesk`
   e copie o segredo para `WEBHOOK_SECRET`. Com o webhook ativo, quando o cliente escreve "áudio", "voz"
   ou "gravar", o convite é enviado automaticamente.

## Rodando

```bash
npm install
cp .env.example .env      # preencha SC_APP_ID, SC_KEY_ID, SC_KEY_SECRET, ZENDESK_WIDGET_KEY, PUBLIC_BASE_URL
npm run dev               # http://localhost:8080
```

Abra `PUBLIC_BASE_URL` (a URL HTTPS do túnel, não `localhost`) e siga estes passos:

1. Abra o widget e mande "oi".
2. Clique em **Enviar convite de gravação para esta conversa**. Esse botão aparece com
   `DEMO_OFFER_ENDPOINT=true`. Também dá para usar o webhook ou rodar
   `npm run send-offer -- <conversationId>`.
3. No chat, toque em **🎙️ Gravar áudio**, grave, ouça e envie.
4. Confira o áudio no widget e no ticket do Agent Workspace.

Para testar só a gravação, fora do widget: `https://<sua-url>/recorder?dev=1`. Nesse modo o envio fica desligado.

## Testes

```bash
npm run typecheck
npm test     # sobe o servidor contra uma Zendesk simulada (JWKS + API v2); requer ffmpeg
```

Cobrem: token inválido, expirado ou de outro app; fluxo feliz com autoria `user`; idempotência
(duplo clique e retry); oferta de uso único; arquivo disfarçado (415); duração acima do limite;
retry após falha da Zendesk reaproveitando o upload.

## O que esta demo ainda **não** prova

Isto só se descobre rodando na conta real. São as POCs da spec (§8):

| POC | Pergunta | Onde olhar |
|---|---|---|
| POC-08 | A Webview abre dentro do widget e o `getContext` funciona? | O gravador sai de "Abra o gravador pelo chat" e libera o botão |
| POC-01 | O microfone funciona **dentro do iframe** do widget (principalmente Safari/iOS)? | Se aparecer "Microfone bloqueado" sem o navegador perguntar, o iframe não tem `allow="microphone"` |
| POC-02/03 | A mensagem aparece como do cliente no widget e como comentário do solicitante no ticket? | Widget e Agent Workspace |
| POC-05 | O áudio toca inline ou só como arquivo para baixar? (varia por formato e navegador) | Widget e Agent Workspace, em Chrome e iPhone |

## Limitações conhecidas (demo ≠ produção)

- O estado (sessões, idempotência, ofertas usadas) fica **em memória**: some ao reiniciar e não serve
  para várias instâncias. Em produção, use Redis (spec §4.5).
- `FRAME_ANCESTORS=*` e `DEMO_OFFER_ENDPOINT=true` são só para a demo. O endpoint de convite aceita um
  `conversationId` vindo do navegador; ele só publica o convite, mas não deve ir para produção.
- Sem transcodificação: o áudio é publicado no formato que o navegador gravou (webm/opus no
  Chrome, mp4/aac no Safari). Converter só se a POC-05 mostrar necessidade (ADR-002).
- Sem aviso LGPD revisado pelo DPO, sem antivírus, sem feature flag por marca, sem métricas.
- A variante A2 (botão de microfone na página do site, para usuários autenticados) não está incluída.
