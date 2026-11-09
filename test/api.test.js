import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, startApp, openaiReplies, llmEnv, reveal, J } from './helpers.js';

const JOB = '我很想辞职去做自己喜欢的事，可是每个月还有一万二的房贷，家里人也指望着我，我觉得自己既不敢走，也不甘心留。';
const WAIT = '我们暧昧了快半年，他说现在工作太忙，等过了这阵子再说。我不知道该继续等，还是该停下来，每天都在看他有没有回消息。';
const TIRED = '最近很累';
const CRISIS = '我真的撑不下去了，这几天一直在想，不想活了。';

function promptOf(call) {
  const body = JSON.parse(call.body.toString('utf8'));
  return body.messages.map((m) => m.content).join('\n');
}

describe('场景：辞职与房贷责任的两难', () => {
  test('首次输出替人裁决 → 带检查结论重新生成一次 → 返回合格的一句', async (t) => {
    const good = '不敢走是因为你把家人放在心上，不甘心留是因为你还没把自己放下，这两样都不是错。';
    const mock = await startMock(openaiReplies(
      J({ mode: 'normal', anchor: '房贷', sentence: '房贷总有办法，辞职吧，去做那件让你眼睛发亮的事。' }),
      J({ mode: 'normal', anchor: '既不敢走，也不甘心留', sentence: good }),
    ));
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });

    const r = await reveal(app.base, JOB);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { kind: 'normal', sentence: good });
    assert.equal(mock.calls.length, 2);
    assert.match(promptOf(mock.calls[0]), /一万二的房贷/, '整段原文都交给模型');
    assert.match(promptOf(mock.calls[1]), /没有通过检查：替他做了重大选择/, '重试时附带检查结论');
    assert.equal(mock.calls[0].headers.authorization, 'Bearer test-secret-key-should-never-leak');
  });
});

describe('场景：等待关系中的不确定', () => {
  test('揣定对方心意的输出被拒，第二次合格', async (t) => {
    const good = '你每天看的不只是他的消息，也是自己还能不能继续悬着，这份等待也需要被你照看。';
    const mock = await startMock(openaiReplies(
      J({ mode: 'normal', anchor: '等过了这阵子再说', sentence: '他一定也在乎你，只是工作太忙，再给他一点时间吧。' }),
      J({ mode: 'normal', anchor: '每天都在看他有没有回消息', sentence: good }),
    ));
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, WAIT);
    assert.equal(r.status, 200);
    assert.equal(r.data.sentence, good);
    assert.equal(mock.calls.length, 2);
  });
});

describe('场景：仅说“最近很累”的信息不足', () => {
  test('依据只能来自原文；编造细节的 anchor 被拒', async (t) => {
    const good = '能说出最近很累，已经是在替自己留意了，这份累不必先找到理由才算数。';
    const mock = await startMock(openaiReplies(
      J({ mode: 'normal', anchor: '工作压力太大', sentence: '工作压力把你压得喘不过气，你已经很久没有为自己停一停了。' }),
      J({ mode: 'normal', anchor: '最近很累', sentence: good }),
    ));
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, TIRED);
    assert.equal(r.status, 200);
    assert.equal(r.data.sentence, good);
    assert.equal(mock.calls.length, 2);
  });
});

