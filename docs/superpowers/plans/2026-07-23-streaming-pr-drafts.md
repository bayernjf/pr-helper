# Streaming PR Generation and Draft Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream AI-generated PR titles and descriptions into the create-PR dialog while preserving per-repository and per-branch drafts for 24 hours.

**Architecture:** Keep draft lifecycle rules in a pure `pr-drafts` domain module and keep OpenAI-compatible SSE parsing in a separate `ai-stream` module. `src/main.ts` remains the browser integration layer: it restores and saves drafts, owns dialog timers and abort controllers, confirms overwrite, and clears a draft only after GitHub confirms PR creation.

**Tech Stack:** Vite, vanilla TypeScript, DOM `dialog`, Fetch/ReadableStream SSE, `localStorage`, Vitest.

---

## File map

- Create `src/lib/pr-drafts.ts`: draft identity, parsing, expiration, capacity, lookup, update, deletion, and safe loading.
- Create `src/lib/pr-drafts.test.ts`: deterministic domain tests with injected timestamps and storage readers.
- Create `src/lib/ai-stream.ts`: OpenAI Chat Completions SSE decoding, incremental partial-JSON extraction, final JSON validation, and cancellation support.
- Create `src/lib/ai-stream.test.ts`: unit tests using synthetic `Response` and `ReadableStream` objects; no real network.
- Modify `src/lib/ai.ts`: retain configuration, endpoint, connection test, and prompt building; remove the obsolete non-streaming generator.
- Modify `src/main.ts`: integrate draft persistence, overwrite confirmation, streamed field updates, error handling, and request cancellation.
- Modify `src/style.css`: make disabled generation controls visibly inert.

### Task 1: PR Draft Domain

**Files:**
- Create: `src/lib/pr-drafts.test.ts`
- Create: `src/lib/pr-drafts.ts`

- [ ] **Step 1: Write failing tests for identity, validation, TTL, capacity, updates, deletion, and safe reads**

