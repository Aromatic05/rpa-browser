import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    analyzePageObservation,
    buildPageObservation,
    createObservationAnchor,
    loadObservationFixtures,
    replayObservationFixture,
    resolveLocatorScopePath,
    resolveObservationAnchor,
    runObservationReplayBenchmark,
    type CandidateClassification,
    type ObservationFixture,
    type RawPageCapture,
} from '../../../src/automation/snapshot';

const fixtureDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../fixtures/observation-v2',
);

const loadFixtures = async (): Promise<ObservationFixture[]> =>
    await loadObservationFixtures(fixtureDirectory);

test('versioned stage 1 corpus replays with frozen truth and invariant success', async () => {
    const fixtures = await loadFixtures();
    assert.equal(fixtures.length, 10);

    const observedClassifications = new Set<CandidateClassification>();
    for (const fixture of fixtures) {
        const analysis = replayObservationFixture(fixture);
        const report = runObservationReplayBenchmark([fixture], {
            iterations: 2,
            generatedAt: '2026-07-28T00:00:00.000Z',
        });
        const result = report.fixtures[0];

        assert.equal(analysis.validation.ok, true, fixture.id);
        assert.equal(result?.truthErrors.length, 0, `${fixture.id}: ${result?.truthErrors.join(', ')}`);
        assert.equal(analysis.report.quotient.orphanCount, 0, fixture.id);
        assert.equal(Object.isFrozen(analysis.observation), true, fixture.id);
        assert.equal(Object.isFrozen(analysis.relations), true, fixture.id);

        for (const candidate of analysis.candidates) {
            observedClassifications.add(candidate.classification);
        }
    }

    assert.deepEqual(
        [...observedClassifications].sort(),
        ['ambiguous', 'host', 'latent', 'part', 'rejected', 'structural'],
    );
});


test('real framework fixtures come from browser-rendered Element Plus and Ant Design components', async () => {
    const fixtures = await loadFixtures();
    const element = findFixture(fixtures, 'element-plus-browser');
    const ant = findFixture(fixtures, 'ant-design-browser');

    for (const fixture of [element, ant]) {
        assert.equal(fixture.source.kind, 'browser-capture');
        assert.ok(fixture.source.origin.startsWith('package://'));
        assert.ok(fixture.capture.nodes.length >= 80, fixture.id);
        assert.equal(fixture.capture.metadata.source, 'browser-live');
    }

    assert.equal(element.capture.nodes.some((node) =>
        (node.attributes.class ?? '').split(/\s+/).includes('el-table')), true);
    assert.ok(element.capture.nodes.filter((node) => node.tag === 'table').length >= 2);
    assert.equal(ant.capture.nodes.some((node) =>
        (node.attributes.class ?? '').split(/\s+/).includes('ant-table-wrapper')), true);
    assert.ok(ant.capture.nodes.filter((node) => node.tag === 'table').length >= 1);
});

test('partial and captured without candidate scopes preserve explicit state instead of fabricating facts', async () => {
    const fixtures = await loadFixtures();
    const partial = replayObservationFixture(findFixture(fixtures, 'partial-unavailable'));
    const capturedWithoutCandidate = replayObservationFixture(findFixture(fixtures, 'captured-without-candidate-zero-box'));

    assert.equal(partial.observation.completeness.a11y, 'unavailable');
    assert.equal(Object.values(partial.observation.accessibility).filter(Boolean).length, 0);
    assert.equal(
        Object.values(partial.observation.scopes.scopes)
            .some((scope) => scope.kind === 'iframe' && scope.status === 'unavailable'),
        true,
    );
    assert.equal(
        Object.values(capturedWithoutCandidate.observation.scopes.scopes)
            .some((scope) => scope.kind === 'iframe' && scope.status === 'captured'),
        true,
    );
    assert.equal(capturedWithoutCandidate.report.scope.capturedWithoutCandidateCount >= 1, true);

    const zeroNodeId = capturedWithoutCandidate.observation.captureIdToNodeId.zero;
    assert.equal(capturedWithoutCandidate.observation.activity[zeroNodeId].selfHasBox, false);
    assert.equal(capturedWithoutCandidate.observation.activity[zeroNodeId].subtreeActive, true);
});

test('scope transforms normalize 1x, 1.25x, 1.5x and 2x geometry into top CSS viewport', () => {
    for (const scale of [1, 1.25, 1.5, 2]) {
        const observation = buildPageObservation(frameCapture(scale));
        const nodeId = observation.captureIdToNodeId['frame-target'];
        const topGeometry = observation.geometry[nodeId].find((record) =>
            record.space === 'top-css-viewport');
        assert.deepEqual(topGeometry?.rect, {
            x: 100 + 20 * scale,
            y: 80 + 30 * scale,
            width: 40 * scale,
            height: 20 * scale,
        });
        const scopePath = resolveLocatorScopePath(observation, nodeId);
        assert.equal(scopePath.status, 'resolved');
        assert.deepEqual(
            scopePath.status === 'resolved' ? scopePath.value.map((step) => step.kind) : [],
            ['frame'],
        );
    }
});

