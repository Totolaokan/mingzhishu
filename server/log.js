// 应用日志只记录元数据（事件、状态码、耗时、字数区间），从不记录倾诉正文、转写文本或模型输出。

const ALLOWED_FIELDS = new Set([
  'route', 'status', 'code', 'ms', 'attempt', 'reason', 'lengthBucket',
  'kind', 'crisis', 'upstreamStatus', 'audioBytesBucket', 'port', 'host',
  'llmConfigured', 'sttConfigured',
]);

export function lengthBucket(n) {
  if (n <= 20) return '≤20';
  if (n <= 100) return '21-100';
  if (n <= 300) return '101-300';
  return '>300';
}

export function createLogger(sink = (line) => process.stdout.write(line + '\n')) {
  return function log(event, fields = {}) {
    const safe = {};
    for (const [k, v] of Object.entries(fields)) {
      // 白名单之外的字段一律丢弃，避免误把正文写进日志
      if (ALLOWED_FIELDS.has(k) && (typeof v !== 'string' || v.length <= 64)) safe[k] = v;
    }
    sink(JSON.stringify({ t: new Date().toISOString(), event, ...safe }));
  };
}