Create `src/lib/pr-drafts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  deletePullRequestDraft,
  findPullRequestDraft,
  loadPullRequestDrafts,
  parsePullRequestDrafts,
  pullRequestDraftKey,
  upsertPullRequestDraft,
  type PullRequestDraft,
} from './pr-drafts';

const hour = 60 * 60 * 1000;
const nowMs = Date.parse('2026-07-23T12:00:00.000Z');
const identity = { repository: 'acme/app', source: 'feature/login', target: 'dev' };

function draft(overrides: Partial<PullRequestDraft> = {}): PullRequestDraft {
  return {
    ...identity,
    key: pullRequestDraftKey(identity),
    title: 'Login',
    body: 'Adds login',
    updatedAt: '2026-07-23T11:00:00.000Z',
    ...overrides,
  };
}

describe('PR drafts', () => {
  it('creates a stable, unambiguous key from repository and branch direction', () => {
    expect(pullRequestDraftKey(identity)).toBe(pullRequestDraftKey({ ...identity }));
    expect(pullRequestDraftKey(identity)).not.toBe(pullRequestDraftKey({ ...identity, target: 'main' }));
    expect(pullRequestDraftKey({ repository: 'a/b', source: 'c', target: 'd' }))
      .not.toBe(pullRequestDraftKey({ repository: 'a', source: 'b/c', target: 'd' }));
  });

  it('parses valid records and drops individual malformed records', () => {
    expect(parsePullRequestDrafts(JSON.stringify([draft(), { title: 7 }]), nowMs)).toEqual([draft()]);
    expect(parsePullRequestDrafts('{', nowMs)).toEqual([]);
    expect(parsePullRequestDrafts(JSON.stringify({ drafts: [] }), nowMs)).toEqual([]);
  });

  it('keeps drafts younger than 24 hours and expires the exact boundary', () => {
    const recent = draft({ updatedAt: new Date(nowMs - 24 * hour + 1).toISOString() });
    const expiredIdentity = { ...identity, target: 'main' };
    const expired = draft({
      ...expiredIdentity,
      key: pullRequestDraftKey(expiredIdentity),
      updatedAt: new Date(nowMs - 24 * hour).toISOString(),
    });
    expect(parsePullRequestDrafts(JSON.stringify([recent, expired]), nowMs)).toEqual([recent]);
  });

  it('does not change updatedAt when a draft is only found', () => {
    const existing = draft();
    expect(findPullRequestDraft([existing], identity)).toEqual(existing);
  });

  it('upserts content with the supplied update time without mutating the input', () => {
    const before = [draft()];
    const updated = upsertPullRequestDraft(before, identity, { title: 'New', body: 'Body' }, nowMs);
    expect(updated[0]).toMatchObject({ title: 'New', body: 'Body', updatedAt: '2026-07-23T12:00:00.000Z' });
    expect(before[0].title).toBe('Login');
  });

  it('retains the 50 most recently updated drafts', () => {
    const many = Array.from({ length: 51 }, (_, index) => {
      const itemIdentity = { ...identity, repository: `acme/repo-${index}` };
      return draft({
        ...itemIdentity,
        key: pullRequestDraftKey(itemIdentity),
        updatedAt: new Date(nowMs - (50 - index) * 1000).toISOString(),
      });
    });
    const result = parsePullRequestDrafts(JSON.stringify(many), nowMs);
    expect(result).toHaveLength(50);
    expect(result.some(item => item.repository === 'acme/repo-0')).toBe(false);
    expect(result.some(item => item.repository === 'acme/repo-50')).toBe(true);
  });

  it('deletes only the matching draft', () => {
    const other = draft({ key: pullRequestDraftKey({ ...identity, target: 'main' }), target: 'main' });
    expect(deletePullRequestDraft([draft(), other], identity)).toEqual([other]);
  });

  it('falls back to an empty list when storage reading throws', () => {
    expect(loadPullRequestDrafts(() => { throw new Error('denied'); }, nowMs)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the draft test and verify RED**

Run: `npm test -- src/lib/pr-drafts.test.ts`

Expected: FAIL because `./pr-drafts` does not exist.

- [ ] **Step 3: Implement the pure draft domain module**

Create `src/lib/pr-drafts.ts`:

```ts
export type PullRequestDraftIdentity = {
  repository: string;
  source: string;
  target: string;
};

export type PullRequestDraft = PullRequestDraftIdentity & {
  key: string;
  title: string;
  body: string;
  updatedAt: string;
};

export const PULL_REQUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const PULL_REQUEST_DRAFT_LIMIT = 50;

export function pullRequestDraftKey(identity: PullRequestDraftIdentity) {
  return JSON.stringify([identity.repository, identity.source, identity.target]);
}

function isDraft(value: unknown): value is PullRequestDraft {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (!['key', 'repository', 'source', 'target', 'title', 'body', 'updatedAt']
    .every(field => typeof item[field] === 'string')) return false;
  const identity = item as PullRequestDraft;
  return Boolean(identity.repository && identity.source && identity.target)
    && identity.key === pullRequestDraftKey(identity)
    && Number.isFinite(Date.parse(identity.updatedAt));
}

function prune(drafts: readonly PullRequestDraft[], nowMs: number) {
  return drafts
    .filter(item => nowMs - Date.parse(item.updatedAt) < PULL_REQUEST_DRAFT_TTL_MS)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, PULL_REQUEST_DRAFT_LIMIT);
}

export function parsePullRequestDrafts(raw: string | null, nowMs: number): PullRequestDraft[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return prune(parsed.filter(isDraft), nowMs);
  } catch {
    return [];
  }
}

export function loadPullRequestDrafts(read: () => string | null, nowMs: number) {
  try {
    return parsePullRequestDrafts(read(), nowMs);
  } catch {
    return [];
  }
}

