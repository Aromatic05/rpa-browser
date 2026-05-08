import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResolveFromSnapshotCandidate } from '../../src/runner/steps/resolve_builder';

const snapshot = {
    locatorIndex: {
        row_1: {
            origin: { primaryDomId: 'dom-1' },
            direct: { kind: 'css', query: 'table tr:nth-of-type(1) input', source: 'path' },
        },
    },
    attrIndex: {
        row_1: { tag: 'input', class: 'ant-input' },
    },
    bboxIndex: {
        row_1: { x: 1, y: 2, width: 3, height: 4 },
    },
} as any;

test('record_enrichment keeps raw selector as highest priority', () => {
    const resolve = buildResolveFromSnapshotCandidate({
        snapshot,
        candidate: {
            nodeId: 'row_1',
            selector: 'table tr:nth-of-type(1) input',
            role: 'textbox',
            confidence: 0.9,
            reason: ['direct_selector_exact_match'],
        },
        rawSelector: 'table tr:nth-of-type(5) input',
        source: 'record_enrichment',
    });

    assert.equal(resolve.hint?.raw?.selector, 'table tr:nth-of-type(5) input');
    assert.equal(resolve.hint?.locator?.direct?.query, 'table tr:nth-of-type(5) input');
    assert.equal(
        (resolve.hint?.raw?.locatorCandidates || []).some((item) => item.kind === 'css' && item.selector === 'table tr:nth-of-type(5) input'),
        false,
    );
});

test('record_enrichment LOW_CONFIDENCE_RAW_ONLY excludes strong target fields', () => {
    const resolve = buildResolveFromSnapshotCandidate({
        snapshot,
        candidate: {
            nodeId: 'row_1',
            role: 'textbox',
            confidence: 0.4,
            reason: ['raw_selector_only'],
        },
        rawSelector: 'table tr:nth-of-type(5) input',
        source: 'record_enrichment',
        warnings: ['LOW_CONFIDENCE_RAW_ONLY'],
    });

    assert.equal(resolve.hint?.target?.nodeId, undefined);
    assert.equal(resolve.hint?.target?.primaryDomId, undefined);
    assert.equal(resolve.hint?.locator?.origin?.primaryDomId, undefined);
    assert.equal(resolve.hint?.raw?.selector, 'table tr:nth-of-type(5) input');
});

test('capture_resolve drops duplicated css when rawSelector equals snapshot direct selector', () => {
    const resolve = buildResolveFromSnapshotCandidate({
        snapshot,
        candidate: {
            nodeId: 'row_1',
            confidence: 0.9,
            reason: ['direct_selector_exact_match'],
        },
        rawSelector: 'table tr:nth-of-type(1) input',
        source: 'capture_resolve',
    });
    const candidates = resolve.hint?.raw?.locatorCandidates || [];
    assert.equal(candidates.filter((item) => item.kind === 'css').length, 0);
});

test('capture_resolve keeps different selectors as candidates', () => {
    const resolve = buildResolveFromSnapshotCandidate({
        snapshot,
        candidate: {
            nodeId: 'row_1',
            selector: 'table tr:nth-of-type(5) input',
            confidence: 0.9,
            reason: ['mixed_sources'],
        },
        rawSelector: 'table tr:nth-of-type(5) input',
        source: 'capture_resolve',
    });
    const candidates = resolve.hint?.raw?.locatorCandidates || [];
    assert.equal(candidates.some((item) => item.kind === 'css' && item.selector === 'table tr:nth-of-type(5) input'), false);
    assert.equal(resolve.hint?.locator?.direct?.query, 'table tr:nth-of-type(1) input');
    assert.equal(resolve.hint?.raw?.selector, 'table tr:nth-of-type(5) input');
});
