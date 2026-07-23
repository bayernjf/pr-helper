export type AiConfig = { baseUrl: string; apiKey: string; model: string };

export function aiChatCompletionsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

export async function testAiConnection(config: AiConfig) {
  const response = await fetch(aiChatCompletionsUrl(config.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 }) });
  if (!response.ok) throw new Error(`连接失败 (${response.status})`);
}

export function buildPrPrompt(source: string, target: string, commits: string[], generationRule = '') {
  const changes = commits.map(commit => `- ${commit}`).join('\n');
  const rule = generationRule.trim();
  const ruleInstruction = rule ? `\n\n请遵循以下 Markdown 生成规则：\n${rule}` : '';
  return `为 GitHub Pull Request 生成简洁的中文标题和描述。分支：${source} → ${target}。提交：\n${changes}${ruleInstruction}\n仅返回 JSON：{"title":"...","body":"..."}。`;
}

export async function generatePrMessage(config: AiConfig, prompt: string) {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }) });
  if (!response.ok) throw new Error(`AI 请求失败 (${response.status})`);
  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content || '';
  const json = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '')) as { title?: string; body?: string };
  if (!json.title) throw new Error('AI 未返回标题');
  return { title: json.title, body: json.body || '' };
}