export function findPullRequestDraft(
  drafts: readonly PullRequestDraft[],
  identity: PullRequestDraftIdentity,
) {
  const key = pullRequestDraftKey(identity);
  return drafts.find(item => item.key === key);
}

export function upsertPullRequestDraft(
  drafts: readonly PullRequestDraft[],
  identity: PullRequestDraftIdentity,
  content: Pick<PullRequestDraft, 'title' | 'body'>,
  nowMs: number,
) {
  const key = pullRequestDraftKey(identity);
  const next = drafts.filter(item => item.key !== key);
  next.push({ ...identity, key, ...content, updatedAt: new Date(nowMs).toISOString() });
  return prune(next, nowMs);
}

export function deletePullRequestDraft(
  drafts: readonly PullRequestDraft[],
  identity: PullRequestDraftIdentity,
) {
  const key = pullRequestDraftKey(identity);
  return drafts.filter(item => item.key !== key);
}
```

- [ ] **Step 4: Run the focused and full test suites**

Run: `npm test -- src/lib/pr-drafts.test.ts`

Expected: 8 tests PASS.

Run: `npm test`

Expected: all existing and draft tests PASS.

- [ ] **Step 5: Commit the draft domain**

```bash
git add src/lib/pr-drafts.ts src/lib/pr-drafts.test.ts
git commit -m "feat(drafts): add PR draft lifecycle domain"
```

### Task 2: Incremental PR JSON Parser

**Files:**
- Create: `src/lib/ai-stream.test.ts`
- Create: `src/lib/ai-stream.ts`

- [ ] **Step 1: Write failing tests for partial JSON extraction and final validation**

Create `src/lib/ai-stream.test.ts` with the parser tests first:

```ts
import { describe, expect, it, vi } from 'vitest';

import { parseFinalPrMessage, parsePartialPrMessage } from './ai-stream';

describe('incremental PR JSON', () => {
  it('exposes title and body as incomplete JSON strings grow', () => {
    expect(parsePartialPrMessage('{"title":"登录修')).toEqual({ title: '登录修', body: '' });
    expect(parsePartialPrMessage('{"title":"登录修复","body":"增加测')).toEqual({ title: '登录修复', body: '增加测' });
  });

  it('decodes complete escapes and waits for incomplete escapes', () => {
    expect(parsePartialPrMessage('{"title":"a\\n\\"b","body":"c\\u4e2d')).toEqual({ title: 'a\n"b', body: 'c' });
    expect(parsePartialPrMessage('{"title":"a","body":"c\\u4e2d\\u6587')).toEqual({ title: 'a', body: 'c中' });
  });

  it('waits for a complete surrogate pair before exposing it', () => {
    expect(parsePartialPrMessage('{"title":"A\\uD83D')).toEqual({ title: 'A', body: '' });
    expect(parsePartialPrMessage('{"title":"A\\uD83D\\uDE80')).toEqual({ title: 'A🚀', body: '' });
  });

  it('parses final JSON with optional Markdown fences', () => {
    expect(parseFinalPrMessage('```json\n{"title":"T","body":"B"}\n```')).toEqual({ title: 'T', body: 'B' });
    expect(parseFinalPrMessage('{"title":"T"}')).toEqual({ title: 'T', body: '' });
  });

  it('rejects invalid final JSON and a blank title', () => {
    expect(() => parseFinalPrMessage('{')).toThrow('AI 响应不是有效的 PR JSON');
    expect(() => parseFinalPrMessage('{"title":" ","body":"B"}')).toThrow('AI 未返回标题');
  });
});
```

- [ ] **Step 2: Run the parser tests and verify RED**

Run: `npm test -- src/lib/ai-stream.test.ts`

Expected: FAIL because `./ai-stream` does not exist.

- [ ] **Step 3: Implement incremental string decoding and final validation**

Create `src/lib/ai-stream.ts` with these exports:

```ts
import { aiChatCompletionsUrl, type AiConfig } from './ai';

