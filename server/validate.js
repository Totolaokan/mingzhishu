// 检查模型输出的格式、依据与安全性。全部按纯文本处理。

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

/** 用户输入清洗：去控制字符与双向控制符，统一换行，裁掉首尾空白。 */
export function sanitizeInput(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
}

function squash(s) {
  return String(s).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

const RULES = [
  { code: 'preach', re: /(你应该|你应当|你必须|你得学会|你要学会|一定要|千万(不要|别)|务必)/, msg: '出现了说教或命令的语气' },
  { code: 'platitude', re: /(一切都会好起来|都会过去的|加油|要相信自己|阳光总在风雨后|时间会(治愈|冲淡)|明天会更好|做最好的自己)/, msg: '是泛泛的安慰' },
  { code: 'diagnosis', re: /(抑郁症|焦虑症|双相|躁郁|人格障碍|创伤后应激|PTSD|强迫症|你(这是|是|有|得了)(抑郁|焦虑|心理疾病|病))/i, msg: '出现了诊断性的说法' },
  { code: 'fabricated', re: /(我(也)?曾经|我当年|我也经历过|我年轻时|我认识(一个|的)|有个朋友|曾经有(一个|个)人)/, msg: '编造了经历' },
  { code: 'mindreading', re: /(他|她|对方|那个人|TA|ta)(一定|肯定|其实|心里|分明)(是|也|在|会|还|就|不|没|爱|想|在乎)/, msg: '揣定了他人的想法或心意' },
  { code: 'decision', re: /(辞职吧|别辞职|不要辞职|该辞职|就辞了|分手吧|该分手|别分手|离开(他|她|吧)|放手吧|别再等了|继续等(下去)?吧)/, msg: '替他做了重大选择' },
  { code: 'quote', re: /(——\s*[^\s，。]{1,12}$|名言|曾(经)?说(过)?[:：「“"]|古人云|有句话(说|叫))/, msg: '引用了名言或他人的话' },
  { code: 'question', re: /[?？]/, msg: '用了提问或追问' },
  { code: 'heading', re: /^(给你的话|命之书|答案|回应|结果)\s*[:：]/, msg: '附加了标题' },
  { code: 'list', re: /(^|\s)([-*•#]|\d+[.、)])\s?/, msg: '出现了列表或标记' },
  { code: 'meta', re: /(作为(一个)?(AI|人工智能|语言模型)|我无法|我不能)/i, msg: '出现了无关的自我说明' },
];

// 危机模式下仍禁止的内容
const CRISIS_RULES = [
  RULES.find((r) => r.code === 'diagnosis'),
  RULES.find((r) => r.code === 'fabricated'),
  RULES.find((r) => r.code === 'meta'),
  { code: 'method', re: /(剂量|多少片|高度|方法是|怎么(做|才能)死)/, msg: '涉及不安全的细节' },
];

function extractJson(raw) {
  let s = String(raw ?? '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function hanCount(s) {
  return (s.match(/\p{Script=Han}/gu) || []).length;
}

/**
 * @param {string} raw 模型原始输出
 * @param {string} input 用户原文（已清洗）
 * @param {{crisisHint?: boolean}} opts
 * @returns {{ok: true, value: {mode: 'normal'|'crisis', sentence: string}} | {ok: false, code: string, reason: string}}
 */
export function validateOutput(raw, input, { crisisHint = false } = {}) {
  const obj = extractJson(raw);
  if (!obj) return { ok: false, code: 'format', reason: '输出不是唯一的 JSON 对象（可能多了其他文字或分成了多段）' };

  const mode = obj.mode === 'crisis' ? 'crisis' : obj.mode === 'normal' ? 'normal' : null;
  if (!mode) return { ok: false, code: 'format', reason: 'mode 只能是 normal 或 crisis' };
  if (typeof obj.sentence !== 'string') return { ok: false, code: 'format', reason: '缺少 sentence' };

  const sentence = obj.sentence.replace(CONTROL_CHARS, '').trim().replace(/^["“「『'](.*)["”」』']$/s, '$1').trim();
  if (/\n/.test(sentence)) return { ok: false, code: 'multipart', reason: '分成了多段' };
  if (/[<>]|https?:|www\./i.test(sentence)) return { ok: false, code: 'markup', reason: '包含链接或标记' };

  if (mode === 'crisis' || crisisHint) {
    if (sentence.length < 6 || sentence.length > 200) return { ok: false, code: 'length', reason: '安全回应的长度不合适' };
    for (const r of CRISIS_RULES) if (r.re.test(sentence)) return { ok: false, code: r.code, reason: r.msg };
    return { ok: true, value: { mode: 'crisis', sentence } };
  }

  // —— 普通模式：只允许一个完整句子 ——
  const len = [...sentence].length;
  if (hanCount(sentence) < 6) return { ok: false, code: 'language', reason: '不是中文句子或过短' };
  if (len > 90) return { ok: false, code: 'length', reason: `太长了（${len} 字），请收在六十字左右` };
  const body = sentence.replace(/[。！!…\.]+["”’」』]*$/, '');
  if (/[。！!]|\.\s|…{2,}.+…/.test(body)) return { ok: false, code: 'multisentence', reason: '写成了不止一个句子' };
  for (const r of RULES) if (r.re.test(sentence)) return { ok: false, code: r.code, reason: r.msg };

  // —— 依据：anchor 必须逐字来自原文 ——
  const anchor = typeof obj.anchor === 'string' ? obj.anchor : '';
  const a = squash(anchor);
  if (a.length < 2 || a.length > 40 || !squash(input).includes(a)) {
    return { ok: false, code: 'grounding', reason: 'anchor 不是从原文中逐字摘出的片段' };
  }

  return { ok: true, value: { mode: 'normal', sentence } };
}
