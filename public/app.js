// 命之书 前端。所有文本都以 textContent 写入页面（纯文本），不使用 innerHTML 渲染用户或模型内容。
// 不使用 localStorage / cookie，不保存任何书写内容。

const $ = (id) => document.getElementById(id);
const el = {
  root: document.documentElement,
  motionToggle: $('motionToggle'),
  statusNotice: $('statusNotice'),
  compose: $('compose'), waiting: $('waiting'), reveal: $('reveal'), failure: $('failure'),
  text: $('text'), counter: $('counter'), inputMsg: $('inputMsg'), transcriptNote: $('transcriptNote'),
  open: $('open'), disclosureBody: $('disclosureBody'), sendNote: $('sendNote'),
  voiceIdle: $('voiceIdle'), voiceStart: $('voiceStart'), voiceUnavailable: $('voiceUnavailable'),
  voiceConsent: $('voiceConsent'), voiceDisclosure: $('voiceDisclosure'),
  voiceConfirm: $('voiceConfirm'), voiceConsentCancel: $('voiceConsentCancel'),
  voiceRecording: $('voiceRecording'), recTime: $('recTime'), recMax: $('recMax'),
  voiceStop: $('voiceStop'), voiceCancel: $('voiceCancel'),
  voiceBusy: $('voiceBusy'), voiceError: $('voiceError'),
  sentence: $('sentence'), safety: $('safety'), safetyLead: $('safetyLead'),
  safetyList: $('safetyList'), safetyNote: $('safetyNote'), safetyOrigin: $('safetyOrigin'),
  again: $('again'),
  failTitle: $('failTitle'), failDetail: $('failDetail'), retry: $('retry'), back: $('back'),
};

const state = {
  config: null,
  busy: false,
  lastText: '',
  view: 'compose',
  voiceConsented: false,
  rec: null, // { recorder, stream, chunks, timer, startedAt, cancelled }
};

const DEFAULT_LIMITS = { maxInputChars: 1000, maxRecordSeconds: 90 };

/* ---------------- 视图切换 ---------------- */

function show(view) {
  for (const v of ['compose', 'waiting', 'reveal', 'failure']) el[v].hidden = v !== view;
  state.view = view;
}

/* ---------------- 减少动效 ---------------- */

const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
function setReduceMotion(on) {
  el.root.classList.toggle('reduce-motion', on);
  el.motionToggle.setAttribute('aria-pressed', String(on));
}
setReduceMotion(mq.matches);
el.motionToggle.addEventListener('click', () => {
  setReduceMotion(el.motionToggle.getAttribute('aria-pressed') !== 'true');
});

/* ---------------- 配置与说明 ---------------- */

function limits() { return state.config?.limits || DEFAULT_LIMITS; }

function para(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

function renderDisclosure() {
  const c = state.config;
  const modelVendor = c?.model?.vendor || '大模型服务（供应商尚未确定）';
  const sttVendor = c?.stt?.vendor || '语音转写服务（供应商尚未确定）';
  el.disclosureBody.replaceChildren(
    para(`文字：点击「开启」后，你写下的文字会经由本站服务器，转交给「${modelVendor}」生成那一句话。`),
    para(`语音：只有在你主动开始录音时才会收音。录音会经由本站服务器，转交给「${sttVendor}」转成文字；文字回到这一页，由你检查修改后，再决定是否开启。`),
    para('本站：不建账号，不保存你的文字、录音或得到的那句话，应用日志只记录请求是否成功、耗时等，不记录内容。'),
    para('上游服务：它们会如何保留数据，取决于最终选定的供应商及其条款，目前尚未确定。因此本站无法承诺绝对私密，也无法承诺上游不存储。请不要写下你不愿交给第三方处理的信息。'),
  );
  el.sendNote.textContent =
    `点击「开启」后，这段文字会经由本站服务器交给「${modelVendor}」处理。本站不保存；上游的保留政策尚未确定，因此无法承诺绝对私密。`;
  el.voiceDisclosure.textContent =
    `录音会上传到本站服务器，并交给「${sttVendor}」转成文字，不会被本站保存。转写结果会先放进书写框，你可以修改，确认后再点「开启」。`;
}

function renderStatusNotice() {
  const c = state.config;
  if (!c) {
    el.statusNotice.textContent = '暂时连不上服务端。你仍可以先写下来，稍后再开启。';
    el.statusNotice.hidden = false;
    return;
  }
  if (!c.model.configured) {
    el.statusNotice.textContent =
      '模型尚未接入：服务端还没有配置大模型，现在点击「开启」不会得到回应。本页不会用预设的句子代替。';
    el.statusNotice.hidden = false;
  } else {
    el.statusNotice.hidden = true;
  }
}

function voiceSupport() {
  if (!window.isSecureContext) return '语音需要在 https 或本机地址下使用，请用文字写下。';
  if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === 'undefined') {
    return '这个浏览器不支持录音，请用文字写下。';
  }
  if (state.config && !state.config.stt.configured) return '语音转写尚未接入，请先用文字写下。';
  if (!state.config) return '暂时连不上服务端，语音不可用。';
  return null;
}