export type PrMessage = { title: string; body: string };

function decodeJsonStringPrefix(source: string, start: number) {
  let value = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') return value;
    if (char !== '\\') {
      value += char;
      continue;
    }
    if (index + 1 >= source.length) return value;
    const escape = source[++index];
    const simple: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    };
    if (escape !== 'u') {
      if (escape in simple) value += simple[escape];
      continue;
    }
    const firstHex = source.slice(index + 1, index + 5);
    if (!/^[0-9a-f]{4}$/i.test(firstHex)) return value;
    const first = Number.parseInt(firstHex, 16);
    index += 4;
    if (first >= 0xd800 && first <= 0xdbff) {
      const secondEscape = source.slice(index + 1, index + 7);
      if (!/^\\u[0-9a-f]{4}$/i.test(secondEscape)) return value;
      const second = Number.parseInt(secondEscape.slice(2), 16);
      if (second < 0xdc00 || second > 0xdfff) return value;
      value += String.fromCodePoint(0x10000 + (first - 0xd800) * 0x400 + second - 0xdc00);
      index += 6;
    } else {
      value += String.fromCharCode(first);
    }
  }
  return value;
}

function fieldPrefix(source: string, field: 'title' | 'body') {
  const match = new RegExp(`(?:^|[,{]\\s*)"${field}"\\s*:\\s*"`).exec(source);
  return match ? decodeJsonStringPrefix(source, match.index + match[0].length) : '';
}

export function parsePartialPrMessage(source: string): PrMessage {
  return { title: fieldPrefix(source, 'title'), body: fieldPrefix(source, 'body') };
}

export function parseFinalPrMessage(source: string): PrMessage {
  const unfenced = source.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error('AI 响应不是有效的 PR JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 响应不是有效的 PR JSON');
  const message = parsed as Record<string, unknown>;
  const { title, body } = message;
  if (typeof title !== 'string' || !title.trim()) throw new Error('AI 未返回标题');
  if (body !== undefined && typeof body !== 'string') throw new Error('AI 响应不是有效的 PR JSON');
  return { title, body: body || '' };
}
```

Leave the imported endpoint/config symbols in place for Task 3, where the request function is added.

- [ ] **Step 4: Run the parser tests and verify GREEN**

Run: `npm test -- src/lib/ai-stream.test.ts`

Expected: 5 tests PASS. Task 3 runs the production build after the streaming API is added.

- [ ] **Step 5: Commit the incremental parser**

```bash
git add src/lib/ai-stream.ts src/lib/ai-stream.test.ts
git commit -m "feat(ai): parse incremental PR JSON"
```

### Task 3: OpenAI-Compatible SSE Streaming

**Files:**
- Modify: `src/lib/ai-stream.test.ts`
- Modify: `src/lib/ai-stream.ts`
- Modify: `src/lib/ai.ts`

- [ ] **Step 1: Add failing tests for request shape, arbitrary chunks, UTF-8, SSE framing, errors, and aborts**

Append to `src/lib/ai-stream.test.ts`:

```ts
import { streamPrMessage } from './ai-stream';

const config = { baseUrl: 'https://api.example.com/v1/', apiKey: 'secret', model: 'model-1' };

