import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, startApp, J } from './helpers.js';

const AUDIO = Buffer.alloc(4000, 7);

async function post(base, body, type = 'audio/webm;codecs=opus') {
  const r = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'content-type': type }, body });
  return { status: r.status, data: await r.json() };
}

function sttEnv(url, extra = {}) {
  return { STT_BASE_URL: url, STT_API_KEY: 'stt-key', STT_MODEL: 'whisper-mock', ...extra };
}

describe('场景：语音失败（服务端）', () => {
  test('未配置转写 → 503 STT_NOT_CONFIGURED（不伪造转写）', async (t) => {
    const app = await startApp({});
    t.after(() => app.close());
    const r = await post(app.base, AUDIO);
    assert.equal(r.status, 503);
    assert.deepEqual(r.data, { error: 'STT_NOT_CONFIGURED' });
  });

  test('上游转写报错 → 502', async (t) => {
    const mock = await startMock((req, body, res) => { res.writeHead(500); res.end('boom'); });
    const app = await startApp(sttEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await post(app.base, AUDIO);
    assert.equal(r.status, 502);
  });

  test('上游超时 → 504', async (t) => {
    const mock = await startMock(async (req, body, res) => { await new Promise((x) => setTimeout(x, 1500)); res.end('{}'); });
    const app = await startApp(sttEnv(mock.url, { STT_TIMEOUT_MS: '200' }));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await post(app.base, AUDIO);
    assert.equal(r.status, 504);
  });

  test('转写为空 → 422 EMPTY_TRANSCRIPT', async (t) => {
    const mock = await startMock((req, body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(J({ text: '   ' })); });
    const app = await startApp(sttEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await post(app.base, AUDIO);
    assert.equal(r.status, 422);
  });

  test('格式不对 / 过短 / 过大', async (t) => {
    const mock = await startMock((req, body, res) => { res.end(J({ text: 'x' })); });
    const app = await startApp(sttEnv(mock.url, { MAX_AUDIO_BYTES: '10000' }));
    t.after(async () => { await app.close(); await mock.close(); });
    assert.equal((await post(app.base, AUDIO, 'video/mp4')).status, 415);
    assert.equal((await post(app.base, Buffer.alloc(10))).status, 400);
    assert.equal((await post(app.base, Buffer.alloc(20000))).status, 413);
    assert.equal(mock.calls.length, 0);
  });
});

describe('语音成功路径', () => {
  test('multipart 转交上游，返回可编辑文本，不直接触发生成', async (t) => {
    const mock = await startMock((req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(J({ text: '我最近很累，不知道还要撑多久。' }));
    });
    const app = await startApp(sttEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await post(app.base, AUDIO);
    assert.equal(r.status, 200);
    assert.equal(r.data.text, '我最近很累，不知道还要撑多久。');
    const call = mock.calls[0];
    assert.equal(call.url, '/audio/transcriptions');
    assert.equal(call.headers.authorization, 'Bearer stt-key');
    assert.match(call.headers['content-type'], /multipart\/form-data/);
    const raw = call.body.toString('latin1');
    assert.match(raw, /name="model"\r\n\r\nwhisper-mock/);
    assert.match(raw, /filename="audio.webm"/);
    assert.equal(mock.calls.length, 1, '只转写，不调用模型');
  });
});