function renderVoiceAvailability() {
  const reason = voiceSupport();
  el.voiceStart.disabled = Boolean(reason);
  el.voiceUnavailable.hidden = !reason;
  el.voiceUnavailable.textContent = reason || '';
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    state.config = await r.json();
  } catch {
    state.config = null;
  }
  el.text.maxLength = limits().maxInputChars;
  const s = limits().maxRecordSeconds;
  el.recMax.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  updateCounter();
  renderDisclosure();
  renderStatusNotice();
  renderVoiceAvailability();
}

/* ---------------- 输入 ---------------- */

function charLen(s) { return [...s].length; }

function updateCounter() {
  const n = charLen(el.text.value);
  const max = limits().maxInputChars;
  el.counter.textContent = `${n} / ${max}`;
  el.counter.classList.toggle('over', n > max);
}

el.text.addEventListener('input', () => {
  updateCounter();
  el.inputMsg.textContent = '';
  if (!el.text.value.trim()) el.transcriptNote.hidden = true;
});

el.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submit(el.text.value);
  }
});

el.open.addEventListener('click', () => submit(el.text.value));

/* ---------------- 提交与结果 ---------------- */

function setBusy(on) {
  state.busy = on;
  el.open.disabled = on;
  el.retry.disabled = on;
  el.voiceStart.disabled = on || Boolean(voiceSupport());
}

async function submit(raw) {
  if (state.busy || state.rec) return; // 防重复提交；录音中不提交
  const text = String(raw || '').trim();
  if (!text) {
    el.inputMsg.textContent = '先写下一点什么吧。';
    el.text.focus();
    return;
  }
  if (charLen(text) > limits().maxInputChars) {
    el.inputMsg.textContent = `请收在 ${limits().maxInputChars} 字以内。`;
    el.text.focus();
    return;
  }

  state.lastText = text;
  setBusy(true);
  show('waiting');

  const timeoutMs = state.config?.clientTimeoutMs || 50000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch('/api/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ac.signal,
      cache: 'no-store',
    });
    let data = null;
    try { data = await r.json(); } catch { /* ignore */ }

    if (r.ok && data && (data.kind === 'normal' || data.kind === 'safety')) {
      renderResult(data);
      return;
    }
    if (r.status === 400 && data?.error === 'EMPTY') return backWithMsg('先写下一点什么吧。');
    if (r.status === 413) return backWithMsg(`请收在 ${limits().maxInputChars} 字以内。`);
    fail(data?.error || `HTTP_${r.status}`, data);
  } catch (e) {
    fail(e?.name === 'AbortError' ? 'CLIENT_TIMEOUT' : 'NETWORK');
  } finally {
    clearTimeout(timer);
    setBusy(false);
  }
}

function backWithMsg(msg) {
  show('compose');
  el.inputMsg.textContent = msg;
  el.text.focus();
}