describe('场景：自伤危机', () => {
  test('模型未配置时，仍给出固定的安全支持信息（标注非模型生成），不是报错', async (t) => {
    const app = await startApp({});
    t.after(() => app.close());
    const r = await reveal(app.base, CRISIS);
    assert.equal(r.status, 200);
    assert.equal(r.data.kind, 'safety');
    assert.equal(r.data.sentence, null);
    assert.equal(r.data.modelWritten, false);
    assert.ok(r.data.safety.items.some((i) => i.detail.includes('12356')));
    assert.ok(r.data.safety.items.some((i) => i.detail.includes('120')));
  });

  test('模型已配置：提示词要求 crisis 模式，允许多句，并附安全信息', async (t) => {
    const s = '你写下的这些很重，谢谢你说出来。此刻请先让一个人知道：打给身边信任的人，或拨 12356。';
    const mock = await startMock(openaiReplies(J({ mode: 'crisis', sentence: s })));
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, CRISIS);
    assert.equal(r.status, 200);
    assert.equal(r.data.kind, 'safety');
    assert.equal(r.data.sentence, s);
    assert.equal(r.data.modelWritten, true);
    assert.match(promptOf(mock.calls[0]), /请使用 crisis 模式/);
  });

  test('关键词没识别到、但模型判断为危机时，也走安全支持', async (t) => {
    const mock = await startMock(openaiReplies(J({ mode: 'crisis', sentence: '你说想让一切停下来，这听起来很重。请现在就联系一个信任的人，或拨打 12356。' })));
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, '我只想让一切都停下来，永远地。');
    assert.equal(r.data.kind, 'safety');
  });

  test('模型超时、被限流时，危机表达仍得到安全支持', async (t) => {
    const mock = await startMock(async (req, body, res) => { await new Promise((x) => setTimeout(x, 1500)); res.end('{}'); });
    const app = await startApp(llmEnv(mock.url, { LLM_TIMEOUT_MS: '200', RATE_REVEAL_PER_WINDOW: '1' }));
    t.after(async () => { await app.close(); await mock.close(); });
    const a = await reveal(app.base, CRISIS);
    assert.equal(a.status, 200);
    assert.equal(a.data.kind, 'safety');
    const b = await reveal(app.base, CRISIS); // 已超出限流
    assert.equal(b.status, 200);
    assert.equal(b.data.kind, 'safety');
  });
});

describe('场景：超时', () => {
  test('上游超时 → 504 TIMEOUT，不自动重试，交给用户手动重试', async (t) => {
    const mock = await startMock(async (req, body, res) => { await new Promise((x) => setTimeout(x, 1500)); res.end('{}'); });
    const app = await startApp(llmEnv(mock.url, { LLM_TIMEOUT_MS: '300' }));
    t.after(async () => { await app.close(); await mock.close(); });
    const started = Date.now();
    const r = await reveal(app.base, JOB);
    assert.equal(r.status, 504);
    assert.equal(r.data.error, 'TIMEOUT');
    assert.equal(mock.calls.length, 1);
    assert.ok(Date.now() - started < 1400);
  });

  test('整体截止时间也会触发超时', async (t) => {
    const mock = await startMock(async (req, body, res) => { await new Promise((x) => setTimeout(x, 1500)); res.end('{}'); });
    const app = await startApp(llmEnv(mock.url, { LLM_TIMEOUT_MS: '10000', REVEAL_DEADLINE_MS: '300' }));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, JOB);
    assert.equal(r.status, 504);
  });
});

describe('场景：模型输出多段', () => {
  test('两次都输出多段 → 422，诚实提示，不拼凑也不用句库', async (t) => {
    const multi = '你现在面临的是一个两难。\n\n一方面，房贷是现实的责任；\n另一方面，你的热爱也值得被尊重。\n\n建议：1. 先存够半年生活费 2. 和家人沟通。';
    const mock = await startMock(openaiReplies(multi, J({ mode: 'normal', anchor: '房贷', sentence: '你在算房贷，\n\n也在算自己。' })));
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, JOB);
    assert.equal(r.status, 422);
    assert.deepEqual(r.data, { error: 'GENERATION_REJECTED' });
    assert.equal(mock.calls.length, 2, '最多重新生成一次');
  });
});

