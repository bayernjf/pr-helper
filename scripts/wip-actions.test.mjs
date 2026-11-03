import { describe, expect, it } from 'vitest';

import {
  MAX_COMMIT_MESSAGE_LENGTH,
  buildCommitArgs,
  buildDiscardArgs,
  buildStageArgs,
  validateCommitMessage,
} from './wip-actions.mjs';

describe('validateCommitMessage', () => {
  it('accepts a normal message and trims surrounding whitespace', () => {
    expect(validateCommitMessage('  fix(wip): stage files  \n')).toEqual({ ok: true, message: 'fix(wip): stage files' });
  });

  it('rejects empty and whitespace-only messages', () => {
    for (const value of ['', '   ', '\n\t\n']) {
      expect(validateCommitMessage(value)).toEqual({ ok: false, error: 'commit message must not be empty' });
    }
  });

  it('rejects messages that start with a dash so git cannot read an option', () => {
    for (const value of ['-m evil', '--file=/etc/passwd', ' -x']) {
      expect(validateCommitMessage(value)).toEqual({ ok: false, error: 'commit message must not start with "-"' });
    }
  });

  it('rejects over-long messages and NUL bytes', () => {
    expect(validateCommitMessage('a'.repeat(MAX_COMMIT_MESSAGE_LENGTH + 1))).toEqual({
      ok: false,
      error: `commit message must be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters`,
    });
    expect(validateCommitMessage('a\0b')).toEqual({ ok: false, error: 'commit message must not contain NUL bytes' });
  });

  it('rejects non-string input', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(validateCommitMessage(value)).toEqual({ ok: false, error: 'commit message must be a string' });
    }
  });
});

describe('buildStageArgs', () => {
  it('uses fixed argv with a "--" separator for stage and unstage', () => {
    expect(buildStageArgs('stage', 'src/app.ts')).toEqual(['add', '--', 'src/app.ts']);
    expect(buildStageArgs('unstage', 'src/app.ts')).toEqual(['reset', '--', 'src/app.ts']);
  });

  it('rejects unknown actions', () => {
    for (const action of ['clean', 'reset', 'add', '', undefined]) {
      expect(() => buildStageArgs(action, 'src/app.ts')).toThrow(/unsupported stage action/);
    }
  });

  it('rejects paths that are absolute, traversing, dotted or NUL-bearing', () => {
    for (const rel of ['/etc/passwd', '../secret', 'a/../../b', './a', 'a//b', 'C:/x', 'a\0b', '']) {
      expect(() => buildStageArgs('stage', rel)).toThrow(/path must/);
    }
  });
});

describe('buildDiscardArgs', () => {
  it('restores exactly one file and never cleans directories', () => {
    expect(buildDiscardArgs('src/app.ts')).toEqual(['restore', '--', 'src/app.ts']);
    expect(() => buildDiscardArgs('/etc/passwd')).toThrow(/path must/);
    expect(() => buildDiscardArgs('../out')).toThrow(/path must/);
  });
});

describe('buildCommitArgs', () => {
  it('reads the message from stdin so it is never parsed as an option', () => {
    expect(buildCommitArgs()).toEqual(['commit', '-F', '-']);
  });
});