function byteResponse(bytes: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      bytes.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('PR message SSE stream', () => {
  it('posts stream:true and reports growing title/body across arbitrary chunks', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"登"}}]}\n\n',
      'data:{"choices":[{"delta":{"content":"录\\",\\"body\\":\\"描"}}]}\n\n',
      ': keepalive\n\ndata: {"choices":[{"delta":{}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"述\\"}"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const encoded = new TextEncoder().encode(sse);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => byteResponse([
      encoded.slice(0, 17), encoded.slice(17, 61), encoded.slice(61),
    ]));
    const updates: { title: string; body: string }[] = [];
    const result = await streamPrMessage(config, 'prompt', {
      fetcher,
      onUpdate: update => updates.push(update),
    });
    expect(result).toEqual({ title: '登录', body: '描述' });
    expect(updates).toContainEqual({ title: '登', body: '' });
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'model-1', stream: true });
  });

  it('preserves a Chinese character split between binary chunks and accepts multiple data lines', async () => {
    const event = 'data: {"choices":[{"delta":\n'
      + 'data: {"content":"{\\"title\\":\\"中文\\"}"}}]}\n\n'
      + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(event);
    const chineseByte = bytes.indexOf(0xe4);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => byteResponse([
      bytes.slice(0, chineseByte + 1), bytes.slice(chineseByte + 1),
    ]));
    await expect(streamPrMessage(config, 'prompt', { fetcher, onUpdate: vi.fn() }))
      .resolves.toEqual({ title: '中文', body: '' });
  });

  it('rejects HTTP failures, missing bodies, non-SSE responses, and malformed event JSON', async () => {
    await expect(streamPrMessage(config, 'p', {
      fetcher: async () => new Response('', { status: 429 }), onUpdate: vi.fn(),
    })).rejects.toThrow('AI 请求失败 (429)');
    await expect(streamPrMessage(config, 'p', {
      fetcher: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }), onUpdate: vi.fn(),
    })).rejects.toThrow('当前模型服务不支持流式生成');
    await expect(streamPrMessage(config, 'p', {
      fetcher: async () => new Response(null, { headers: { 'Content-Type': 'text/event-stream' } }), onUpdate: vi.fn(),
    })).rejects.toThrow('AI 流式响应没有内容');
    await expect(streamPrMessage(config, 'p', {
      fetcher: async () => byteResponse([new TextEncoder().encode('data: nope\n\n')]), onUpdate: vi.fn(),
    })).rejects.toThrow('AI 流式响应格式错误');
    await expect(streamPrMessage(config, 'p', {
      fetcher: async () => { throw new Error('offline'); }, onUpdate: vi.fn(),
    })).rejects.toThrow('offline');
  });

  it('passes the abort signal to fetch and preserves AbortError', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException('Aborted', 'AbortError');
    });
    controller.abort();
    await expect(streamPrMessage(config, 'p', { fetcher, signal: controller.signal, onUpdate: vi.fn() }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
```

- [ ] **Step 2: Run the stream tests and verify RED**

Run: `npm test -- src/lib/ai-stream.test.ts`

Expected: FAIL because `streamPrMessage` is not exported.

- [ ] **Step 3: Implement the SSE event iterator and streaming request**

Append to `src/lib/ai-stream.ts`:

```ts
type StreamOptions = {
  onUpdate: (message: PrMessage) => void;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
};

function eventData(frame: string) {
  const lines = frame.split(/\r?\n/);
  const values = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''));
  return values.length ? values.join('\n') : null;
}

