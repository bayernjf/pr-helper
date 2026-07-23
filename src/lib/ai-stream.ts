export type PrMessage = { title: string; body: string };

const invalidJsonMessage = 'AI 响应不是有效的 PR JSON';
const missingTitleMessage = 'AI 未返回标题';

type StringBounds = { end: number; complete: boolean };

function skipWhitespace(source: string, index: number) {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function findStringEnd(source: string, start: number): StringBounds {
  let index = start;

  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '"') return { end: index, complete: true };
    index += 1;
  }

  return { end: source.length, complete: false };
}

function decodePartialJsonString(source: string) {
  let value = '';
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }

    if (index + 1 >= source.length) break;
    const escape = source[index + 1];
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escape in simpleEscapes) {
      value += simpleEscapes[escape];
      index += 2;
      continue;
    }

    if (escape !== 'u' || index + 6 > source.length) break;
    const hex = source.slice(index + 2, index + 6);
    if (!/^[\da-fA-F]{4}$/.test(hex)) break;

    const codeUnit = Number.parseInt(hex, 16);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextEscape = index + 6;
      if (nextEscape >= source.length || (source[nextEscape] === '\\' && nextEscape + 1 >= source.length)) break;
      if (source.slice(nextEscape, nextEscape + 2) === '\\u') {
        if (nextEscape + 6 > source.length) break;
        const lowHex = source.slice(nextEscape + 2, nextEscape + 6);
        if (/^[\da-fA-F]{4}$/.test(lowHex)) {
          const lowSurrogate = Number.parseInt(lowHex, 16);
          if (lowSurrogate >= 0xdc00 && lowSurrogate <= 0xdfff) {
            value += String.fromCodePoint(0x10000 + (codeUnit - 0xd800) * 0x400 + lowSurrogate - 0xdc00);
            index += 12;
            continue;
          }
        }
      }
      value += '\ufffd';
      index += 6;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      value += '\ufffd';
      index += 6;
      continue;
    }
    value += String.fromCharCode(codeUnit);
    index += 6;
  }

  return value;
}

function parseCompleteJsonString(source: string) {
  try {
    return JSON.parse(`"${source}"`) as string;
  } catch {
    return '';
  }
}

function skipJsonValue(source: string, start: number) {
  const first = source[start];
  if (first === '"') {
    const string = findStringEnd(source, start + 1);
    return string.complete ? string.end + 1 : undefined;
  }

  if (first === '{' || first === '[') {
    const stack = [first];
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '"') {
        const string = findStringEnd(source, index + 1);
        if (!string.complete) return undefined;
        index = string.end + 1;
        continue;
      }
      if (source[index] === '{' || source[index] === '[') stack.push(source[index]);
      if (source[index] === '}' || source[index] === ']') {
        const opener = stack.pop();
        if ((source[index] === '}' && opener !== '{') || (source[index] === ']' && opener !== '[')) return undefined;
        if (stack.length === 0) return index + 1;
      }
      index += 1;
    }
    return undefined;
  }

  let index = start;
  while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
  return index > start ? index : undefined;
}

export function parsePartialPrMessage(source: string): PrMessage {
  const message: PrMessage = { title: '', body: '' };
  source = source.replace(/^\s*```json\b[ \t]*(?:\r?\n)?/i, '');
  let index = skipWhitespace(source, 0);
  if (source[index] !== '{') return message;
  index += 1;

  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source[index] === '}') return message;
    if (source[index] !== '"') return message;

    const key = findStringEnd(source, index + 1);
    if (!key.complete) return message;
    const property = parseCompleteJsonString(source.slice(index + 1, key.end));
    index = skipWhitespace(source, key.end + 1);
    if (source[index] !== ':') return message;
    index = skipWhitespace(source, index + 1);

    if (source[index] === '"') {
      const value = findStringEnd(source, index + 1);
      if (property === 'title' || property === 'body') {
        message[property] = decodePartialJsonString(source.slice(index + 1, value.end));
      }
      if (!value.complete) return message;
      index = value.end + 1;
    } else {
      const valueEnd = skipJsonValue(source, index);
      if (valueEnd === undefined) return message;
      index = valueEnd;
    }

    index = skipWhitespace(source, index);
    if (source[index] === ',') {
      index += 1;
      continue;
    }
    if (source[index] === '}') return message;
    return message;
  }

  return message;
}

export function parseFinalPrMessage(source: string): PrMessage {
  let jsonSource = source.trim();
  if (/^```json\b/i.test(jsonSource)) {
    jsonSource = jsonSource.replace(/^```json[ \t]*(?:\r?\n)?/i, '').replace(/(?:\r?\n)?```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSource);
  } catch {
    throw new Error(invalidJsonMessage);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(invalidJsonMessage);
  }

  const message = parsed as Record<string, unknown>;
  if (typeof message.title !== 'string' || message.title.trim() === '') {
    throw new Error(missingTitleMessage);
  }
  if ('body' in message && typeof message.body !== 'string') {
    throw new Error(invalidJsonMessage);
  }

  return { title: message.title, body: (message.body as string | undefined) ?? '' };
}
