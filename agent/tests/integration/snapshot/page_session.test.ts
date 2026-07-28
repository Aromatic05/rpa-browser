import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PageSnapshotSessionStore,
    buildControlSnapshot,
    buildSemanticLayer,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildTableSnapshot,
    type EntityRuleQueryBinding,
    type EntityRuleQueryExecutionResult,
    type EntityRulesExecutionResult,
    type ObservationIdentity,
    type RawCapturedNode,
    type RawPageCapture,
    type SemanticAnnotationRecord,
} from '../../../src/snapshot';

const active = () => ({hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true});

const node = (
    captureId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
    backendNodeId?: string,
): RawCapturedNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes: tag === 'button' ? {id: captureId, type: 'button'} : {},
    ownText: tag === 'button' ? 'Save' : undefined,
    backendNodeId,
    activity: active(),
});

const snapshotBundle = (
    identity: ObservationIdentity,
    buttons: Array<{captureId: string; backendNodeId: string}>,
) => {
    const completeness = {dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete'} as const;
    const raw: RawPageCapture = {
        identity,
        metadata: {schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z'},
        completeness,
        scopes: [{id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness}],
        nodes: [
            node('html', 'html', undefined, ['body']),
            node('body', 'body', 'html', buttons.map((button) => button.captureId)),
            ...buttons.map((button) => node(button.captureId, 'button', 'body', [], button.backendNodeId)),
        ],
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const control = buildControlSnapshot({observation, relations, locators});
    return {
        control,
        form: buildFormSnapshot({observation, relations, locators, controls: control.controls}),
        table: buildTableSnapshot({observation, relations, locators, controls: control.controls}),
    };
};


const entityRulesResult = (
    profileName: string,
    inputs: Array<{
        ruleId: string;
        nodeId: string;
        annotation: SemanticAnnotationRecord;
    }>,
): EntityRulesExecutionResult => {
    const queryBindings: EntityRuleQueryBinding[] = inputs.map(({ruleId, nodeId}) => ({
        planStepId: `${profileName}:${ruleId}`,
        ruleId,
        domain: 'form',
        source: 'node',
        expect: 'unique',
        targetKind: 'node',
        matchedComponentIds: [],
        matchedNodeIds: [nodeId],
        matchedFieldIds: [],
        matchedActionIds: [],
        matchedRowIds: [],
        matchedColumnIds: [],
        cardinality: {expected: 'unique', actual: 1, status: 'satisfied'},
        ok: true,
    }));
    const execution: EntityRuleQueryExecutionResult = {
        planId: profileName,
        profileName,
        domain: 'form',
        purpose: 'runtime',
        byRuleId: Object.fromEntries(queryBindings.map((binding) => [binding.ruleId, binding])),
        diagnostics: [],
        ok: true,
    };
    const semantic = buildSemanticLayer({
        execution,
        annotations: inputs.map((input) => input.annotation),
        snapshots: {},
    });
    return {
        status: 'ready',
        selection: 'explicit',
        selectedProfiles: [profileName],
        strict: true,
        profiles: {
            [profileName]: {
                profileName,
                domain: 'form',
                bindings: {},
                semanticBindings: semantic.bindings,
                semanticSuggestions: semantic.suggestions,
                diagnostics: semantic.bindings.diagnostics,
                ok: true,
            },
        },
        diagnostics: [],
        ok: true,
    };
};

test('page session separates missing, dirty, explicit and navigation refreshes while reusing clean state', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    let captureCount = 0;
    const captures = [
        snapshotBundle({pageEpoch: 'epoch-a', captureRevision: 1}, [{captureId: 'save-a1', backendNodeId: 'save'}]),
        snapshotBundle({pageEpoch: 'epoch-a', captureRevision: 2}, [{captureId: 'save-a2', backendNodeId: 'save'}]),
        snapshotBundle({pageEpoch: 'epoch-a', captureRevision: 3}, [{captureId: 'save-a3', backendNodeId: 'save'}]),
        snapshotBundle({pageEpoch: 'epoch-b', captureRevision: 1}, [{captureId: 'save-b1', backendNodeId: 'save'}]),
    ];
    const capture = async () => captures[captureCount++];

    const initial = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    assert.equal(initial.refreshReason, 'missing-snapshot');
    assert.equal(captureCount, 1);

    const reused = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    assert.equal(reused, initial);
    assert.equal(captureCount, 1);

    store.markDirty(pageKey, 'interaction');
    const dirty = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    assert.equal(dirty.refreshReason, 'dirty-interaction');
    assert.equal(dirty.identity.captureRevision, 2);

    const explicit = await store.ensureFresh({pageKey, pageUrl: '/orders', reason: 'explicit', capture});
    assert.equal(explicit.refreshReason, 'explicit');
    assert.equal(explicit.identity.captureRevision, 3);

    const navigation = await store.ensureFresh({pageKey, pageUrl: '/orders/2', capture});
    assert.equal(navigation.refreshReason, 'navigation');
    assert.equal(navigation.identity.pageEpoch, 'epoch-b');
    assert.equal(captureCount, 4);
});

test('page session coalesces concurrent refreshes into one capture', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    let captureCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const capture = async () => {
        captureCount += 1;
        await gate;
        return snapshotBundle(
            {pageEpoch: 'epoch-concurrent', captureRevision: 1},
            [{captureId: 'save', backendNodeId: 'save'}],
        );
    };

    const first = store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    const second = store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    await Promise.resolve();
    assert.equal(captureCount, 1);
    release?.();
    const [firstEntry, secondEntry] = await Promise.all([first, second]);
    assert.equal(firstEntry, secondEntry);
});

test('page session remaps anchors only by exact identity within one epoch', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const captures = [
        snapshotBundle({pageEpoch: 'epoch-a', captureRevision: 1}, [{captureId: 'save-a1', backendNodeId: 'save'}]),
        snapshotBundle({pageEpoch: 'epoch-a', captureRevision: 2}, [{captureId: 'save-a2', backendNodeId: 'save'}]),
        snapshotBundle({pageEpoch: 'epoch-b', captureRevision: 1}, [{captureId: 'save-b1', backendNodeId: 'save'}]),
    ];
    let captureIndex = 0;
    const capture = async () => captures[captureIndex++];

    const first = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    const firstNodeId = first.capture.control.observation.captureIdToNodeId['save-a1'];
    const anchor = store.createAnchor(pageKey, firstNodeId);
    assert.ok(anchor);

    store.markDirty(pageKey, 'interaction');
    const second = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    const secondNodeId = second.capture.control.observation.captureIdToNodeId['save-a2'];
    const remapped = store.resolveAnchor(pageKey, anchor);
    assert.equal(remapped.status, 'resolved');
    if (remapped.status !== 'resolved') {throw new Error('anchor did not resolve');}
    assert.equal(remapped.nodeId, secondNodeId);
    assert.equal(remapped.evidence[0]?.code, 'anchor.backend-node-id.exact');

    await store.ensureFresh({pageKey, pageUrl: '/orders/2', capture});
    assert.equal(store.resolveAnchor(pageKey, anchor).status, 'stale');
});

