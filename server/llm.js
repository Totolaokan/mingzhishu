// 大模型调用（服务端）。支持 OpenAI 兼容的 /chat/completions 与 Anthropic Messages API。
// 上游的错误响应体可能包含原文，所以只保留状态码，不读取、不记录响应体。

import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import { validateOutput } from './validate.js';

export class UpstreamError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code; // TIMEOUT | UPSTREAM_HTTP | UPSTREAM_NETWORK | UPSTREAM_BAD_RESPONSE | ABORTED
    this.status = status;
  }
}

function linkSignals(outer, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, t]) : t;
}

export async function postJson(url, headers, body, { timeoutMs, signal }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: linkSignals(signal, timeoutMs),
    });
  } catch (e) {
    throw toUpstreamError(e);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new UpstreamError('UPSTREAM_HTTP', res.status);
  }
  try {
    return await res.json();
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw toUpstreamError(e);
    throw new UpstreamError('UPSTREAM_BAD_RESPONSE', res.status);
  }
}

export function toUpstreamError(e) {
  if (e instanceof UpstreamError) return e;
  if (e?.name === 'TimeoutError') return new UpstreamError('TIMEOUT');
  if (e?.name === 'AbortError') return new UpstreamError(e?.cause?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED');
  return new UpstreamError('UPSTREAM_NETWORK');
}

export async function callModel(llm, system, user, { signal } = {}) {
  const opts = { timeoutMs: llm.timeoutMs, signal };
  if (llm.provider === 'anthropic') {
    const data = await postJson(
      `${llm.baseUrl}/v1/messages`,
      { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' },
      { model: llm.model, system, messages: [{ role: 'user', content: user }], max_tokens: 400, temperature: 0.8 },
      opts,
    );
    const text = Array.isArray(data?.content)
      ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      : '';
    if (!text) throw new UpstreamError('UPSTREAM_BAD_RESPONSE');
    return text;
  }
  // openai_compatible
  const data = await postJson(
    `${llm.baseUrl}/chat/completions`,
    { authorization: `Bearer ${llm.apiKey}` },
    {
      model: llm.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.8,
      max_tokens: 400,
    },
    opts,
  );
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) throw new UpstreamError('UPSTREAM_BAD_RESPONSE');
  return text;
}

/**
 * 生成一句话：首次不合格时带着检查结论重新生成一次；仍不合格则返回 rejected。
 * 上游超时/错误不自动重试，交给用户手动重试。
 */
export async function generateSentence(llm, text, { crisisHint = false, signal, log = () => {} } = {}) {
  let feedback = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await callModel(llm, SYSTEM_PROMPT, buildUserPrompt(text, { crisisHint, feedback }), { signal });
    const v = validateOutput(raw, text, { crisisHint });
    if (v.ok) return { ok: true, ...v.value, attempts: attempt };
    log('output_rejected', { attempt, reason: v.code });
    feedback = v.reason;
  }
  return { ok: false, attempts: 2 };
}
