import test from 'node:test';
import assert from 'node:assert/strict';
import {
    candidatesForPurpose,
    selectInner,
    selectOuter,
    chooseCandidate,
    defaultCandidateIndex,
    isConfirmableEntityCandidate,
} from '../picking/candidate_navigation.js';
import type { PickCandidate } from '../types.js';

const makeChain = (): PickCandidate[] => [
    {level: 'control', nodeId: 'n1', score: 70, actionIntent: 'submit'},
    {level: 'field', nodeId: 'n2', score: 80},
    {level: 'row', nodeId: 'n3', score: 60},
    {level: 'group', nodeId: 'n4', score: 90},
    {level: 'region', nodeId: 'n5', score: 100},
];

test('selectOuter moves toward region (higher index)', () => {
    const chain = makeChain();
    assert.equal(selectOuter(chain, 0), 1);
    assert.equal(selectOuter(chain, 1), 2);
    assert.equal(selectOuter(chain, 2), 3);
});

test('selectOuter saturates at outermost index', () => {
    const chain = makeChain();
    const last = chain.length - 1;
    assert.equal(selectOuter(chain, last), last);
});

test('selectInner moves toward control (lower index)', () => {
    const chain = makeChain();
    assert.equal(selectInner(chain, 3), 2);
    assert.equal(selectInner(chain, 2), 1);
    assert.equal(selectInner(chain, 1), 0);
});

test('selectInner saturates at innermost index', () => {
    const chain = makeChain();
    assert.equal(selectInner(chain, 0), 0);
});

test('selectOuter and selectInner are inverse on a mid-chain index', () => {
    const chain = makeChain();
    const outer = selectOuter(chain, 2);
    assert.equal(selectInner(chain, outer), 2);
});

test('selectOuter on empty chain returns -1', () => {
    assert.equal(selectOuter([], 0), -1);
});

test('selectInner on empty chain returns -1', () => {
    assert.equal(selectInner([], 0), -1);
});

test('selectOuter clamps negative current index to 0', () => {
    const chain = makeChain();
    assert.equal(selectOuter(chain, -5), 0);
});

test('selectInner clamps out-of-range current index to last', () => {
    const chain = makeChain();
    assert.equal(selectInner(chain, 99), chain.length - 1);
});

test('chooseCandidate returns the candidate at the given index', () => {
    const chain = makeChain();
    const chosen = chooseCandidate(chain, 1);
    assert.equal(chosen?.nodeId, 'n2');
    assert.equal(chosen?.level, 'field');
});

test('chooseCandidate returns null for out-of-range index', () => {
    const chain = makeChain();
    assert.equal(chooseCandidate(chain, -1), null);
    assert.equal(chooseCandidate(chain, chain.length), null);
    assert.equal(chooseCandidate([], 0), null);
});

test('navigation stays within candidate chain and never exposes raw DOM nodes', () => {
    const chain = makeChain();
    let index = 0;
    for (let step = 0; step < 20; step += 1) {
        index = selectOuter(chain, index);
    }
    assert.ok(index >= 0 && index < chain.length);
    const chosen = chooseCandidate(chain, index);
    assert.ok(chosen !== null);
    assert.equal(chosen.level, 'region');
});

test('entity candidates exclude outer ranges that cannot be persisted', () => {
    const valid: PickCandidate = {
        level: 'region',
        nodeId: 'valid-region',
        score: 50,
        entityRef: {entityId: 'form-1', nodeId: 'valid-region', kind: 'form', type: 'region'},
        proposedTargets: [{css: '#order-form'}],
    };
    const invalidOuter: PickCandidate = {
        level: 'region',
        nodeId: 'invalid-outer',
        score: 40,
        proposedTargets: [{css: 'body'}],
    };
    const filtered = candidatesForPurpose([valid, invalidOuter], 'entity');
    assert.deepEqual(filtered, [valid]);
    assert.equal(defaultCandidateIndex(filtered, 'entity'), 0);
    assert.equal(isConfirmableEntityCandidate(filtered[0]), true);
});

test('entity candidate requires a non-empty persistent target', () => {
    const candidate: PickCandidate = {
        level: 'region',
        nodeId: 'region-without-target',
        score: 10,
        entityRef: {entityId: 'table-1', nodeId: 'region-without-target', kind: 'table', type: 'region'},
        proposedTargets: [{}],
    };
    assert.equal(isConfirmableEntityCandidate(candidate), false);
    assert.deepEqual(candidatesForPurpose([candidate], 'entity'), []);
    assert.equal(defaultCandidateIndex([], 'entity'), -1);
});
