import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { server, log } = createApp(config);

server.listen(config.port, config.host, () => {
  log('startup', {
    host: config.host,
    port: config.port,
    llmConfigured: config.llm.configured,
    sttConfigured: config.stt.configured,
  });
  const lines = [
    `命之书 已启动：http://${config.host}:${config.port}`,
    config.llm.configured
      ? `  模型：已配置（${config.llm.provider}）`
      : '  模型：未配置 —— 需要 LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，见 README',
    config.stt.configured
      ? '  语音转写：已配置'
      : '  语音转写：未配置 —— 需要 STT_BASE_URL / STT_API_KEY / STT_MODEL，见 README（文字输入不受影响）',
  ];
  console.error(lines.join('\n'));
});
