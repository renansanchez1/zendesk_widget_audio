// Envia a mensagem de oferta ("🎙️ Gravar áudio") para uma conversa.
// Uso: npm run send-offer -- <conversationId>

import { sendVoiceOffer } from '../src/zendesk.js';

const conversationId = process.argv[2];
if (!conversationId) {
  console.error('Uso: npm run send-offer -- <conversationId>');
  process.exit(1);
}

const messageId = await sendVoiceOffer(conversationId);
console.log(`Oferta enviada (messageId ${messageId}). Abra o widget e toque em "🎙️ Gravar áudio".`);
