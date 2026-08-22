import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');

function block(selector: string) {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf('\n}', start));
}

function declaredNames(selector: string) {
  return new Set(Array.from(block(selector).matchAll(/^\s*(--[\w-]+):/gm), match => match[1]));
}

describe('theme tokens', () => {
  const light = declaredNames(':root');
  const dark = declaredNames(':root[data-theme="dark"]');

  // Dark mode works only by overriding these names, so a value that never resolves to one of them
  // silently keeps its light appearance.
  it('resolves every variable used in the stylesheet', () => {
    const used = new Set(Array.from(css.matchAll(/var\((--[\w-]+)/g), match => match[1]));
    expect([...used].filter(name => !light.has(name)).sort()).toEqual([]);
  });

  // A `var(--x, #fff)` fallback turns a misspelled token into a hardcoded light colour that no test and
  // no build step can see.
  it('never falls back to a literal colour', () => {
    expect(css).not.toMatch(/var\(--[\w-]+,\s*(#|rgb|hsl)/);
  });

  it('overrides every light token in the dark theme', () => {
    expect([...light].filter(name => !dark.has(name)).sort()).toEqual([]);
  });

  // A dialog does not inherit the page text colour: the UA sheet pins it to CanvasText, which stays black
  // under our own data-theme attribute. One base rule keeps every dialog, including future ones, readable.
  it('gives the dialog element a themed text colour', () => {
    expect(css.match(/\ndialog \{([^}]*)\}/)?.[1] || '').toMatch(/color:\s*var\(--text-primary\)/);
  });

  // A `--bg-*` token used as text colour carries an unstated pairing: it reads only because some other
  // token happens to sit behind it. The dark theme repaints both sides independently, which left `.primary`
  // dark green on mid green at 1.6:1. Text belongs to the `--text-*` vocabulary.
  it('never paints text with a background token', () => {
    expect(css.match(/(^|[;\s])color:\s*var\(--bg-[\w-]+\)/)).toBeNull();
  });

  // Two sibling buttons pinned to the same grid cell overlap, and the later one paints over the earlier.
  // The deployment gate row carried one button when its layout rule was written, so the edit button added
  // later shipped hidden underneath remove — same label width, same padding, no visible trace.
  it('gives each deployment row button its own grid column', () => {
    const columnFor = (kind: string) => css.match(new RegExp(`\\[data-${kind}-deployment\\]\\{[^}]*grid-column:\\s*(\\d+)`))?.[1];
    expect(columnFor('edit')).toBeDefined();
    expect(columnFor('remove')).toBeDefined();
    expect(columnFor('remove')).not.toBe(columnFor('edit'));
  });
});
