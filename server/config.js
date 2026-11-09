// 所有密钥只从服务端环境变量读取，绝不下发到网页。

function int(v, d) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function loadConfig(env = process.env) {
  const llmProvider = str(env.LLM_PROVIDER) || 'openai_compatible';
  const llm = {
    provider: llmProvider,
    apiKey: str(env.LLM_API_KEY),
    baseUrl: str(env.LLM_BASE_URL).replace(/\/+$/, ''),
    model: str(env.LLM_MODEL),
    vendorLabel: str(env.LLM_VENDOR_LABEL) || '大模型服务（供应商尚未确定）',
    timeoutMs: int(env.LLM_TIMEOUT_MS, 20000),
  };
  llm.configured = Boolean(
    llm.apiKey && llm.baseUrl && llm.model &&
    ['openai_compatible', 'anthropic'].includes(llm.provider)
  );

  const stt = {
    apiKey: str(env.STT_API_KEY),
    baseUrl: str(env.STT_BASE_URL).replace(/\/+$/, ''),
    model: str(env.STT_MODEL),
    vendorLabel: str(env.STT_VENDOR_LABEL) || '语音转写服务（供应商尚未确定）',
    timeoutMs: int(env.STT_TIMEOUT_MS, 30000),
    language: str(env.STT_LANGUAGE) || 'zh',
  };
  stt.configured = Boolean(stt.apiKey && stt.baseUrl && stt.model);

  return {
    host: str(env.HOST) || '127.0.0.1',
    port: int(env.PORT, 8787),
    trustProxy: env.TRUST_PROXY === '1',
    llm,
    stt,
    limits: {
      maxInputChars: int(env.MAX_INPUT_CHARS, 1000),
      maxJsonBytes: 16 * 1024,
      maxAudioBytes: int(env.MAX_AUDIO_BYTES, 4 * 1024 * 1024),
      maxRecordSeconds: int(env.MAX_RECORD_SECONDS, 90),
      windowMs: int(env.RATE_WINDOW_MS, 10 * 60 * 1000),
      revealPerWindow: int(env.RATE_REVEAL_PER_WINDOW, 8),
      transcribePerWindow: int(env.RATE_TRANSCRIBE_PER_WINDOW, 12),
      globalRevealPerMinute: int(env.RATE_GLOBAL_REVEAL_PER_MINUTE, 60),
      overallDeadlineMs: int(env.REVEAL_DEADLINE_MS, 45000),
    },
  };
}
