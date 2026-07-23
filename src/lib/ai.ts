export type AiConfig = { baseUrl: string; apiKey: string; model: string };

export function buildPrPrompt(source: string, target: string, commits: string[]) {
  return `为 GitHub Pull Request 生成简洁的中文标题和描述。分支：${source} → ${target}。提交：\n${commits.map(commit => `- ${commit}`).join('\n')}\n仅返回 JSON：{"title":"...","body":"..."}。`;
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