function renderResult(data) {
  el.sentence.textContent = data.sentence || '';
  el.sentence.classList.remove('reveal-in');
  void el.sentence.offsetWidth; // 重新触发动画
  el.sentence.classList.add('reveal-in');

  if (data.kind === 'safety' && data.safety) {
    const s = data.safety;
    el.safetyLead.textContent = s.lead;
    el.safetyList.replaceChildren(...s.items.map((it) => {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = it.label;
      li.append(strong, document.createTextNode(it.detail));
      return li;
    }));
    el.safetyNote.textContent = s.note;
    el.safetyOrigin.textContent = data.modelWritten
      ? '上面那句话由模型生成；这一栏是固定的安全信息。'
      : '这一栏是固定的安全信息，不是模型生成的回应。';
    el.safety.hidden = false;
  } else {
    el.safety.hidden = true;
  }

  show('reveal');
  // 让读屏软件读到结果
  (data.sentence ? el.sentence : el.safetyLead).setAttribute('tabindex', '-1');
  (data.sentence ? el.sentence : el.safetyLead).focus({ preventScroll: false });
}

const FAILURES = {
  CLIENT_TIMEOUT: ['等得太久了，这一页没能翻开。', '可能是网络或模型服务太慢。你的文字还在，可以再试一次。', true],
  TIMEOUT: ['等得太久了，这一页没能翻开。', '模型服务没有及时回应。你的文字还在，可以再试一次。', true],
  GENERATION_REJECTED: ['这一次，没能写出合适的话。',
    '模型给出的内容没有通过检查（已经重新生成过一次）。不想用不合适的话敷衍你。可以再试一次，或换一种说法。', true],
  MODEL_NOT_CONFIGURED: ['模型尚未接入。',
    '服务端还没有配置大模型，所以现在无法为你写下这句话。本页不会用预设的句子代替。', false],
  RATE_LIMITED: ['翻得有些频繁了。', '请稍等一会儿再来。', false],
  IN_FLIGHT: ['上一次还在进行中。', '请稍等片刻再试。', true],
  UPSTREAM_ERROR: ['暂时连不上书写的服务。', '这不是你的问题。你的文字还在，可以稍后再试。', true],
  NETWORK: ['网络好像断开了。', '你的文字还在，网络恢复后可以再试一次。', true],
};

function fail(code, data) {
  const [title, detail, canRetry] = FAILURES[code] || ['出了一点问题。', '你的文字还在，可以再试一次。', true];
  el.failTitle.textContent = title;
  let d = detail;
  if (code === 'RATE_LIMITED' && data?.retryAfterSec) {
    d = `请大约 ${Math.max(1, Math.ceil(data.retryAfterSec / 60))} 分钟后再来。`;
  }
  el.failDetail.textContent = d;
  el.retry.hidden = !canRetry;
  show('failure');
  el.failTitle.focus();
}

el.retry.addEventListener('click', () => submit(state.lastText));
el.back.addEventListener('click', () => { show('compose'); el.text.focus(); });
el.again.addEventListener('click', () => { show('compose'); el.text.focus(); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.rec) { cancelRecording(); return; }
  if (state.view === 'reveal' || state.view === 'failure') { show('compose'); el.text.focus(); }
});

/* ---------------- 语音 ---------------- */

function voicePanel(name) {
  el.voiceIdle.hidden = name !== 'idle';
  el.voiceConsent.hidden = name !== 'consent';
  el.voiceRecording.hidden = name !== 'recording';
  el.voiceBusy.hidden = name !== 'busy';
}

function voiceError(msg) {
  el.voiceError.textContent = msg;
  el.voiceError.hidden = !msg;
}

