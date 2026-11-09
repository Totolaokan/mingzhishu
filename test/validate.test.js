import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput, sanitizeInput } from '../server/validate.js';
import { detectCrisis } from '../server/safety.js';
import { J } from './helpers.js';

const INPUT_JOB = '我很想辞职去做自己喜欢的事，可是每个月还有一万二的房贷，家里人也指望着我，我觉得自己既不敢走，也不甘心留。';

test('合格：一个句子 + 原文依据', () => {
  const v = validateOutput(J({ mode: 'normal', anchor: '既不敢走，也不甘心留', sentence: '不敢走是因为你把家人放在心上，不甘心留是因为你还没把自己放下，这两样都不是错。' }), INPUT_JOB);
  assert.equal(v.ok, true);
  assert.equal(v.value.mode, 'normal');
});

test('允许代码块包裹的 JSON', () => {
  const raw = '```json\n' + J({ mode: 'normal', anchor: '房贷', sentence: '你在算的不只是房贷，还有一个愿意替家人扛着的自己。' }) + '\n```';
  assert.equal(validateOutput(raw, INPUT_JOB).ok, true);
});

const rejects = [
  ['多段纯文本', '第一段：你很辛苦。\n\n第二段：也许可以先休息。', 'format'],
  ['JSON 外有多余文字', '好的，这是回应：' + J({ mode: 'normal', anchor: '房贷', sentence: '你在算的不只是房贷。' }), 'format'],
  ['sentence 内换行', J({ mode: 'normal', anchor: '房贷', sentence: '你在算的不只是房贷，\n还有你自己。' }), 'multipart'],
  ['两个句子', J({ mode: 'normal', anchor: '房贷', sentence: '你在算房贷，也在算自己。这两笔账都值得认真对待。' }), 'multisentence'],
  ['说教', J({ mode: 'normal', anchor: '房贷', sentence: '你应该先把房贷的事情想清楚，再决定要不要走。' }), 'preach'],
  ['替人裁决', J({ mode: 'normal', anchor: '房贷', sentence: '房贷总有办法，辞职吧，去做那件让你眼睛发亮的事。' }), 'decision'],
  ['泛泛安慰', J({ mode: 'normal', anchor: '房贷', sentence: '别担心房贷的事情，一切都会好起来的，相信未来。' }), 'platitude'],
  ['诊断', J({ mode: 'normal', anchor: '最近很累', sentence: '你这样长期的疲惫，可能是抑郁症的信号，需要被认真对待。' }), 'diagnosis'],
  ['编造经历', J({ mode: 'normal', anchor: '房贷', sentence: '我也曾经背着房贷站在辞职信前，后来才明白勇气是慢慢攒的。' }), 'fabricated'],
  ['揣定他人心意', J({ mode: 'normal', anchor: '他', sentence: '他一定也在想你，只是还没有找到开口的方式和时机。' }), 'mindreading'],
  ['引名言', J({ mode: 'normal', anchor: '房贷', sentence: '生活不止眼前的苟且，还有诗和远方的田野——高晓松' }), 'quote'],
  ['追问', J({ mode: 'normal', anchor: '房贷', sentence: '如果没有房贷，你最想去做的那件事会是什么呢？' }), 'question'],
  ['依据不在原文', J({ mode: 'normal', anchor: '老板总是批评我', sentence: '被否定得久了，你开始怀疑那份想走的心是不是在逃避。' }), 'grounding'],
  ['太长', J({ mode: 'normal', anchor: '房贷', sentence: '你'.repeat(10) + '在'.repeat(90) + '。' }), 'length'],
  ['英文', J({ mode: 'normal', anchor: '房贷', sentence: 'You are carrying more than a mortgage.' }), 'language'],
];

for (const [name, raw, code] of rejects) {
  test(`拒绝：${name}`, () => {
    const v = validateOutput(raw, INPUT_JOB + '最近很累');
    assert.equal(v.ok, false, `应当拒绝：${raw}`);
    assert.equal(v.code, code);
  });
}

test('危机模式允许多句，但仍禁止诊断', () => {
  const ok = validateOutput(J({ mode: 'crisis', sentence: '你写下的这些很重。此刻请先让一个人知道，给身边信任的人或 12356 打个电话。' }), '我不想活了');
  assert.equal(ok.ok, true);
  assert.equal(ok.value.mode, 'crisis');
  const bad = validateOutput(J({ mode: 'crisis', sentence: '你可能得了抑郁症，请去医院。' }), '我不想活了');
  assert.equal(bad.ok, false);
});

test('危机识别', () => {
  for (const t of ['我真的不想活了', '有时候想结束自己的生命', '昨晚又在想自杀的事', '我会伤害自己', '活 不 下 去 了']) {
    assert.equal(detectCrisis(t), true, t);
  }
  for (const t of ['最近很累', '笑死我了', '这个项目要把我累趴了', '我想辞职但有房贷']) {
    assert.equal(detectCrisis(t), false, t);
  }
});

test('输入清洗去掉控制字符与双向控制符', () => {
  assert.equal(sanitizeInput('  你好‮\u0007世界\r\n  '), '你好世界');
});