async function* readSseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const data = eventData(frame);
        if (data !== null) yield data;
      }
      if (done) break;
    }
    const tail = eventData(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export async function streamPrMessage(
  config: AiConfig,
  prompt: string,
  options: StreamOptions,
): Promise<PrMessage> {
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(aiChatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      stream: true,
    }),
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`AI 请求失败 (${response.status})`);
  if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')) {
    throw new Error('当前模型服务不支持流式生成');
  }
  if (!response.body) throw new Error('AI 流式响应没有内容');

  let content = '';
  let last = { title: '', body: '' };
  for await (const data of readSseData(response.body)) {
    if (data === '[DONE]') break;
    let event: { choices?: { delta?: { content?: string } }[] };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      throw new Error('AI 流式响应格式错误');
    }
    const delta = event.choices?.[0]?.delta?.content;
    if (typeof delta !== 'string' || !delta) continue;
    content += delta;
    const next = parsePartialPrMessage(content);
    if (next.title !== last.title || next.body !== last.body) {
      last = next;
      options.onUpdate({ ...next });
    }
  }
  const final = parseFinalPrMessage(content);
  if (final.title !== last.title || final.body !== last.body) options.onUpdate({ ...final });
  return final;
}
```

In `src/lib/ai.ts`, delete the obsolete `generatePrMessage` function. Keep `AiConfig`, `aiChatCompletionsUrl`, `testAiConnection`, and `buildPrPrompt` unchanged.

- [ ] **Step 4: Run focused tests and the production build**

Run: `npm test -- src/lib/ai-stream.test.ts src/lib/ai.test.ts`

Expected: all AI parser, stream, prompt, and connection URL tests PASS.

Run: `npm run build`

Expected: TypeScript and Vite build PASS. Do not add or commit `dist/`.

- [ ] **Step 5: Commit the streaming client**

```bash
git add src/lib/ai-stream.ts src/lib/ai-stream.test.ts src/lib/ai.ts
git commit -m "feat(ai): stream PR title and description"
```

### Task 4: Draft Persistence in the Create-PR Dialog

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add draft imports and initialize cleaned storage state**

Replace the `generatePrMessage` import, add the draft imports, and initialize state near `GENERATION_RULES_KEY`:

```ts
import { buildPrPrompt, testAiConnection, type AiConfig } from './lib/ai';
import { streamPrMessage } from './lib/ai-stream';
import {
  deletePullRequestDraft,
  findPullRequestDraft,
  loadPullRequestDrafts,
  upsertPullRequestDraft,
  type PullRequestDraftIdentity,
} from './lib/pr-drafts';

const GENERATION_RULES_KEY = 'pr-helper-generation-rules';
const PULL_REQUEST_DRAFTS_KEY = 'pr-helper-pr-drafts';
let pullRequestDrafts = loadPullRequestDrafts(
  () => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY),
  Date.now(),
);
```

Immediately after state initialization, persist the cleaned list so startup removes expired and over-capacity entries:

```ts
try {
  localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(pullRequestDrafts));
} catch {
  window.setTimeout(() => showToast('草稿保存失败'), 0);
}
```

- [ ] **Step 2: Add safe persistence and explicit delete helpers**

Add beside `persistGenerationRules`:

```ts
function persistPullRequestDrafts(next: typeof pullRequestDrafts) {
  pullRequestDrafts = next;
  try {
    localStorage.setItem(PULL_REQUEST_DRAFTS_KEY, JSON.stringify(next));
    return true;
  } catch {
    showToast('草稿保存失败');
    return false;
  }
}

function removePullRequestDraft(identity: PullRequestDraftIdentity) {
  persistPullRequestDrafts(deletePullRequestDraft(pullRequestDrafts, identity));
}
```

- [ ] **Step 3: Restore the current draft when the dialog opens**

At the start of `showCreateDialog`, derive identity, clean expired records again, and choose restored values without refreshing `updatedAt`:

```ts
const identity = {
  repository: active.repository,
  source: stage.source,
  target: stage.target,
};
pullRequestDrafts = loadPullRequestDrafts(
  () => localStorage.getItem(PULL_REQUEST_DRAFTS_KEY),
  Date.now(),
);
persistPullRequestDrafts(pullRequestDrafts);
const restored = findPullRequestDraft(pullRequestDrafts, identity);
const initialTitle = restored ? restored.title : `${stage.source} → ${stage.target}`;
const initialBody = restored?.body || '';
```

Use `initialTitle` and `initialBody` in the escaped input and textarea HTML. The presence check must be `restored ? ... : ...`, not a truthiness check on `restored.title`, because an intentionally cleared empty draft must restore as empty.

- [ ] **Step 4: Debounce manual edits and expose a synchronous flush**

After querying `#create-title` and `#create-body`, add dialog-local save state:

