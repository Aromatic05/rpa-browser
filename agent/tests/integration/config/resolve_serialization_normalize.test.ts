import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import type { StepResolveFile } from '../../src/runner/serialization/types';
import { validateStepResolveFileForSerialization } from '../../src/runner/serialization/types';

test('step_resolve serialization accepts target.state and dedupes candidates', () => {
    const resolveFile = parse(`
version: 1
resolves:
  resolveBuyerField:
    hint:
      target:
        state:
          checked: false
          focused: true
          disabled: false
          readonly: true
          ariaChecked: "false"
          ariaSelected: "true"
          ariaExpanded: "false"
          ariaDisabled: "false"
      raw:
        selector: "#buyer-input"
        locatorCandidates:
          - kind: css
            selector: "#buyer-input-alt"
          - kind: css
            selector: "#buyer-input-alt"
`) as StepResolveFile;

    assert.doesNotThrow(() => validateStepResolveFileForSerialization(resolveFile));
    const candidates = resolveFile.resolves.resolveBuyerField?.hint?.raw?.locatorCandidates || [];
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.selector, '#buyer-input-alt');
});

test('step_resolve serialization rejects css candidate equal to raw.selector', () => {
    const resolveFile = parse(`
version: 1
resolves:
  resolveBuyerField:
    hint:
      raw:
        selector: "#buyer-input"
        locatorCandidates:
          - kind: css
            selector: "#buyer-input"
`) as StepResolveFile;

    assert.throws(
        () => validateStepResolveFileForSerialization(resolveFile),
        /raw\.selector must not be duplicated in raw\.locatorCandidates css/,
    );
});
