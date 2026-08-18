import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function body(name: string) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start));
}

describe('route mode editing', () => {
  // Adding a route to an existing flow pre-checked the independent box, so a step became independent by
  // accident, and there was no way back: deleting and re-adding it mints a new stageId and drops that
  // step's status, event and deployment history.
  it('leaves the independent box unchecked when a route is added', () => {
    expect(source).toContain('<input id="independent-route" type="checkbox" />');
  });

  it('offers an edit entry on every step that has a step before it', () => {
    expect(body('renderDraft')).toContain("index > 0 ? `<button type=\"button\" data-edit-route=\"${index}\">");
    expect(body('bindDraftActions')).toContain('stageRouteEditIndex = Number(button.dataset.editRoute)');
  });

  // The server rejects a save whose waitFor points at the step itself or a later one, so the picker must
  // not offer them in the first place.
  it('offers only earlier steps as dependencies', () => {
    expect(body('renderStageRouteForm')).toContain('flow.stages.slice(0, stageIndex)');
  });

  // Source and target decide which branches the persisted stage state belongs to. Editing them in place
  // would silently move that history, so the first version edits the gate only.
  it('keeps source and target out of the route editor', () => {
    const form = body('renderStageRouteForm');
    expect(form).not.toContain('id="source"');
    expect(form).not.toContain('id="target"');
  });

  it('saves through the exclusive three-way mode rather than writing the fields itself', () => {
    const form = body('renderStageRouteForm');
    expect(form).toContain('save(setStageRouteMode(flow, stageIndex, mode))');
    expect(form).toContain("kind: 'independent'");
    expect(form).toContain("kind: 'wait-for'");
    expect(form).toContain("kind: 'sequential'");
  });

  // An empty waitFor is refused by the domain helper, which would leave the click doing nothing at all.
  it('refuses to submit a wait-for mode with nothing selected', () => {
    expect(body('renderStageRouteForm')).toContain("editor.routeMode.waitForEmpty");
  });
});
