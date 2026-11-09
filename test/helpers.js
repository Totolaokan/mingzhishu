import http from 'node:http';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

/** 启动一个模拟上游（大模型 / 语音转写）。handler(req, bodyBuffer, res, callIndex) */
export async function startMock(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      calls.push({ url: req.url, headers: req.headers, body });
      try { await handler(req, body, res, calls.length - 1); }
      catch { if (!res.headersSent) { res.writeHead(500); res.end(); } }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** 依次返回给定的模型文本（OpenAI 兼容格式）。 */
export function openaiReplies(...texts) {
  return (req, body, res, i) => {
    const content = texts[Math.min(i, texts.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  };
}

export async function startApp(env = {}) {
  const logs = [];
  const config = loadConfig({ PORT: '0', ...env });
  const { server } = createApp(config, { logSink: (l) => logs.push(l) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    config,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

export function llmEnv(mockUrl, extra = {}) {
  return {
    LLM_PROVIDER: 'openai_compatible',
    LLM_BASE_URL: mockUrl,
    LLM_API_KEY: 'test-secret-key-should-never-leak',
    LLM_MODEL: 'mock-model',
    ...extra,
  };
}

export async function reveal(base, text) {
  const r = await fetch(`${base}/api/reveal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { status: r.status, data: await r.json() };
}

export const J = (o) => JSON.stringify(o);
