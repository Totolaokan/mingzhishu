// 语音转写（服务端）。对接 OpenAI 兼容的 /audio/transcriptions 接口（multipart 上传）。
// 音频只在内存中转交，不写磁盘、不记录内容。

import { UpstreamError, toUpstreamError } from './llm.js';

const EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
};

export function audioExt(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return EXT[base] || null;
}

export async function transcribe(stt, audioBuffer, contentType, { signal } = {}) {
  const ext = audioExt(contentType);
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: contentType.split(';')[0] }), `audio.${ext}`);
  form.append('model', stt.model);
  form.append('language', stt.language);
  form.append('response_format', 'json');

  const t = AbortSignal.timeout(stt.timeoutMs);
  let res;
  try {
    res = await fetch(`${stt.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stt.apiKey}` },
      body: form,
      signal: signal ? AbortSignal.any([signal, t]) : t,
    });
  } catch (e) {
    throw toUpstreamError(e);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new UpstreamError('UPSTREAM_HTTP', res.status);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw toUpstreamError(e);
    throw new UpstreamError('UPSTREAM_BAD_RESPONSE');
  }
  if (typeof data?.text !== 'string') throw new UpstreamError('UPSTREAM_BAD_RESPONSE');
  return data.text;
}
