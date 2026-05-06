import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidStepResolve } from '../../src/runner/steps/resolve_utils';

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
