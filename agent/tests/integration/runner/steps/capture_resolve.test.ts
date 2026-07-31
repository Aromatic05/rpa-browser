import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildTableSnapshot,
    type PageSnapshotCapture,
    type RawCapturedNode,
    type RawPageCapture,
    type SemanticBusinessBinding,
    type SemanticBindings,
} from '../../../../src/snapshot';
import {executeBrowserCaptureResolve} from '../../../../src/runner/steps/executors/capture_resolve';
import type {Step} from '../../../../src/runner/steps/types';
import {completeRunStepsDeps} from '../../../helpers/run_steps_workspace';

const active = () => ({hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true});

const node = (
    captureId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
    attributes: Record<string, string> = {},
    ownText?: string,
): RawCapturedNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes,
    ownText,
    activity: active(),
});

const createCapture = (count = 1, repeatedText = 'Orders'): {
    capture: PageSnapshotCapture;
    nodeIds: string[];
} => {
    const completeness = {dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete'} as const;
    const buttonIds = Array.from({length: count}, (_, index) => `button-${index + 1}`);
    const raw: RawPageCapture = {
        identity: {pageEpoch: 'capture-resolve', captureRevision: 1},
        metadata: {schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z'},
        completeness,
        scopes: [{id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness}],
        nodes: [
            node('html', 'html', undefined, ['body']),
            node('body', 'body', 'html', buttonIds),
            ...buttonIds.map((captureId, index) => node(
                captureId,
                'button',
                'body',
                [],
                {id: `target-${index + 1}`},
                repeatedText,
            )),
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
        capture: {
            control,
            form: buildFormSnapshot({observation, relations, locators, controls: control.controls}),
            table: buildTableSnapshot({observation, relations, locators, controls: control.controls}),
        },
        nodeIds: buttonIds.map((captureId) => observation.captureIdToNodeId[captureId]),
    };
};

const createDeps = async (count = 1, repeatedText = 'Orders', semanticBusinessTag?: string) => {
    const page = {};
    const deps = completeRunStepsDeps({pluginHost: {} as never}, {
        workspaceName: 'ws-1',
        tabName: 'tk-1',
        page,
    });
    const fixture = createCapture(count, repeatedText);
    const capture = semanticBusinessTag
        ? withSemanticBinding(fixture.capture, fixture.nodeIds[0], semanticBusinessTag)
        : fixture.capture;
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: 'about:blank',
        capture: async () => capture,
    });
    return {deps, ...fixture};
};

const withSemanticBinding = (
    capture: PageSnapshotCapture,
    nodeId: string,
    businessTag: string,
): PageSnapshotCapture => {
    const binding: SemanticBusinessBinding = {
        id: 'orders:submit',
        profileName: 'orders',
        ruleId: 'submit',
        planStepId: 'orders:submit',
        domain: 'form',
        targetKind: 'node',
        origin: 'confirmed',
        disposition: 'active',
        status: 'active',
        annotation: {ruleId: 'submit', origin: 'confirmed', businessTag},
        target: {
            componentIds: [],
            nodeIds: [nodeId],
            fieldIds: [],
            actionIds: [],
            rowIds: [],
            columnIds: [],
        },
    };
    const semanticBindings: SemanticBindings = {
        byId: {[binding.id]: binding},
        forms: {},
        tables: {},
        nodes: {[nodeId]: [binding]},
        fields: {},
        actions: {},
        rows: {},
        columns: {},
        diagnostics: [],
    };
    return {
        ...capture,
        entityRules: {
            status: 'ready',
            selection: 'explicit',
            selectedProfiles: ['orders'],
            strict: true,
            profiles: {
                orders: {
                    profileName: 'orders',
                    domain: 'form',
                    bindings: {},
                    semanticBindings,
                    semanticSuggestions: {items: [], diagnostics: []},
                    diagnostics: [],
                    ok: true,
                },
            },
            diagnostics: [],
            ok: true,
        },
    };
};

test('capture_resolve rejects missing target inputs', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-empty',
        name: 'browser.capture_resolve',
        args: {},
    };
    const {deps} = await createDeps();
    const result = await executeBrowserCaptureResolve(step, deps, 'ws-1');
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error?.code, 'ERR_BAD_ARGS');
});

