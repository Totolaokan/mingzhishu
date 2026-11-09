// 危机表达的保守识别与安全支持信息。
// 这里的文字是固定的安全资源说明，前端会明确标注，不会冒充模型写给用户的那句话。

const CRISIS_PATTERNS = [
  /想死/, /不想活/, /活不下去/, /活着没(有)?意思/, /自杀/, /轻生/, /寻死/,
  /结束(自己的)?生命/, /了结自己/, /结束这一切/, /不想再醒来/, /消失(在这个世界|掉算了)/,
  /割腕/, /跳楼/, /跳河/, /上吊/, /烧炭/, /自残/, /自伤/, /伤害自己/,
  /(吞|吃)(了)?.{0,6}(安眠药|药片|一整瓶)/, /遗书/, /死了(就|才)?(好|算了|解脱)/,
  /kill myself/i, /suicid/i, /self[- ]?harm/i, /end my life/i,
];

export function detectCrisis(text) {
  const t = String(text || '').replace(/\s+/g, '');
  return CRISIS_PATTERNS.some((re) => re.test(t));
}

export const SAFETY_RESOURCES = {
  lead: '你的安全比任何问题都重要。如果你正想伤害自己，或已经有了打算，请现在就让一个人知道。',
  items: [
    { label: '有立即危险', detail: '拨打 120（急救）或 110（报警）' },
    { label: '全国统一心理援助热线', detail: '12356' },
    { label: '身边的人', detail: '联系一位你信任的人，请他此刻陪在你身边' },
  ],
  note: '不在中国大陆时，请拨打当地紧急电话或当地心理危机热线。这个网页不能替代专业帮助。',
};
