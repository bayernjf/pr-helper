import { describe, expect, it } from 'vitest';
import { parseFinalPrMessage, parsePartialPrMessage } from './ai-stream';

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
