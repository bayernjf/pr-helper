import { describe, expect, it, vi } from 'vitest';
import { parseFinalPrMessage, parsePartialPrMessage, streamPrMessage } from './ai-stream';
import type { AiConfig } from './ai';

describe('parsePartialPrMessage', () => {
  it('returns growing title and body prefixes from incomplete JSON', () => {
    expect(parsePartialPrMessage('{"title":"起草')).toEqual({ title: '起草', body: '' });
    expect(parsePartialPrMessage('{"title":"起草 PR","body":"第一段')).toEqual({ title: '起草 PR', body: '第一段' });
  });

  it('streams incomplete JSON after lowercase and mixed-case JSON fences', () => {
    expect(parsePartialPrMessage('```json\n{"title":"起草')).toEqual({ title: '起草', body: '' });
    expect(parsePartialPrMessage(' ```JsOn\n{"title":"起草","body":"第一段')).toEqual({ title: '起草', body: '第一段' });
  });

  it('decodes complete string escapes while waiting for an incomplete trailing escape', () => {
    const source = String.raw`{"title":"A\nB\tC\bD\fE\rF\/G\\H\"I","body":"等待` + '\\';

    expect(parsePartialPrMessage(source)).toEqual({
      title: 'A\nB\tC\bD\fE\rF/G\\H"I',
      body: '等待',
    });
  });

  it('waits for an incomplete Unicode escape before emitting it', () => {
    expect(parsePartialPrMessage(String.raw`{"title":"\u4F60\u59`)).toEqual({ title: '你', body: '' });
  });

  it('waits for a surrogate pair and emits its code point once complete', () => {
    expect(parsePartialPrMessage(String.raw`{"title":"\uD83D`)).toEqual({ title: '', body: '' });
    expect(parsePartialPrMessage(String.raw`{"title":"\uD83D\uDE80`)).toEqual({ title: '🚀', body: '' });
  });

  it('replaces a conclusively unmatched high surrogate and continues decoding', () => {
    expect(parsePartialPrMessage(String.raw`{"title":"A\uD83D\u0041B`)).toEqual({ title: 'A�AB', body: '' });
  });

  it('does not treat escaped key-like content inside a value as a top-level field', () => {
    const source = String.raw`{"title":"text: \"body\": \"not a field","body":"actual body`;

    expect(parsePartialPrMessage(source)).toEqual({
      title: 'text: "body": "not a field',
      body: 'actual body',
    });
  });

  it('uses the latest top-level fields after nested unknown values', () => {
    const source = '{"body":"first","unknown":{"items":["ignored",{"title":"also ignored"}]},"title":"first title","body":"latest body","title":"latest title"}';

    expect(parsePartialPrMessage(source)).toEqual({ title: 'latest title', body: 'latest body' });
  });
});

describe('parseFinalPrMessage', () => {
  it('accepts fenced JSON and an omitted body', () => {
    expect(parseFinalPrMessage(' \n```json\n{"title":"Fix login"}\n```\n')).toEqual({
      title: 'Fix login',
      body: '',
    });
  });

  it('accepts an uppercase JSON fence', () => {
    expect(parseFinalPrMessage('```JSON\n{"title":"Fix login"}\n```')).toEqual({
      title: 'Fix login',
      body: '',
    });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseFinalPrMessage('{"title":')).toThrow('AI 响应不是有效的 PR JSON');
  });

  it('rejects a non-object or a non-string body', () => {
    expect(() => parseFinalPrMessage('[]')).toThrow('AI 响应不是有效的 PR JSON');
    expect(() => parseFinalPrMessage('{"title":"Fix","body":false}')).toThrow('AI 响应不是有效的 PR JSON');
  });

  it('rejects a missing, blank, or non-string title', () => {
    expect(() => parseFinalPrMessage('{"body":"Details"}')).toThrow('AI 未返回标题');
    expect(() => parseFinalPrMessage('{"title":" \\n\\t "}')).toThrow('AI 未返回标题');
    expect(() => parseFinalPrMessage('{"title":42}')).toThrow('AI 未返回标题');
  });
});

