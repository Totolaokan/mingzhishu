import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, lengthBucket } from './log.js';
import { RateLimiter, InFlight } from './ratelimit.js';
import { sanitizeInput } from './validate.js';
import { detectCrisis, SAFETY_RESOURCES } from './safety.js';
import { generateSentence, UpstreamError } from './llm.js';
import { transcribe, audioExt } from './stt.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
    "connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, 'TOO_LARGE'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        reject(new HttpError(413, 'TOO_LARGE'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => { if (!done) { done = true; reject(new HttpError(400, 'BAD_REQUEST')); } });
  });
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
}

export function createApp(config, { logSink, now } = {}) {
  const log = createLogger(logSink);
  const revealLimiter = new RateLimiter({ limit: config.limits.revealPerWindow, windowMs: config.limits.windowMs, now });
  const globalLimiter = new RateLimiter({ limit: config.limits.globalRevealPerMinute, windowMs: 60_000, now });
  const sttLimiter = new RateLimiter({ limit: config.limits.transcribePerWindow, windowMs: config.limits.windowMs, now });
  const revealInFlight = new InFlight();
  const sttInFlight = new InFlight();

  function clientKey(req) {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function publicConfig() {
    return {
      model: { configured: config.llm.configured, vendor: config.llm.vendorLabel },
      stt: { configured: config.stt.configured, vendor: config.stt.vendorLabel },
      limits: { maxInputChars: config.limits.maxInputChars, maxRecordSeconds: config.limits.maxRecordSeconds },
      clientTimeoutMs: config.limits.overallDeadlineMs + 5000,
    };
  }

  function safetyPayload(sentence) {
    return { kind: 'safety', sentence: sentence || null, modelWritten: Boolean(sentence), safety: SAFETY_RESOURCES };
  }

  async function handleReveal(req, res) {
    const started = Date.now();
    const key = clientKey(req);
    const finish = (status, obj, fields = {}, extra) => {
      log('reveal', { route: '/api/reveal', status, ms: Date.now() - started, ...fields });
      sendJson(res, status, obj, extra);
    };

    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return finish(415, { error: 'BAD_CONTENT_TYPE' }, { code: 'BAD_CONTENT_TYPE' });
    }
    if (!revealInFlight.acquire(key)) {
      return finish(409, { error: 'IN_FLIGHT' }, { code: 'IN_FLIGHT' });
    }
    try {
      let buf;
      try { buf = await readBody(req, config.limits.maxJsonBytes); }
      catch (e) { return finish(e.status || 400, { error: e.code || 'BAD_REQUEST' }, { code: e.code }); }

      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
      if (!payload || typeof payload.text !== 'string') return finish(400, { error: 'BAD_REQUEST' }, { code: 'BAD_REQUEST' });

      const text = sanitizeInput(payload.text);
      const len = [...text].length;
      if (!len) return finish(400, { error: 'EMPTY' }, { code: 'EMPTY' });
      if (len > config.limits.maxInputChars) {
        return finish(413, { error: 'TOO_LONG', max: config.limits.maxInputChars }, { code: 'TOO_LONG' });
      }

      const crisis = detectCrisis(text);

      // 危机表达优先：即使限流或模型不可用，也要给出安全支持信息。
      const rl = revealLimiter.take(key);
      const gl = rl.ok ? globalLimiter.take('global') : { ok: true };
      if (!rl.ok || !gl.ok) {
        if (crisis) return finish(200, safetyPayload(null), { kind: 'safety', crisis: true, code: 'RATE_LIMITED' });
        const retryAfterSec = rl.ok ? 60 : rl.retryAfterSec;
        return finish(429, { error: 'RATE_LIMITED', retryAfterSec }, { code: 'RATE_LIMITED' }, { 'retry-after': String(retryAfterSec) });
      }

      if (!config.llm.configured) {
        if (crisis) return finish(200, safetyPayload(null), { kind: 'safety', crisis: true, code: 'MODEL_NOT_CONFIGURED' });
        return finish(503, { error: 'MODEL_NOT_CONFIGURED' }, { code: 'MODEL_NOT_CONFIGURED', lengthBucket: lengthBucket(len) });
      }

      const ac = new AbortController();
      const deadline = setTimeout(() => ac.abort(new DOMException('deadline', 'TimeoutError')), config.limits.overallDeadlineMs);
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      try {
        const out = await generateSentence(config.llm, text, { crisisHint: crisis, signal: ac.signal, log });
        if (!out.ok) {
          if (crisis) return finish(200, safetyPayload(null), { kind: 'safety', crisis: true, code: 'GENERATION_REJECTED' });
          return finish(422, { error: 'GENERATION_REJECTED' }, { code: 'GENERATION_REJECTED', attempt: out.attempts });
        }
        if (crisis || out.mode === 'crisis') {
          return finish(200, safetyPayload(out.sentence), { kind: 'safety', crisis, attempt: out.attempts });
        }
        return finish(200, { kind: 'normal', sentence: out.sentence }, { kind: 'normal', attempt: out.attempts, lengthBucket: lengthBucket(len) });
      } catch (e) {
        const err = e instanceof UpstreamError ? e : new UpstreamError('UPSTREAM_NETWORK');
        if (crisis) return finish(200, safetyPayload(null), { kind: 'safety', crisis: true, code: err.code });
        if (err.code === 'TIMEOUT') return finish(504, { error: 'TIMEOUT' }, { code: 'TIMEOUT' });
        if (err.code === 'ABORTED') return finish(499, { error: 'ABORTED' }, { code: 'ABORTED' });
        return finish(502, { error: 'UPSTREAM_ERROR' }, { code: err.code, upstreamStatus: err.status });
      } finally {
        clearTimeout(deadline);
      }
    } finally {
      revealInFlight.release(key);
    }
  }

  async function handleTranscribe(req, res) {
    const started = Date.now();
    const key = clientKey(req);
    const finish = (status, obj, fields = {}, extra) => {
      log('transcribe', { route: '/api/transcribe', status, ms: Date.now() - started, ...fields });
      sendJson(res, status, obj, extra);
    };
    if (!config.stt.configured) {
      req.resume();
      return finish(503, { error: 'STT_NOT_CONFIGURED' }, { code: 'STT_NOT_CONFIGURED' });
    }
    const ct = String(req.headers['content-type'] || '');
    if (!audioExt(ct)) {
      req.resume();
      return finish(415, { error: 'BAD_AUDIO_TYPE' }, { code: 'BAD_AUDIO_TYPE' });
    }
    if (!sttInFlight.acquire(key)) {
      req.resume();
      return finish(409, { error: 'IN_FLIGHT' }, { code: 'IN_FLIGHT' });
    }
    try {
      const rl = sttLimiter.take(key);
      if (!rl.ok) {
        req.resume();
        return finish(429, { error: 'RATE_LIMITED', retryAfterSec: rl.retryAfterSec }, { code: 'RATE_LIMITED' }, { 'retry-after': String(rl.retryAfterSec) });
      }
      let buf;
      try { buf = await readBody(req, config.limits.maxAudioBytes); }
      catch (e) { return finish(e.status || 400, { error: e.code || 'BAD_REQUEST' }, { code: e.code }); }
      if (buf.length < 200) return finish(400, { error: 'EMPTY_AUDIO' }, { code: 'EMPTY_AUDIO' });

      try {
        const raw = await transcribe(config.stt, buf, ct);
        const text = sanitizeInput(raw);
        if (!text) return finish(422, { error: 'EMPTY_TRANSCRIPT' }, { code: 'EMPTY_TRANSCRIPT' });
        const clipped = [...text].slice(0, config.limits.maxInputChars).join('');
        return finish(200, { text: clipped, truncated: clipped.length < text.length }, { lengthBucket: lengthBucket([...text].length) });
      } catch (e) {
        const err = e instanceof UpstreamError ? e : new UpstreamError('UPSTREAM_NETWORK');
        if (err.code === 'TIMEOUT') return finish(504, { error: 'TIMEOUT' }, { code: 'TIMEOUT' });
        return finish(502, { error: 'UPSTREAM_ERROR' }, { code: err.code, upstreamStatus: err.status });
      }
    } finally {
      sttInFlight.release(key);
    }
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS);
      return res.end();
    }
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, SECURITY_HEADERS);
      return res.end();
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = '/'; }
    try {
      if (pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, publicConfig());
      if (pathname === '/api/reveal' && req.method === 'POST') return await handleReveal(req, res);
      if (pathname === '/api/transcribe' && req.method === 'POST') return await handleTranscribe(req, res);
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'NOT_FOUND' });
      return await serveStatic(req, res, pathname);
    } catch {
      log('internal_error', { route: pathname.slice(0, 32) });
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL' });
      else res.end();
    }
  });
  server.requestTimeout = 120_000;
  return { server, log };
}