test('capture_resolve returns a V2 canonical resolve draft for one selector hit', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-selector',
        name: 'browser.capture_resolve',
        args: {selector: '#target-1'},
    };
    const {deps, nodeIds} = await createDeps();
    const result = await executeBrowserCaptureResolve(step, deps, 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    const data = result.data as any;
    assert.equal(data.resolve?.hint?.target?.nodeId, nodeIds[0]);
    assert.equal(data.resolve?.hint?.locator?.direct?.query, '[id="target-1"]');
    assert.equal(data.confidence, 0.95);
});

test('capture_resolve returns ambiguous V2 candidates for repeated text and uses default limit', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-text',
        name: 'browser.capture_resolve',
        args: {text: 'Orders'},
    };
    const {deps} = await createDeps(6, 'Orders');
    const result = await executeBrowserCaptureResolve(step, deps, 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    const data = result.data as any;
    assert.equal(data.candidates.length, 5);
    assert.equal(data.warnings.includes('AMBIGUOUS_TARGET'), true);
});

test('capture_resolve resolves entity hints from active SemanticBindings without overlays', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-entity',
        name: 'browser.capture_resolve',
        args: {},
        resolve: {hint: {entity: {businessTag: 'orders.submit'}}},
    };
    const {deps, nodeIds} = await createDeps(1, 'Submit', 'orders.submit');
    const result = await executeBrowserCaptureResolve(step, deps, 'ws-1');
    assert.equal(result.ok, true);
    if (!result.ok) {return;}
    const data = result.data as any;
    assert.equal(data.resolve?.hint?.target?.nodeId, nodeIds[0]);
    assert.equal(data.candidates.length, 1);
});

test('capture_resolve returns ERR_NOT_FOUND when no canonical node matches', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-none',
        name: 'browser.capture_resolve',
        args: {name: 'Missing target'},
    };
    const {deps} = await createDeps();
    const result = await executeBrowserCaptureResolve(step, deps, 'ws-1');
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
    assert.deepEqual(result.error?.details, {
        workspaceName: 'ws-1',
        pageEpoch: 'capture-resolve',
        captureRevision: 1,
        scopeIds: ['main'],
        activeNodeCount: 3,
        candidateCount: 0,
        query: {name: 'Missing target'},
    });
});



test('capture_resolve preserves the complete semantic resolve hint in not-found diagnostics', async () => {
    const step: Step<'browser.capture_resolve'> = {
        id: 'capture-semantic-none',
        name: 'browser.capture_resolve',
        args: {},
        resolve: {
            hint: {
                entity: {businessTag: 'orders.missing', actionIntent: 'approve'},
                target: {role: 'button', name: 'Approve'},
                locator: {direct: {kind: 'css', query: '#missing-approve'}},
            },
            policy: {preferDirect: true, requireVisible: true},
        },
    };
    const {deps} = await createDeps();
    const result = await executeBrowserCaptureResolve(step, deps, 'ws-1');
    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error?.code, 'ERR_NOT_FOUND');
    assert.deepEqual((result.error?.details as {query?: unknown})?.query, {
        resolve: step.resolve,
    });
});

test('capture_resolve accepts limit up to 20 and rejects larger values', async () => {
    const withinLimit: Step<'browser.capture_resolve'> = {
        id: 'capture-limit-ok',
        name: 'browser.capture_resolve',
        args: {role: 'button', limit: 20},
    };
    const overLimit: Step<'browser.capture_resolve'> = {
        id: 'capture-limit-bad',
        name: 'browser.capture_resolve',
        args: {role: 'button', limit: 21},
    };
    const {deps} = await createDeps(25, 'Orders');
    const okResult = await executeBrowserCaptureResolve(withinLimit, deps, 'ws-1');
    assert.equal(okResult.ok, true);
    if (okResult.ok) {assert.equal(((okResult.data as any).candidates || []).length, 20);}

    const badResult = await executeBrowserCaptureResolve(overLimit, deps, 'ws-1');
    assert.equal(badResult.ok, false);
    if (badResult.ok) {return;}
    assert.equal(badResult.error?.code, 'ERR_BAD_ARGS');
});