```ts
const titleInput = dialog.querySelector<HTMLInputElement>('#create-title')!;
const bodyInput = dialog.querySelector<HTMLTextAreaElement>('#create-body')!;
let saveTimer: number | undefined;
let draftDirty = false;

const flushDraft = () => {
  if (!draftDirty) return;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = undefined;
  draftDirty = false;
  persistPullRequestDrafts(upsertPullRequestDraft(
    pullRequestDrafts,
    identity,
    { title: titleInput.value, body: bodyInput.value },
    Date.now(),
  ));
};

const scheduleDraftSave = (delay = 300, restartTimer = true) => {
  draftDirty = true;
  if (saveTimer !== undefined) {
    if (!restartTimer) return;
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(flushDraft, delay);
};

titleInput.addEventListener('input', () => scheduleDraftSave());
bodyInput.addEventListener('input', () => scheduleDraftSave());
```

In the dialog `close` listener, call `flushDraft()` before removing the dialog. This preserves manual changes on Cancel, Escape, and programmatic close.

- [ ] **Step 5: Delete only after successful GitHub PR creation**

In the existing `#confirm-create` success path, place deletion after `await githubFetch(...)` and before `dialog.close()`:

```ts
await githubFetch(token, `/repos/${owner}/${name}/pulls`, {
  method: 'POST',
  body: JSON.stringify(pullRequestPayload(title, stage.source, stage.target, body)),
});
draftDirty = false;
if (saveTimer !== undefined) window.clearTimeout(saveTimer);
removePullRequestDraft(identity);
dialog.close();
await refreshStatuses();
```

Do not delete the draft in the catch branch or generic close handler.

- [ ] **Step 6: Run static and regression checks**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run build`

Expected: build PASS. Do not add or commit `dist/`.

- [ ] **Step 7: Commit draft integration**

```bash
git add src/main.ts
git commit -m "feat(ui): persist create-PR drafts"
```

### Task 5: Overwrite Confirmation, Streaming UI, and Cancellation

**Files:**
- Modify: `src/main.ts`
- Modify: `src/style.css`

- [ ] **Step 1: Replace the non-streaming click handler with config-first overwrite confirmation**

Inside `showCreateDialog`, create one dialog-local controller and closed flag:

```ts
let generationController: AbortController | null = null;
let dialogClosed = false;
const generateButton = dialog.querySelector<HTMLButtonElement>('#generate-ai')!;
```

Replace the old `#generate-ai` handler with this sequence:

```ts
generateButton.addEventListener('click', async () => {
  if (!aiConfig?.baseUrl || !aiConfig.apiKey || !aiConfig.model) {
    showAiSettings();
    return;
  }
  if ((titleInput.value || bodyInput.value)
    && !window.confirm('AI 生成会覆盖当前标题和描述，是否继续？')) return;

  titleInput.value = '';
  bodyInput.value = '';
  scheduleDraftSave(0);
  flushDraft();

  const controller = new AbortController();
  generationController = controller;
  titleInput.disabled = true;
  bodyInput.disabled = true;
  generateButton.disabled = true;
  generateButton.textContent = '生成中…';

  try {
    const { owner, name } = parseRepository(identity.repository);
    const comparison = await githubFetch<{ commits: { commit: { message: string } }[] }>(
      token,
      `/repos/${owner}/${name}/compare/${encodeURIComponent(stage.target)}...${encodeURIComponent(stage.source)}`,
      { signal: controller.signal },
    );
    await streamPrMessage(
      aiConfig,
      buildPrPrompt(
        stage.source,
        stage.target,
        comparison.commits.map(item => item.commit.message),
        selectedGenerationRule()?.content,
      ),
      {
        signal: controller.signal,
        onUpdate: generated => {
          if (dialogClosed) return;
          titleInput.value = generated.title;
          bodyInput.value = generated.body;
          scheduleDraftSave(100, false);
        },
      },
    );
    flushDraft();
  } catch (error) {
    flushDraft();
    if (!(error instanceof Error && error.name === 'AbortError')) {
      showToast(error instanceof Error ? error.message : 'AI 生成失败');
    }
  } finally {
    if (generationController === controller) generationController = null;
    if (!dialogClosed) {
      titleInput.disabled = false;
      bodyInput.disabled = false;
      generateButton.disabled = false;
      generateButton.textContent = 'AI 生成';
    }
  }
});
```