test('page session preserves dirty events raised while a refresh is in flight', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    let captureCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const captures = [
        snapshotBundle({pageEpoch: 'epoch-dirty', captureRevision: 1}, [{captureId: 'save-1', backendNodeId: 'save'}]),
        snapshotBundle({pageEpoch: 'epoch-dirty', captureRevision: 2}, [{captureId: 'save-2', backendNodeId: 'save'}]),
    ];
    const capture = async () => {
        const current = captures[captureCount++];
        if (captureCount === 1) {await gate;}
        return current;
    };

    const refreshing = store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    await Promise.resolve();
    store.markDirty(pageKey, 'interaction');
    release?.();
    await refreshing;

    assert.deepEqual(store.readFreshness(pageKey, '/orders'), {
        status: 'dirty',
        refreshReason: 'dirty-interaction',
    });
    const recaptured = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    assert.equal(recaptured.identity.captureRevision, 2);
    assert.equal(captureCount, 2);
});

test('page session reports ambiguous exact anchor identity instead of choosing the first node', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const captures = [
        snapshotBundle({pageEpoch: 'epoch-ambiguous', captureRevision: 1}, [
            {captureId: 'save-original', backendNodeId: 'save'},
        ]),
        snapshotBundle({pageEpoch: 'epoch-ambiguous', captureRevision: 2}, [
            {captureId: 'save-copy-a', backendNodeId: 'save'},
            {captureId: 'save-copy-b', backendNodeId: 'save'},
        ]),
    ];
    let captureIndex = 0;
    const capture = async () => captures[captureIndex++];

    const first = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    const anchor = store.createAnchor(
        pageKey,
        first.capture.control.observation.captureIdToNodeId['save-original'],
    );
    assert.ok(anchor);

    store.markDirty(pageKey, 'interaction');
    await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    const resolution = store.resolveAnchor(pageKey, anchor);
    assert.equal(resolution.status, 'ambiguous');
    if (resolution.status !== 'ambiguous') {throw new Error('anchor did not become ambiguous');}
    assert.equal(resolution.candidateNodeIds.length, 2);
});