const config: AiConfig = { baseUrl: 'https://api.example.com/v1/', apiKey: 'secret', model: 'model-1' };
const encoder = new TextEncoder();

function sseResponse(chunks: Uint8Array[], contentType = 'text/event-stream; charset=utf-8') {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    },
  }), { headers: { 'Content-Type': contentType } });
}

describe('streamPrMessage', () => {
  it('posts an OpenAI-compatible streaming request and reports changed partial messages', async () => {
    const source = [
      'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"登"}}]}\r\n\r\n',
      'data:{"choices":[{"delta":{"content":"录\\",\\"body\\":\\"描"}}]}\n\n',
      ': keepalive\n\n\n\ndata: {"choices":[{"delta":{}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"述\\"}"}}]}\n\ndata: [DONE]\n\n',
    ].join('');
    const bytes = encoder.encode(source);
    const fetcher = vi.fn(async () => sseResponse([bytes.slice(0, 13), bytes.slice(13, 71), bytes.slice(71)]));
    const updates: { title: string; body: string }[] = [];

    await expect(streamPrMessage(config, 'write this PR', { fetcher, onUpdate: update => updates.push(update) }))
      .resolves.toEqual({ title: '登录', body: '描述' });

    expect(fetcher).toHaveBeenCalledWith('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({
        model: 'model-1',
        messages: [{ role: 'user', content: 'write this PR' }],
        temperature: 0.2,
        stream: true,
      }),
      signal: undefined,
    });
    expect(updates).toEqual([
      { title: '登', body: '' },
      { title: '登录', body: '描' },
      { title: '登录', body: '描述' },
    ]);
  });

  it('decodes a Chinese character split between binary chunks', async () => {
    const source = 'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"中文\\"}"}}]}\n\ndata: [DONE]\n\n';
    const bytes = encoder.encode(source);
    const split = bytes.indexOf(0xe4) + 1;

    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([bytes.slice(0, split), bytes.slice(split)]),
      onUpdate: vi.fn(),
    })).resolves.toEqual({ title: '中文', body: '' });
  });

  it('joins multiple data lines in one SSE event', async () => {
    const source = 'data: {"choices":[{"delta":\n'
      + 'data: {"content":"{\\"title\\":\\"完整\\"}"}}]}\n\n'
      + 'data: [DONE]\n\n';

    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([encoder.encode(source)]),
      onUpdate: vi.fn(),
    })).resolves.toEqual({ title: '完整', body: '' });
  });

  it('recognizes LF and CRLF delimiters split between chunks with multiple events', async () => {
    const first = 'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"分"}}]}\n\n';
    const second = 'data: {"choices":[{"delta":{"content":"隔\\"}"}}]}\r\n\r\n';
    const done = 'data: [DONE]\r\n\r\n';

    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([
        encoder.encode(first.slice(0, -1)),
        encoder.encode(first.slice(-1) + second.slice(0, -1)),
        encoder.encode(second.slice(-1) + done),
      ]),
      onUpdate: vi.fn(),
    })).resolves.toEqual({ title: '分隔', body: '' });
  });

  it('recognizes lone CR and mixed line endings across chunk boundaries', async () => {
    const first = 'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"混"}}]}\r\r';
    const second = 'data: {"choices":[{"delta":{"content":"合\\"}"}}]}\r\n\n';
    const done = 'data: [DONE]\r\r';

    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([
        encoder.encode(first.slice(0, -1)),
        encoder.encode(first.slice(-1) + second.slice(0, -2)),
        encoder.encode(second.slice(-2) + done),
      ]),
      onUpdate: vi.fn(),
    })).resolves.toEqual({ title: '混合', body: '' });
  });

  it('rejects HTTP failures, non-streaming content types, and missing stream bodies', async () => {
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response('', { status: 429 }), onUpdate: vi.fn(),
    })).rejects.toThrow('AI 请求失败 (429)');
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response('{}', { headers: { 'content-type': 'Application/JSON; charset=utf-8' } }), onUpdate: vi.fn(),
    })).rejects.toThrow('当前模型服务不支持流式生成');
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response('{}', { headers: { 'Content-Type': 'text/event-streaming; charset=utf-8' } }), onUpdate: vi.fn(),
    })).rejects.toThrow('当前模型服务不支持流式生成');
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response(null, { headers: { 'Content-Type': 'TEXT/EVENT-STREAM' } }), onUpdate: vi.fn(),
    })).rejects.toThrow('AI 流式响应没有内容');
  });

  it('rejects malformed event JSON and ignores no-content deltas before the final parse', async () => {
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([encoder.encode('data: nope\n\n')]), onUpdate: vi.fn(),
    })).rejects.toThrow('AI 流式响应格式错误');

    const updates = vi.fn();
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([encoder.encode([
        'event: message\n',
        'id: 10\n',
        'data: null\n\n',
        'data: {"choices":[]}\n\n',
        'data: {"choices":[{"delta":{"content":""}}]}\n\n',
        'data: {"choices":[{"delta":{"content":42}}]}\n\n',
        'data: {"choices":[{"delta":{"content":null}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"OK\\"}"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''))]),
      onUpdate: updates,
    })).resolves.toEqual({ title: 'OK', body: '' });
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it('preserves final PR message parser errors', async () => {
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([encoder.encode(
        'data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n',
      )]),
      onUpdate: vi.fn(),
    })).rejects.toThrow('AI 未返回标题');
  });

  it('rejects a completed message when the stream ends without DONE', async () => {
    const updates = vi.fn();
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([encoder.encode(
        'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"未完成\\"}"}}]}\n\n',
      )]),
      onUpdate: updates,
    })).rejects.toThrow('AI 流式响应意外中断');
    expect(updates).toHaveBeenCalledWith({ title: '未完成', body: '' });
  });

  it('does not dispatch an unterminated data tail before rejecting a missing DONE', async () => {
    const updates = vi.fn();
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => sseResponse([encoder.encode(
        'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"保留\\",\\"body\\":\\""}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":"不应派发\\"}"}}]}',
      )]),
      onUpdate: updates,
    })).rejects.toThrow('AI 流式响应意外中断');
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenLastCalledWith({ title: '保留', body: '' });
  });

  it('propagates a mid-body AbortError without clearing partial updates', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"部分\\""}}]}\n\n',
          ));
          return;
        }
        controller.error(abortError);
      },
    });
    const updates = vi.fn();

    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
      onUpdate: updates,
    })).rejects.toBe(abortError);
    expect(updates).toHaveBeenLastCalledWith({ title: '部分', body: '' });
  });

  it('cancels bodies before reporting HTTP and content-type errors', async () => {
    let httpCancelled = false;
    const httpBody = new ReadableStream<Uint8Array>({ cancel: () => { httpCancelled = true; } });
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response(httpBody, { status: 429 }), onUpdate: vi.fn(),
    })).rejects.toThrow('AI 请求失败 (429)');
    expect(httpCancelled).toBe(true);

    let typeCancelled = false;
    const typeBody = new ReadableStream<Uint8Array>({ cancel: () => { typeCancelled = true; } });
    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response(typeBody, { headers: { 'Content-Type': 'application/json' } }), onUpdate: vi.fn(),
    })).rejects.toThrow('当前模型服务不支持流式生成');
    expect(typeCancelled).toBe(true);
  });

  it('cancels an unread reader after the DONE event', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"Done\\"}"}}]}\n\ndata: [DONE]\n\n',
        ));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(streamPrMessage(config, 'prompt', {
      fetcher: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
      onUpdate: vi.fn(),
    })).resolves.toEqual({ title: 'Done', body: '' });
    expect(cancelled).toBe(true);
  });

  it('passes the abort signal to fetch and preserves AbortError', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('Aborted', 'AbortError');
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw abortError;
    });
    controller.abort();

    await expect(streamPrMessage(config, 'prompt', { fetcher, signal: controller.signal, onUpdate: vi.fn() }))
      .rejects.toBe(abortError);
  });
});