el.voiceStart.addEventListener('click', () => {
  voiceError('');
  if (voiceSupport()) return renderVoiceAvailability();
  if (!state.voiceConsented) {
    voicePanel('consent');
    el.voiceConfirm.focus();
  } else {
    startRecording();
  }
});
el.voiceConsentCancel.addEventListener('click', () => { voicePanel('idle'); el.voiceStart.focus(); });
el.voiceConfirm.addEventListener('click', () => { state.voiceConsented = true; startRecording(); });
el.voiceStop.addEventListener('click', () => stopRecording());
el.voiceCancel.addEventListener('click', () => cancelRecording());

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return cands.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  if (state.rec || state.busy) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    voicePanel('idle');
    const name = e?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      voiceError('没有得到麦克风权限，所以没有录音。你可以在浏览器设置里允许，或直接用文字写下。');
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      voiceError('没有找到可用的麦克风。请用文字写下。');
    } else {
      voiceError('麦克风暂时无法使用。请用文字写下。');
    }
    el.text.focus();
    return;
  }

  const mimeType = pickMime();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    voicePanel('idle');
    voiceError('这个浏览器无法录制音频。请用文字写下。');
    return;
  }

  const rec = { recorder, stream, chunks: [], cancelled: false, startedAt: Date.now(), timer: null };
  state.rec = rec;
  recorder.addEventListener('dataavailable', (ev) => { if (ev.data?.size) rec.chunks.push(ev.data); });
  recorder.addEventListener('stop', () => onRecordingStopped(rec));
  recorder.start(1000);

  el.recTime.textContent = '0:00';
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    el.recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= limits().maxRecordSeconds) stopRecording();
  }, 250);
  voicePanel('recording');
  el.open.disabled = true;
  el.voiceStop.focus();
}

function stopRecording() {
  const rec = state.rec;
  if (!rec || rec.recorder.state === 'inactive') return;
  rec.recorder.stop();
}

function cancelRecording() {
  const rec = state.rec;
  if (!rec) return;
  rec.cancelled = true;
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  else onRecordingStopped(rec);
}

async function onRecordingStopped(rec) {
  clearInterval(rec.timer);
  rec.stream.getTracks().forEach((t) => t.stop());
  state.rec = null;
  el.open.disabled = state.busy;

  if (rec.cancelled) {
    voicePanel('idle');
    voiceError('');
    el.voiceStart.focus();
    return;
  }
  const type = (rec.recorder.mimeType || rec.chunks[0]?.type || 'audio/webm');
  const blob = new Blob(rec.chunks, { type });
  rec.chunks = [];
  if (blob.size < 200) {
    voicePanel('idle');
    voiceError('录音太短，没有录到内容。可以再试一次，或用文字写下。');
    return;
  }
  await uploadAudio(blob, type);
}

async function uploadAudio(blob, type) {
  voicePanel('busy');
  el.open.disabled = true;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45000);
  try {
    const r = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': type },
      body: blob,
      signal: ac.signal,
      cache: 'no-store',
    });
    let data = null;
    try { data = await r.json(); } catch { /* ignore */ }
    if (r.ok && typeof data?.text === 'string' && data.text) {
      insertTranscript(data.text, data.truncated);
      voicePanel('idle');
      voiceError('');
      return;
    }
    voicePanel('idle');
    const code = data?.error;
    voiceError({
      STT_NOT_CONFIGURED: '语音转写尚未接入，这段录音没有被处理。请用文字写下。',
      EMPTY_TRANSCRIPT: '没有听清这段录音里的话。可以再说一次，或用文字写下。',
      TIMEOUT: '转写超时了，这段录音没有转成文字。可以再录一次，或用文字写下。',
      RATE_LIMITED: '录音次数有些频繁，请稍后再试，或用文字写下。',
      TOO_LARGE: '这段录音太长了，请说得简短一些，或用文字写下。',
      BAD_AUDIO_TYPE: '这个浏览器录下的音频格式暂不支持。请用文字写下。',
    }[code] || '语音转写失败了，没有得到文字。请再试一次，或用文字写下。');
  } catch (e) {
    voicePanel('idle');
    voiceError(e?.name === 'AbortError'
      ? '转写超时了，这段录音没有转成文字。可以再录一次，或用文字写下。'
      : '网络出了问题，录音没有转成文字。请用文字写下。');
  } finally {
    clearTimeout(timer);
    el.open.disabled = state.busy;
  }
}

function insertTranscript(text, truncated) {
  const cur = el.text.value.trim();
  el.text.value = cur ? `${cur}\n${text}` : text;
  updateCounter();
  el.transcriptNote.hidden = false;
  if (truncated) el.inputMsg.textContent = '转写内容超出长度，后面的部分没有放进来。';
  el.text.focus();
  el.text.setSelectionRange(el.text.value.length, el.text.value.length);
}

/* ---------------- 启动 ---------------- */

show('compose');
voicePanel('idle');
loadConfig();
