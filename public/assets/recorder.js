// Gravador de mensagens de voz — roda dentro da Webview (Conversation Extension) do Web Widget.
// Estados (spec 4.6): idle → requesting → recording ⇄ paused → preview → sending → sent
//                                       ↘ denied                       ↘ send-failed
// ?dev=1 permite testar gravação/pré-escuta fora do widget (o envio fica desabilitado).
(function () {
  'use strict';

  var MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  var params = new URLSearchParams(location.search);
  var devMode = params.get('dev') === '1';

  var $ = function (id) { return document.getElementById(id); };
  var sdk = null;
  var session = null; // { sessionId, maxDurationSec, maxBytes }
  var limits = { maxDurationSec: 180, maxBytes: 10 * 1024 * 1024 };

  // ---------- UI ----------

  function show(view) {
    document.querySelectorAll('[data-view]').forEach(function (el) {
      el.hidden = el.getAttribute('data-view') !== view;
    });
    var focusTarget = {
      idle: 'btn-record', recording: 'btn-stop', preview: 'btn-send',
      sent: 'btn-another', 'send-failed': 'btn-retry',
    }[view];
    if (focusTarget && !$(focusTarget).disabled) $(focusTarget).focus();
  }

  function announce(text) { $('live').textContent = text; }

  function showMessage(icon, title, text, canRetry) {
    $('message-icon').textContent = icon;
    $('message-title').textContent = title;
    $('message-text').textContent = text;
    $('btn-try-again').hidden = !canRetry;
    show('message');
    announce(title);
  }

  function fmt(ms) {
    var s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function applyLimits() {
    $('max').textContent = fmt(limits.maxDurationSec * 1000);
    $('limits-text').textContent =
      'Máx. ' + Math.round(limits.maxDurationSec / 60) + ' min · você poderá ouvir antes de enviar.';
  }

  // ---------- Gravação ----------

  var rec = {
    stream: null, recorder: null, chunks: [], startedAt: 0, elapsedBeforePause: 0,
    timer: null, blob: null, durationMs: 0, state: 'idle', audioCtx: null, analyser: null,
    previewUrl: null, idemKey: null,
  };

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
    return MIME_PREFERENCE.find(function (m) { return MediaRecorder.isTypeSupported(m); });
  }

  function elapsed() {
    return rec.state === 'paused'
      ? rec.elapsedBeforePause
      : rec.elapsedBeforePause + (performance.now() - rec.startedAt);
  }

  function releaseTracks() {
    if (rec.timer) clearInterval(rec.timer);
    rec.timer = null;
    if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); }); // apaga indicador do microfone
    rec.stream = null;
    if (rec.audioCtx) rec.audioCtx.close().catch(function () {});
    rec.audioCtx = null;
    rec.analyser = null;
  }

  function clearPreview() {
    if (rec.previewUrl) URL.revokeObjectURL(rec.previewUrl);
    rec.previewUrl = null;
    rec.blob = null;
    $('player').removeAttribute('src');
  }

  async function startRecording() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
        typeof MediaRecorder === 'undefined') {
      return showMessage('🚫', 'Gravação indisponível neste navegador',
        'Grave no app de gravador do seu celular e envie o arquivo pelo clipe 📎 do chat.', false);
    }
    clearPreview();
    rec.state = 'requesting';
    announce('Solicitando acesso ao microfone');
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      rec.state = 'denied';
      // NotAllowedError: negado pelo usuário ou pela Permissions-Policy do iframe (POC-01).
      var name = e && e.name;
      console.warn('[recorder] getUserMedia falhou:', name, e);
      return showMessage('🎙️', name === 'NotFoundError' ? 'Nenhum microfone encontrado' : 'Microfone bloqueado',
        'Para gravar, permita o microfone nas configurações do navegador e toque em "Tentar de novo". ' +
        'Ou grave no app de gravador e envie o arquivo pelo clipe 📎 do chat.', true);
    }

    var mimeType = pickMime();
    try {
      rec.recorder = new MediaRecorder(rec.stream, mimeType ? { mimeType: mimeType } : undefined);
    } catch (e) {
      releaseTracks();
      return showMessage('🚫', 'Não foi possível iniciar a gravação', String(e && e.message || e), true);
    }
    rec.chunks = [];
    rec.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size > 0) rec.chunks.push(ev.data); };
    rec.recorder.onerror = function () {
      releaseTracks();
      showMessage('⚠️', 'A gravação foi interrompida', 'Tente gravar novamente.', true);
    };
    // Trilha encerrada pelo sistema (ex.: ligação no celular, permissão revogada) → vai para a pré-escuta.
    rec.stream.getAudioTracks().forEach(function (t) {
      t.addEventListener('ended', function () { if (rec.state === 'recording' || rec.state === 'paused') stopRecording(); });
    });

    setupMeter();
    rec.recorder.start(1000); // fatias de 1 s para medir o tamanho em tempo real
    rec.startedAt = performance.now();
    rec.elapsedBeforePause = 0;
    rec.idemKey = crypto.randomUUID(); // uma chave por gravação (RF-009)
    rec.timer = setInterval(tick, 200);
    rec.state = 'recording';
    $('btn-pause').hidden = !('pause' in MediaRecorder.prototype);
    $('btn-pause').textContent = 'Pausar';
    $('rec-label').textContent = 'Gravando';
    show('recording');
    announce('Gravando');
  }

  function setupMeter() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      rec.audioCtx = new Ctx();
      rec.analyser = rec.audioCtx.createAnalyser();
      rec.analyser.fftSize = 512;
      rec.audioCtx.createMediaStreamSource(rec.stream).connect(rec.analyser);
    } catch (e) {
      rec.analyser = null; // medidor é só visual
    }
  }

  function tick() {
    if (rec.state !== 'recording' && rec.state !== 'paused') return;
    var ms = elapsed();
    $('elapsed').textContent = fmt(ms);
    if (rec.analyser && rec.state === 'recording') {
      var data = new Uint8Array(rec.analyser.fftSize);
      rec.analyser.getByteTimeDomainData(data);
      var peak = 0;
      for (var i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
      $('meter-fill').style.width = Math.min(100, Math.round((peak / 128) * 160)) + '%';
    }
    var bytes = rec.chunks.reduce(function (n, c) { return n + c.size; }, 0);
    if (ms >= limits.maxDurationSec * 1000 || bytes >= limits.maxBytes * 0.95) {
      stopRecording().then(function () { announce('Tempo máximo atingido. Ouça antes de enviar.'); });
    }
  }

  function togglePause() {
    if (rec.state === 'recording') {
      rec.recorder.pause();
      rec.elapsedBeforePause += performance.now() - rec.startedAt;
      rec.state = 'paused';
      $('btn-pause').textContent = 'Continuar';
      $('rec-label').textContent = 'Pausado';
      $('meter-fill').style.width = '0%';
      announce('Gravação pausada');
    } else if (rec.state === 'paused') {
      rec.recorder.resume();
      rec.startedAt = performance.now();
      rec.state = 'recording';
      $('btn-pause').textContent = 'Pausar';
      $('rec-label').textContent = 'Gravando';
      announce('Gravando');
    }
  }

  function stopRecording() {
    return new Promise(function (resolve) {
      if (!rec.recorder || rec.recorder.state === 'inactive') return resolve();
      rec.durationMs = elapsed();
      rec.state = 'stopping';
      rec.recorder.onstop = function () {
        rec.blob = new Blob(rec.chunks, { type: rec.recorder.mimeType || 'audio/webm' });
        releaseTracks();
        rec.state = 'preview';
        rec.previewUrl = URL.createObjectURL(rec.blob);
        $('player').src = rec.previewUrl;
        var secs = Math.max(1, Math.round(rec.durationMs / 1000));
        $('preview-info').textContent = fmt(rec.durationMs) + ' · ' + Math.ceil(rec.blob.size / 1024) + ' KB';
        $('btn-send').disabled = devMode || !session;
        show('preview');
        announce('Gravação de ' + secs + ' segundos pronta para ouvir');
        resolve();
      };
      rec.recorder.stop();
    });
  }

  function cancelRecording() {
    if (rec.recorder && rec.recorder.state !== 'inactive') {
      rec.recorder.onstop = null;
      rec.recorder.stop();
    }
    releaseTracks();
    clearPreview();
    rec.state = 'idle';
    show('idle');
    announce('Gravação descartada');
  }

  // ---------- Contexto e envio ----------

  function getContextToken() {
    return new Promise(function (resolve, reject) {
      if (!sdk || !sdk.hasFeature('getContext')) return reject(new Error('getContext_unavailable'));
      sdk.getContext(function (ctx) { resolve(ctx.token); }, reject);
    });
  }

  async function createSession() {
    var token = await getContextToken();
    var res = await fetch('/api/voice-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextToken: token }),
      credentials: 'omit',
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(body.error || 'session_failed'), { code: body.error, status: res.status });
    session = body;
    limits = { maxDurationSec: body.maxDurationSec, maxBytes: body.maxBytes };
    applyLimits();
    return body;
  }

  function extFor(type) {
    if (type.indexOf('mp4') >= 0) return 'm4a';
    if (type.indexOf('ogg') >= 0) return 'ogg';
    return 'webm';
  }

  async function postVoice() {
    var form = new FormData();
    form.append('audio', rec.blob, 'voz-' + Date.now() + '.' + extFor(rec.blob.type));
    form.append('durationMs', String(Math.round(rec.durationMs)));
    form.append('clientMime', rec.blob.type);
    return fetch('/api/voice-messages', {
      method: 'POST',
      headers: { Authorization: 'VoiceSession ' + session.sessionId, 'Idempotency-Key': rec.idemKey },
      body: form,
      credentials: 'omit',
    });
  }

  async function send() {
    if (!rec.blob || !session) return;
    show('sending');
    announce('Enviando');
    try {
      var res = await postVoice();
      for (var polls = 0; res.status === 202 && polls < 10; polls++) {
        await new Promise(function (r) { setTimeout(r, 1500); });
        res = await postVoice();
      }
      if (res.status === 401) { // sessão vencida: pede novo contexto uma vez (CA-07)
        await createSession();
        res = await postVoice();
      }
      var body = await res.json().catch(function () { return {}; });
      if (res.ok) return onSent();
      return onSendError(body.error);
    } catch (e) {
      console.warn('[recorder] envio falhou:', e);
      return onSendError(e && e.code || 'network');
    }
  }

  function onSent() {
    clearPreview();
    rec.state = 'sent';
    show('sent');
    announce('Áudio enviado. Você pode gravar outro ou voltar para a conversa.');
  }

  function onSendError(code) {
    var fatal = {
      conversation_unavailable: ['Esta conversa não está mais disponível', 'Inicie uma nova conversa no chat.'],
      unsupported_media_type: ['Formato de áudio não suportado', 'Envie o arquivo pelo clipe 📎 do chat.'],
      too_large: ['Áudio grande demais', 'Grave uma mensagem mais curta.'],
      invalid_duration: ['Gravação curta ou longa demais', 'Grave entre 1 segundo e o tempo máximo.'],
      context_invalid: ['Não foi possível validar a conversa', 'Feche e abra o gravador pelo botão no chat.'],
      context_expired: ['O convite expirou', 'Feche e abra o gravador pelo botão no chat.'],
    }[code];
    if (fatal) return showMessage('⚠️', fatal[0], fatal[1], code === 'too_large' || code === 'invalid_duration');
    rec.state = 'send-failed';
    show('send-failed'); // mantém o Blob e a mesma Idempotency-Key para o retry
    announce('Falha no envio. Sua gravação continua aqui.');
  }

  // ---------- Inicialização ----------

  function enableRecording() {
    $('btn-record').disabled = false;
    show('idle');
  }

  function onSessionError(e) {
    console.warn('[recorder] sessão não criada:', e);
    if (e.code === 'context_expired') {
      return showMessage('⌛', 'O convite expirou', 'Feche e abra o gravador pelo botão no chat.', false);
    }
    showMessage('⚠️', 'Não foi possível iniciar o gravador',
      'Feche e abra novamente pelo botão "🎙️ Gravar áudio" no chat.', false);
  }

  window.webviewSdkInit = function (webviewSdk) {
    sdk = webviewSdk;
    if (devMode) return;
    createSession().then(enableRecording, onSessionError);
  };

  $('btn-record').addEventListener('click', startRecording);
  $('btn-pause').addEventListener('click', togglePause);
  $('btn-stop').addEventListener('click', function () { stopRecording(); });
  $('btn-cancel').addEventListener('click', cancelRecording);
  $('btn-discard').addEventListener('click', cancelRecording);
  $('btn-rerecord').addEventListener('click', function () { clearPreview(); startRecording(); });
  $('btn-send').addEventListener('click', send);
  $('btn-retry').addEventListener('click', send);
  $('btn-back').addEventListener('click', function () { show('preview'); });
  $('btn-try-again').addEventListener('click', function () { show('idle'); startRecording(); });
  $('btn-close').addEventListener('click', function () { if (sdk && sdk.hasFeature('close')) sdk.close(); });
  $('btn-another').addEventListener('click', function () { rec.state = 'idle'; show('idle'); startRecording(); });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && (rec.state === 'recording' || rec.state === 'paused')) cancelRecording();
  });

  applyLimits();
  if (devMode) {
    $('limits-text').textContent = 'Modo dev: grava e reproduz localmente; o envio fica desabilitado.';
    enableRecording();
  } else {
    show('idle');
    // Fora do widget (ex.: link aberto no navegador) o SDK nunca chama webviewSdkInit.
    setTimeout(function () {
      if (!sdk) {
        showMessage('💬', 'Abra o gravador pelo chat',
          'Use o botão "🎙️ Gravar áudio" na conversa do widget.', false);
      }
    }, 6000);
  }
})();
