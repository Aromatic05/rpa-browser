import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzePageObservation,
    buildPageObservation,
    type RawPageCapture,
} from '../../../src/automation/snapshot';

const rawCapture = (): RawPageCapture => ({
    identity: {
        pageEpoch: 'epoch-fixture',
        captureRevision: 1,
    },
    metadata: {
        schemaVersion: 1,
        source: 'fixed-fixture',
        capturedAt: '2026-07-28T00:00:00.000Z',
        pageUrl: 'fixture://snapshot-v2-stage1',
        framework: 'native',
        frameworkVersion: 'html',
    },
    completeness: {
        dom: 'complete',
        a11y: 'complete',
        runtime: 'complete',
        geometry: 'complete',
    },
    scopes: [
        {
            id: 'scope-main',
            kind: 'document',
            rootCaptureId: 'main-html',
            status: 'captured',
        },
        {
            id: 'scope-shadow',
            kind: 'open-shadow-root',
            parentScopeId: 'scope-main',
            hostCaptureId: 'shadow-host',
            rootCaptureId: 'shadow-root',
            status: 'captured',
        },
    ],
    nodes: [
        {
            captureId: 'main-html',
            scopeId: 'scope-main',
            tag: 'html',
            childCaptureIds: ['main-body'],
            attributes: {},
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 0, y: 0, width: 1280, height: 720 },
        },
        {
            captureId: 'main-body',
            scopeId: 'scope-main',
            parentCaptureId: 'main-html',
            tag: 'body',
            childCaptureIds: ['controller', 'main-target', 'zero-wrapper', 'hidden-host', 'shadow-host'],
            attributes: {},
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 0, y: 0, width: 1280, height: 720 },
        },
        {
            captureId: 'controller',
            scopeId: 'scope-main',
            parentCaptureId: 'main-body',
            tag: 'button',
            childCaptureIds: [],
            attributes: {
                'aria-controls': 'shared-target',
                'aria-expanded': 'false',
                'data-rpa-state-id': 'state-controller',
            },
            ownText: 'Open',
            backendNodeId: '101',
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 10, y: 10, width: 80, height: 30 },
        },
        {
            captureId: 'main-target',
            scopeId: 'scope-main',
            parentCaptureId: 'main-body',
            tag: 'div',
            childCaptureIds: [],
            attributes: { id: 'shared-target', role: 'table' },
            backendNodeId: '102',
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 10, y: 50, width: 200, height: 100 },
        },
        {
            captureId: 'zero-wrapper',
            scopeId: 'scope-main',
            parentCaptureId: 'main-body',
            tag: 'div',
            childCaptureIds: ['zero-child'],
            attributes: {},
            activity: { hiddenByStyle: false, inert: false, selfHasBox: false, rendered: true },
            geometry: { x: 0, y: 0, width: 0, height: 0 },
        },
        {
            captureId: 'zero-child',
            scopeId: 'scope-main',
            parentCaptureId: 'zero-wrapper',
            tag: 'button',
            childCaptureIds: [],
            attributes: {},
            ownText: 'Visible child',
            backendNodeId: '103',
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 300, y: 20, width: 100, height: 30 },
        },
        {
            captureId: 'hidden-host',
            scopeId: 'scope-main',
            parentCaptureId: 'main-body',
            tag: 'form',
            childCaptureIds: ['hidden-child'],
            attributes: {},
            activity: { hiddenByStyle: true, inert: false, selfHasBox: false, rendered: false },
            geometry: { x: 0, y: 0, width: 0, height: 0 },
        },
        {
            captureId: 'hidden-child',
            scopeId: 'scope-main',
            parentCaptureId: 'hidden-host',
            tag: 'input',
            childCaptureIds: [],
            attributes: {},
            activity: { hiddenByStyle: true, inert: false, selfHasBox: false, rendered: false },
            geometry: { x: 0, y: 0, width: 0, height: 0 },
        },
        {
            captureId: 'shadow-host',
            scopeId: 'scope-main',
            parentCaptureId: 'main-body',
            tag: 'div',
            childCaptureIds: [],
            attributes: { id: 'shadow-host' },
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 500, y: 100, width: 300, height: 200 },
        },
        {
            captureId: 'shadow-root',
            scopeId: 'scope-shadow',
            tag: 'section',
            childCaptureIds: ['shadow-controller', 'shadow-target'],
            attributes: {},
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 0, y: 0, width: 300, height: 200 },
        },
        {
            captureId: 'shadow-controller',
            scopeId: 'scope-shadow',
            parentCaptureId: 'shadow-root',
            tag: 'button',
            childCaptureIds: [],
            attributes: { 'aria-controls': 'shared-target' },
            ownText: 'Shadow open',
            backendNodeId: '201',
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 10, y: 10, width: 80, height: 30 },
        },
        {
            captureId: 'shadow-target',
            scopeId: 'scope-shadow',
            parentCaptureId: 'shadow-root',
            tag: 'div',
            childCaptureIds: [],
            attributes: { id: 'shared-target', role: 'dialog' },
            backendNodeId: '202',
            activity: { hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true },
            geometry: { x: 10, y: 50, width: 150, height: 100 },
        },
    ],
    accessibility: [
        { axNodeId: 'ax-controller-a', backendNodeId: '101', role: 'button', name: 'Open A' },
        { axNodeId: 'ax-controller-b', backendNodeId: '101', role: 'switch', name: 'Open B' },
        { axNodeId: 'ax-main-target', backendNodeId: '102', role: 'table', name: 'Orders' },
        { axNodeId: 'ax-zero-child', backendNodeId: '103', role: 'button', name: 'Visible child' },
        { axNodeId: 'ax-shadow-controller', backendNodeId: '201', role: 'button', name: 'Shadow open' },
        { axNodeId: 'ax-shadow-target', backendNodeId: '202', role: 'dialog', name: 'Shadow dialog' },
    ],
    runtimeState: {
        'state-controller': {
            stateId: 'state-controller',
            ariaExpanded: 'false',
            focused: 'true',
        },
    },
    diagnostics: [],
});