test('page session recaptures when navigation arrives during an in-flight refresh', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    let captureCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const captureOldPage = async () => {
        captureCount += 1;
        await gate;
        return snapshotBundle(
            {pageEpoch: 'epoch-old', captureRevision: 1},
            [{captureId: 'save-old', backendNodeId: 'save'}],
        );
    };
    const captureNewPage = async () => {
        captureCount += 1;
        return snapshotBundle(
            {pageEpoch: 'epoch-new', captureRevision: 1},
            [{captureId: 'save-new', backendNodeId: 'save'}],
        );
    };

    const oldPage = store.ensureFresh({pageKey, pageUrl: '/orders', capture: captureOldPage});
    const newPage = store.ensureFresh({pageKey, pageUrl: '/orders/2', capture: captureNewPage});
    await Promise.resolve();
    assert.equal(captureCount, 1);
    release?.();

    const [oldEntry, newEntry] = await Promise.all([oldPage, newPage]);
    assert.equal(oldEntry.pageUrl, '/orders');
    assert.equal(newEntry.pageUrl, '/orders/2');
    assert.equal(newEntry.refreshReason, 'navigation');
    assert.equal(newEntry.identity.pageEpoch, 'epoch-new');
    assert.equal(captureCount, 2);
});

test('page session protects confirmed semantic targets and refreshes inferred targets', async () => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const firstBundle = snapshotBundle({pageEpoch: 'epoch-semantic', captureRevision: 1}, [
        {captureId: 'confirmed-old', backendNodeId: 'confirmed-old'},
        {captureId: 'inferred-old', backendNodeId: 'inferred-old'},
    ]);
    const secondBundle = snapshotBundle({pageEpoch: 'epoch-semantic', captureRevision: 2}, [
        {captureId: 'prefix', backendNodeId: 'prefix'},
        {captureId: 'confirmed-new', backendNodeId: 'confirmed-new'},
        {captureId: 'inferred-new', backendNodeId: 'inferred-new'},
    ]);
    const confirmedOld = firstBundle.control.observation.captureIdToNodeId['confirmed-old'];
    const inferredOld = firstBundle.control.observation.captureIdToNodeId['inferred-old'];
    const confirmedNew = secondBundle.control.observation.captureIdToNodeId['confirmed-new'];
    const inferredNew = secondBundle.control.observation.captureIdToNodeId['inferred-new'];
    assert.notEqual(confirmedOld, confirmedNew);
    assert.notEqual(inferredOld, inferredNew);
    const captures = [
        {
            ...firstBundle,
            entityRules: entityRulesResult('lifecycle', [
                {
                    ruleId: 'confirmed',
                    nodeId: confirmedOld,
                    annotation: {ruleId: 'confirmed', origin: 'confirmed', fieldKey: 'orderId'},
                },
                {
                    ruleId: 'inferred',
                    nodeId: inferredOld,
                    annotation: {ruleId: 'inferred', origin: 'inferred', businessTag: 'order.hint'},
                },
            ]),
        },
        {
            ...secondBundle,
            entityRules: entityRulesResult('lifecycle', [
                {
                    ruleId: 'confirmed',
                    nodeId: confirmedNew,
                    annotation: {ruleId: 'confirmed', origin: 'confirmed', fieldKey: 'orderId'},
                },
                {
                    ruleId: 'inferred',
                    nodeId: inferredNew,
                    annotation: {ruleId: 'inferred', origin: 'inferred', businessTag: 'order.hint'},
                },
            ]),
        },
    ];
    let captureIndex = 0;
    const capture = async () => captures[captureIndex++];

    await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    store.markDirty(pageKey, 'interaction');
    const refreshed = await store.ensureFresh({pageKey, pageUrl: '/orders', capture});
    const bindings = refreshed.semanticBindingsByProfile.lifecycle;

    assert.equal(bindings.byId['lifecycle:confirmed'].status, 'invalidated');
    assert.deepEqual(bindings.byId['lifecycle:confirmed'].target.nodeIds, [confirmedOld]);
    assert.equal(bindings.byId['lifecycle:inferred'].status, 'active');
    assert.deepEqual(bindings.byId['lifecycle:inferred'].target.nodeIds, [inferredNew]);
});
