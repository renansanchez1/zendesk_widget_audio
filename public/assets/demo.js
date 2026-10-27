// Página de teste: carrega o Web Widget e (opcional) pede a oferta de gravação ao backend.
(function () {
  var body = document.body;
  var widgetKey = body.dataset.widgetKey;
  var demoOffer = body.dataset.demoOffer === 'true';
  var conversationId = null;

  var $ = function (id) { return document.getElementById(id); };

  if (!widgetKey) {
    $('no-key').hidden = false;
    return;
  }

  if (demoOffer) {
    $('offer-panel').hidden = false;
    $('offer-hint-button').hidden = false;
    $('offer-hint-webhook').hidden = true;
  }

  function setConversation(id) {
    if (!id || id === conversationId) return;
    conversationId = id;
    $('conversation-id').textContent = id;
    $('send-offer').disabled = false;
  }

  var snippet = document.createElement('script');
  snippet.id = 'ze-snippet';
  snippet.src = 'https://static.zdassets.com/ekr/snippet.js?key=' + widgetKey;
  snippet.onload = function () {
    // Eventos oficiais (Messaging Web Widget events API) para descobrir a conversa ativa.
    zE('messenger:on', 'conversationOpened', function (e) { setConversation(e.payload.conversation.id); });
    zE('messenger:on', 'conversationStarted', function (e) {
      setConversation(e.payload.conversation.id);
      if (demoOffer) autoOffer(e.payload.conversation.id, 0);
    });
    zE('messenger:on', 'messageReceived', function (e) { setConversation(e.payload.conversation.id); });
  };
  document.body.appendChild(snippet);

  // Conversa nova → convite automático (o servidor garante no máximo um por conversa).
  // A conversa pode levar um instante para existir na API; tenta de novo algumas vezes.
  function autoOffer(id, attempt) {
    fetch('/api/demo/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: id, auto: true }),
    })
      .then(function (res) {
        if (res.ok) {
          $('offer-status').textContent = 'Convite de gravação enviado automaticamente para a conversa nova.';
        } else if (attempt < 3) {
          setTimeout(function () { autoOffer(id, attempt + 1); }, 2000);
        }
      })
      .catch(function () { if (attempt < 3) setTimeout(function () { autoOffer(id, attempt + 1); }, 2000); });
  }

  $('send-offer').addEventListener('click', function () {
    var button = $('send-offer');
    var status = $('offer-status');
    button.disabled = true;
    status.textContent = 'Enviando convite…';
    fetch('/api/demo/offers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversationId }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
          status.textContent = 'Convite enviado. Toque em "🎙️ Gravar áudio" no chat.';
          zE('messenger', 'open');
        });
      })
      .catch(function (err) { status.textContent = 'Falha ao enviar o convite: ' + err.message; })
      .finally(function () { button.disabled = false; });
  });
})();
