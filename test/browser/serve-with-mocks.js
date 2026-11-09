// 仅供浏览器端测试：启动「模拟上游」与两个应用实例（已配置 / 未配置）。
// 模拟上游的回复是测试替身，用来验证界面与流程，不代表真实模型的写作质量。
import { startMock, startApp, J } from '../helpers.js';

const GOOD = {
  '房贷': { anchor: '既不敢走，也不甘心留', sentence: '不敢走是因为你把家人放在心上，不甘心留是因为你还没把自己放下，这两样都不是错。' },
  '最近很累': { anchor: '最近很累', sentence: '能说出最近很累，已经是在替自己留意了，这份累不必先找到理由才算数。' },
};

let slowCalls = 0;
const llm = await startMock(async (req, body, res) => {
  const prompt = JSON.parse(body.toString('utf8')).messages.map((m) => m.content).join('\n');
  const send = (content) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(J({ choices: [{ message: { content } }] }));
  };
  if (prompt.includes('测试超时')) {
    slowCalls++;
    // 第一次超时，之后正常（用来验证手动重试）
    if (slowCalls === 1) { await new Promise((r) => setTimeout(r, 4000)); return send('{}'); }
    return send(J({ mode: 'normal', anchor: '测试超时', sentence: '等了这么久你还愿意再试一次，说明这件事在你心里分量不轻。' }));
  }
  if (prompt.includes('测试多段')) return send('第一段。\n\n第二段。\n\n第三段。');
  if (prompt.includes('crisis 模式')) {
    return send(J({ mode: 'crisis', sentence: '你写下的这些很重，谢谢你愿意说出来。此刻请先让一个人知道：打给身边信任的人，或拨打 12356。' }));
  }
  await new Promise((r) => setTimeout(r, 1200)); // 让等待态可见
  for (const [k, v] of Object.entries(GOOD)) if (prompt.includes(k)) return send(J({ mode: 'normal', ...v }));
  return send(J({ mode: 'normal', anchor: '最近很累', sentence: '……' }));
});

const stt = await startMock((req, body, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(J({ text: '最近很累，不知道还要撑多久' }));
});

const configured = await startApp({
  LLM_PROVIDER: 'openai_compatible', LLM_BASE_URL: llm.url, LLM_API_KEY: 'k', LLM_MODEL: 'mock',
  LLM_TIMEOUT_MS: '2500',
  STT_BASE_URL: stt.url, STT_API_KEY: 'k', STT_MODEL: 'mock',
  LLM_VENDOR_LABEL: '测试用模拟模型', STT_VENDOR_LABEL: '测试用模拟转写',
});
const unconfigured = await startApp({});

console.log(J({ configured: configured.base, unconfigured: unconfigured.base, llmCalls: llm.url }));
process.stdin.resume();
