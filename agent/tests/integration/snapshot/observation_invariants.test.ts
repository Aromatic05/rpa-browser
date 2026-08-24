import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzePageObservation,
    buildPageObservation,
    validateObservationAnalysis,
    type PageObservation,
    type RawPageCapture,
    type RelationIndex,
} from '../../../src/automation/snapshot';

test('validator rejects broken scope forests and cross-scope DOM parent links', () => {
    const valid = buildPageObservation(baseCapture());
    const malformed = structuredClone(valid) as PageObservation;
    malformed.scopes.scopes.shadow.parentScopeId = 'missing-scope';
    (malformed.parents as Record<string, string | undefined>)[malformed.captureIdToNodeId['shadow-root']] = malformed.captureIdToNodeId.body;

    const result = validateObservationAnalysis({
        observation: malformed,
        relations: { edges: [], bySourceNodeId: {}, byTargetNodeId: {}, diagnostics: [] },
        candidates: [],
        quotients: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === 'invariant.scope.parent-missing'), true);
    assert.equal(result.diagnostics.some((item) => item.code === 'invariant.parent-child.scope-crossing'), true);
});

test('validator checks relation indexes and quotient scope/candidate consistency', () => {
    const analysis = analyzePageObservation(buildPageObservation(baseCapture()));
    const relation = analysis.relations.edges[0];
    assert.ok(relation);
    const malformedRelations: RelationIndex = {
        ...analysis.relations,
        bySourceNodeId: {},
        byTargetNodeId: {},
    };
    const malformedQuotient = {
        ...analysis.quotients[0],
        scopeId: 'shadow',
    };
    const result = validateObservationAnalysis({
        observation: analysis.observation,
        relations: malformedRelations,
        candidates: analysis.candidates,
        quotients: [malformedQuotient],
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((item) => item.code === 'invariant.relation.source-index-missing'), true);
    assert.equal(result.diagnostics.some((item) => item.code === 'invariant.quotient.scope-mismatch'), true);
});

const baseCapture = (): RawPageCapture => ({
    identity: { pageEpoch: 'invariant', captureRevision: 1 },
    metadata: { schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-28T00:00:00.000Z' },
    completeness: { dom: 'complete', a11y: 'unavailable', runtime: 'unavailable', geometry: 'complete' },
    scopes: [
        { id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured' },
        { id: 'shadow', kind: 'open-shadow-root', parentScopeId: 'main', hostCaptureId: 'host', rootCaptureId: 'shadow-root', status: 'captured' },
    ],
    nodes: [
        rawNode('html', 'main', 'html', undefined, ['body']),
        rawNode('body', 'main', 'body', 'html', ['controller', 'target', 'host']),
        { ...rawNode('controller', 'main', 'button', 'body', []), attributes: { 'aria-controls': 'target' } },
        { ...rawNode('target', 'main', 'div', 'body', []), attributes: { id: 'target', role: 'dialog' } },
        rawNode('host', 'main', 'div', 'body', []),
        rawNode('shadow-root', 'shadow', '#shadow-root', undefined, []),
    ],
    accessibility: [],
    runtimeState: {},
    diagnostics: [],
});

const rawNode = (
    captureId: string,
    scopeId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
) => ({
    captureId,
    scopeId,
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes: {},
    geometry: { x: 0, y: 0, width: 10, height: 10 },
    activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
});