This ordering intentionally validates configuration before confirmation and clearing. It also saves the confirmed blank overwrite before either the GitHub compare request or model request can fail.

- [ ] **Step 2: Abort on every dialog close and reject late updates**

Replace the dialog close listener with:

```ts
dialog.addEventListener('close', () => {
  dialogClosed = true;
  generationController?.abort();
  flushDraft();
  dialog.remove();
});
```

Keep partial streamed content in the draft. Do not restore pre-confirmation content and do not show an error toast for the close-triggered `AbortError`.

- [ ] **Step 3: Add visible disabled states**

Append to the create-dialog styles in `src/style.css`:

```css
.create-dialog input:disabled,
.create-dialog textarea:disabled,
.create-dialog button:disabled {
  cursor: not-allowed;
  opacity: .62;
}
```

- [ ] **Step 4: Run automated verification**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run lint`

Expected: the production static build PASS. Do not add or commit `dist/`.

- [ ] **Step 5: Perform browser acceptance checks with synthetic delayed SSE**

Run: `npm run dev`

In the browser, use a local OpenAI-compatible delayed SSE endpoint or intercept `fetch` in the browser test harness. Verify all of the following:

1. A title and body typed manually return after Cancel and reopening the same repository/source/target dialog.
2. A different target branch does not restore that draft.
3. Reloading the page restores the draft within 24 hours.
4. Clicking AI generation with existing content shows exactly one overwrite confirmation; Cancel preserves content.
5. Confirming clears both fields immediately, then delayed SSE chunks visibly grow title and body.
6. Closing mid-stream aborts without an error toast; reopening restores the partial output.
7. A malformed SSE event or invalid final JSON shows an error while preserving partial output.
8. A JSON (non-SSE) response shows “当前模型服务不支持流式生成” and does not retry non-streaming.
9. Failed GitHub PR creation preserves the draft; successful creation removes it.
10. With no selected generation rule and with the default/non-default rule selected, streaming works and the chosen rule remains in the prompt.
11. Injecting an expired draft and more than 50 valid drafts removes expired/oldest records on the next startup or dialog open.
12. Blocking `localStorage.setItem` shows “草稿保存失败” while the current form remains editable and can still submit a PR.

Expected: all twelve checks pass.

- [ ] **Step 6: Commit UI streaming integration**

```bash
git add src/main.ts src/style.css
git commit -m "feat(ui): stream AI output into PR drafts"
```

### Task 6: Final Regression and Scope Audit

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run the complete unit suite**

Run: `npm test`

Expected: all tests PASS, including draft TTL/capacity and streaming chunk/error cases.

- [ ] **Step 2: Run the production static check**

Run: `npm run lint`

Expected: Vite production build PASS.

- [ ] **Step 3: Confirm repository hygiene**

Run: `git status --short`

Expected: no uncommitted source changes; `dist/` and `node_modules/` are not staged or committed.

Run: `git log --oneline -5`

Expected: the five feature commits from Tasks 1–5 appear in order, followed by earlier project history.

- [ ] **Step 4: Compare implementation against the approved design**

Read: `docs/superpowers/specs/2026-07-23-streaming-pr-drafts-design.md`

Expected: implementation covers real SSE streaming, incremental JSON, confirmation, 24-hour TTL, 50-item cap, repository/source/target isolation, partial-result retention, close cancellation, storage failure tolerance, and deletion only after successful PR creation; it adds no Supabase, background sync, history, or non-streaming fallback.