test('observation analysis is immutable and exact anchors never degrade to heuristic remap', async () => {
    const fixtures = await loadFixtures();
    const fixture = findFixture(fixtures, 'native-form');
    const observation = buildPageObservation(fixture.capture);
    const before = JSON.stringify(observation);
    const analysis = analyzePageObservation(observation);
    const after = JSON.stringify(observation);
    assert.equal(after, before);
    assert.equal(analysis.validation.ok, true);

    const inputNodeId = observation.captureIdToNodeId.input;
    const anchor = createObservationAnchor(observation, inputNodeId);
    assert.ok(anchor);

    const sameEpochCapture = structuredClone(fixture.capture);
    sameEpochCapture.identity.captureRevision = 2;
    const sameEpochObservation = buildPageObservation(sameEpochCapture);
    assert.deepEqual(resolveObservationAnchor(anchor, sameEpochObservation), {
        status: 'resolved',
        nodeId: sameEpochObservation.captureIdToNodeId.input,
        evidence: [{
            code: 'anchor.backend-node-id.exact',
            strength: 'exact',
            source: 'platform',
            nodeIds: [sameEpochObservation.captureIdToNodeId.input],
            detail: undefined,
        }],
    });

    const newDocumentCapture = structuredClone(fixture.capture);
    newDocumentCapture.identity.pageEpoch = 'fixture:new-document';
    const newDocumentObservation = buildPageObservation(newDocumentCapture);
    assert.equal(resolveObservationAnchor(anchor, newDocumentObservation).status, 'stale');

    const ambiguousCapture = structuredClone(fixture.capture);
    ambiguousCapture.nodes.push({
        captureId: 'duplicate-input',
        scopeId: 'main',
        parentCaptureId: 'form',
        childCaptureIds: [],
        tag: 'input',
        attributes: {},
        backendNodeId: '105',
        activity: {
            hiddenByStyle: false,
            inert: false,
            selfHasBox: true,
            rendered: true,
        },
    });
    const formNode = ambiguousCapture.nodes.find((node) => node.captureId === 'form');
    formNode?.childCaptureIds.push('duplicate-input');
    const ambiguousObservation = buildPageObservation(ambiguousCapture);
    assert.equal(resolveObservationAnchor(anchor, ambiguousObservation).status, 'ambiguous');
});

test('candidate-local quotient retains relation endpoints outside the structural subtree', async () => {
    const fixtures = await loadFixtures();
    const analysis = replayObservationFixture(findFixture(fixtures, 'ant-select-activity'));
    const formHostId = analysis.observation.captureIdToNodeId.form;
    const popupId = analysis.observation.captureIdToNodeId.popup;
    const quotient = analysis.quotients.find((view) => view.candidateAnchorNodeId === formHostId);

    assert.ok(quotient);
    const popupProjection = quotient.nodes.find((node) => node.nodeId === popupId);
    assert.equal(popupProjection?.projectionParentId, formHostId);
});

const findFixture = (fixtures: readonly ObservationFixture[], id: string): ObservationFixture => {
    const fixture = fixtures.find((candidate) => candidate.id === id);
    assert.ok(fixture, `fixture ${id} not found`);
    return fixture;
};

const frameCapture = (scale: number): RawPageCapture => ({
    identity: { pageEpoch: `scale-${scale}`, captureRevision: 1 },
    metadata: {
        schemaVersion: 1,
        source: 'fixed-fixture',
        capturedAt: '2026-07-28T00:00:00.000Z',
    },
    completeness: {
        dom: 'complete',
        a11y: 'unavailable',
        runtime: 'unavailable',
        geometry: 'complete',
    },
    scopes: [
        { id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured' },
        {
            id: 'frame',
            kind: 'iframe',
            parentScopeId: 'main',
            hostCaptureId: 'frame-host',
            rootCaptureId: 'frame-html',
            status: 'captured',
            transformToParent: {
                scaleX: scale,
                scaleY: scale,
                translateX: 100,
                translateY: 80,
            },
        },
    ],
    nodes: [
        {
            captureId: 'html',
            scopeId: 'main',
            childCaptureIds: ['frame-host'],
            tag: 'html',
            attributes: {},
            activity: active(),
        },
        {
            captureId: 'frame-host',
            scopeId: 'main',
            parentCaptureId: 'html',
            childCaptureIds: [],
            tag: 'iframe',
            attributes: {},
            activity: active(),
        },
        {
            captureId: 'frame-html',
            scopeId: 'frame',
            childCaptureIds: ['frame-target'],
            tag: 'html',
            attributes: {},
            activity: active(),
        },
        {
            captureId: 'frame-target',
            scopeId: 'frame',
            parentCaptureId: 'frame-html',
            childCaptureIds: [],
            tag: 'button',
            attributes: {},
            geometry: { x: 20, y: 30, width: 40, height: 20 },
            activity: active(),
        },
    ],
    accessibility: [],
    runtimeState: {},
    diagnostics: [],
});

const active = () => ({
    hiddenByStyle: false,
    inert: false,
    selfHasBox: true,
    rendered: true,
});