test('buildPageObservation creates immutable canonical indexes and exact joins', () => {
    const observation = buildPageObservation(rawCapture());

    assert.equal(Object.isFrozen(observation), true);
    assert.equal(Object.isFrozen(observation.nodes), true);
    assert.equal(Object.keys(observation.nodes).length, 12);

    const controllerId = observation.captureIdToNodeId['controller'];
    const zeroWrapperId = observation.captureIdToNodeId['zero-wrapper'];
    const hiddenChildId = observation.captureIdToNodeId['hidden-child'];

    assert.ok(controllerId);
    assert.equal(observation.accessibility[controllerId], undefined);
    assert.equal(observation.runtimeState[controllerId]?.focused, 'true');
    assert.equal(observation.activity[zeroWrapperId].selfHasBox, false);
    assert.equal(observation.activity[zeroWrapperId].subtreeActive, true);
    assert.equal(observation.activity[hiddenChildId].subtreeActive, false);
    assert.equal(
        observation.diagnostics.some((item) => item.code === 'observation.join.a11y.ambiguous'),
        true,
    );

    const report = analyzePageObservation(observation).report;
    assert.equal(report.joins.a11yResolved, 4);
    assert.equal(report.joins.a11yAmbiguous, 1);
    assert.equal(report.joins.a11yMissing, 0);
    assert.equal(report.joins.runtimeResolved, 1);
    assert.equal(report.joins.runtimeAmbiguous, 0);
    assert.equal(report.joins.runtimeMissing, 0);
});

test('analysis resolves IDREF per scope, preserves activity truth, and builds candidate-local quotients', () => {
    const observation = buildPageObservation(rawCapture());
    const analysis = analyzePageObservation(observation);

    const mainControllerId = observation.captureIdToNodeId['controller'];
    const mainTargetId = observation.captureIdToNodeId['main-target'];
    const shadowControllerId = observation.captureIdToNodeId['shadow-controller'];
    const shadowTargetId = observation.captureIdToNodeId['shadow-target'];

    const mainControls = analysis.relations.edges.find(
        (edge) => edge.kind === 'controls-target' && edge.sourceNodeId === mainControllerId,
    );
    const shadowControls = analysis.relations.edges.find(
        (edge) => edge.kind === 'controls-target' && edge.sourceNodeId === shadowControllerId,
    );

    assert.deepEqual(mainControls?.targetNodeIds, [mainTargetId]);
    assert.deepEqual(shadowControls?.targetNodeIds, [shadowTargetId]);
    assert.equal(
        analysis.relations.edges.some(
            (edge) => edge.kind === 'popup-owner' && edge.sourceNodeId === mainControllerId,
        ),
        false,
        'table target must not be promoted to popup ownership',
    );
    assert.equal(
        analysis.relations.edges.some(
            (edge) => edge.kind === 'popup-owner' && edge.sourceNodeId === shadowControllerId,
        ),
        true,
        'dialog target may derive popup ownership',
    );
    assert.equal(
        analysis.diagnostics.some((item) => item.code === 'activity.controller-state-mismatch'),
        true,
    );

    const hiddenFormId = observation.captureIdToNodeId['hidden-host'];
    const hiddenCandidate = analysis.candidates.find((candidate) => candidate.anchorNodeId === hiddenFormId);
    assert.equal(hiddenCandidate?.classification, 'latent');

    assert.equal(analysis.validation.ok, true);
    assert.equal(analysis.report.quotient.orphanCount, 0);
    assert.ok(analysis.report.quotient.maxSize > 0);
    assert.ok(analysis.quotients.every((view) => view.candidateAnchorNodeId !== undefined));
});
