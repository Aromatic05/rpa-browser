import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidStepResolve, normalizeResolveHint } from '../../src/runner/steps/resolve_utils';

test('isValidStepResolve handles empty and policy-only resolve as invalid', () => {
    assert.equal(isValidStepResolve(undefined), false);
    assert.equal(isValidStepResolve({}), false);
    assert.equal(isValidStepResolve({ policy: { requireVisible: true } }), false);
    assert.equal(isValidStepResolve({ hint: {} }), false);
});

test('isValidStepResolve recognizes fallback and locator candidates', () => {
    assert.equal(
        isValidStepResolve({ hint: { locator: { direct: { kind: 'css', query: '', fallback: '#ok' } } } }),
        true,
    );
    assert.equal(
        isValidStepResolve({ hint: { raw: { locatorCandidates: [{ kind: 'role', role: 'link', name: '下一页 使用' }] } } }),
        true,
    );
});

test('normalizeResolveHint removes css candidate duplicated with raw.selector and keeps others', () => {
    const out = normalizeResolveHint({
        raw: {
            selector: 'div.row:nth-of-type(5) input',
            locatorCandidates: [
                { kind: 'css', selector: 'div.row:nth-of-type(5) input' },
                { kind: 'css', selector: 'div.row:nth-of-type(1) input' },
                { kind: 'testid', testId: 'name-input' },
                { kind: 'label', text: 'Name' },
                { kind: 'placeholder', text: 'Search...' },
                { kind: 'role', role: 'textbox', name: 'Name' },
                { kind: 'text', text: 'Name' },
                { kind: 'attr', selector: '[name=\"buyer\"]' },
                { kind: 'css', selector: 'div.row:nth-of-type(1) input' },
                { kind: 'css', selector: ' ' },
            ],
        },
    });
    const candidates = out?.raw?.locatorCandidates || [];
    assert.equal(candidates.some((item) => item.kind === 'css' && item.selector === 'div.row:nth-of-type(5) input'), false);
    assert.equal(candidates.some((item) => item.kind === 'css' && item.selector === 'div.row:nth-of-type(1) input'), true);
    assert.equal(candidates.some((item) => item.kind === 'testid' && item.testId === 'name-input'), true);
    assert.equal(candidates.some((item) => item.kind === 'label' && item.text === 'Name'), true);
    assert.equal(candidates.some((item) => item.kind === 'placeholder' && item.text === 'Search...'), true);
    assert.equal(candidates.some((item) => item.kind === 'role' && item.role === 'textbox'), true);
    assert.equal(candidates.some((item) => item.kind === 'text' && item.text === 'Name'), true);
    assert.equal(candidates.some((item) => item.kind === 'attr' && item.selector === '[name=\"buyer\"]'), true);
    assert.equal(candidates.filter((item) => item.kind === 'css' && item.selector === 'div.row:nth-of-type(1) input').length, 1);
});