describe('未配置、限流、长度、并发', () => {
  test('模型未配置 → 503 MODEL_NOT_CONFIGURED，配置接口如实报告', async (t) => {
    const app = await startApp({});
    t.after(() => app.close());
    const r = await reveal(app.base, JOB);
    assert.equal(r.status, 503);
    assert.equal(r.data.error, 'MODEL_NOT_CONFIGURED');
    const c = await (await fetch(`${app.base}/api/config`)).json();
    assert.equal(c.model.configured, false);
    assert.equal(c.stt.configured, false);
    assert.match(c.model.vendor, /尚未确定/);
  });

  test('密钥不会出现在配置接口或网页资源中', async (t) => {
    const mock = await startMock(openaiReplies('{}'));
    const app = await startApp(llmEnv(mock.url, { STT_API_KEY: 'stt-secret-xyz', STT_BASE_URL: mock.url, STT_MODEL: 'm' }));
    t.after(async () => { await app.close(); await mock.close(); });
    for (const p of ['/api/config', '/', '/app.js', '/styles.css']) {
      const txt = await (await fetch(app.base + p)).text();
      assert.ok(!txt.includes('test-secret-key') && !txt.includes('stt-secret-xyz'), p);
    }
  });

  test('限流 → 429 并带 retry-after', async (t) => {
    const mock = await startMock(openaiReplies(J({ mode: 'normal', anchor: '最近很累', sentence: '能说出最近很累，已经是在替自己留意了，这份累不必先找到理由才算数。' })));
    const app = await startApp(llmEnv(mock.url, { RATE_REVEAL_PER_WINDOW: '2' }));
    t.after(async () => { await app.close(); await mock.close(); });
    assert.equal((await reveal(app.base, TIRED)).status, 200);
    assert.equal((await reveal(app.base, TIRED)).status, 200);
    const r = await fetch(`${app.base}/api/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ text: TIRED }) });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });

  test('长度限制与空输入', async (t) => {
    const app = await startApp({ MAX_INPUT_CHARS: '50' });
    t.after(() => app.close());
    assert.equal((await reveal(app.base, '累'.repeat(51))).status, 413);
    assert.equal((await reveal(app.base, '   \n ')).status, 400);
    const big = await fetch(`${app.base}/api/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ text: 'x'.repeat(40000) }) });
    assert.equal(big.status, 413);
    const wrongType = await fetch(`${app.base}/api/reveal`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    assert.equal(wrongType.status, 415);
  });

  test('同一来源并发提交 → 第二个 409（防重复提交）', async (t) => {
    const mock = await startMock(async (req, body, res, i) => {
      await new Promise((x) => setTimeout(x, 300));
      openaiReplies(J({ mode: 'normal', anchor: '最近很累', sentence: '能说出最近很累，已经是在替自己留意了，这份累不必先找到理由才算数。' }))(req, body, res, i);
    });
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const [a, b] = await Promise.all([reveal(app.base, TIRED), reveal(app.base, TIRED)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(mock.calls.length, 1);
  });

  test('上游 HTTP 错误 → 502，不泄露上游响应体', async (t) => {
    const mock = await startMock((req, body, res) => { res.writeHead(401); res.end('{"error":"invalid key sk-xxx"}'); });
    const app = await startApp(llmEnv(mock.url));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, JOB);
    assert.equal(r.status, 502);
    assert.deepEqual(r.data, { error: 'UPSTREAM_ERROR' });
  });
});

describe('Anthropic Messages API 适配', () => {
  test('请求格式与解析', async (t) => {
    const s = '能说出最近很累，已经是在替自己留意了，这份累不必先找到理由才算数。';
    const mock = await startMock((req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(J({ content: [{ type: 'text', text: J({ mode: 'normal', anchor: '最近很累', sentence: s }) }] }));
    });
    const app = await startApp(llmEnv(mock.url, { LLM_PROVIDER: 'anthropic' }));
    t.after(async () => { await app.close(); await mock.close(); });
    const r = await reveal(app.base, TIRED);
    assert.equal(r.data.sentence, s);
    const call = mock.calls[0];
    assert.equal(call.url, '/v1/messages');
    assert.equal(call.headers['x-api-key'], 'test-secret-key-should-never-leak');
    const body = JSON.parse(call.body);
    assert.match(body.system, /命之书/);
    assert.equal(body.messages[0].role, 'user');
  });
});

describe('日志不记录正文', () => {
  test('输入、输出、转写文本都不出现在日志中', async (t) => {
    const s = '你每天看的不只是他的消息，也是自己还能不能继续悬着，这份等待也需要被你照看。';
    const llm = await startMock(openaiReplies(J({ mode: 'normal', anchor: '每天都在看他有没有回消息', sentence: s })));
    const stt = await startMock((req, body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(J({ text: '转写出来的秘密内容' })); });
    const app = await startApp(llmEnv(llm.url, { STT_BASE_URL: stt.url, STT_API_KEY: 'k', STT_MODEL: 'm' }));
    t.after(async () => { await app.close(); await llm.close(); await stt.close(); });
    await reveal(app.base, WAIT);
    await reveal(app.base, CRISIS);
    await fetch(`${app.base}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(1000, 1) });
    const all = app.logs.join('\n');
    assert.ok(app.logs.length >= 3);
    for (const secret of ['暧昧', '回消息', '撑不下去', '悬着', '秘密内容', 'test-secret']) {
      assert.ok(!all.includes(secret), `日志中出现了：${secret}`);
    }
  });
});
