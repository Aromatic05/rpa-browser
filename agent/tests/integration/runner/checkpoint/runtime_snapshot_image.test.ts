import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkpointRuntimeSnapshotFromImage,
    materializeCheckpointRuntimeSnapshot,
    materializeReferencedCheckpointRuntimeSnapshot,
    parseCheckpointRuntimeSnapshotImage,
} from '../../../../src/automation/runner/checkpoint/runtime_snapshot';
import type {WorkspaceEntityRulesProvider} from '../../../../src/automation/snapshot/rules';
import type {Workflow} from '../../../../src/automation/workflow';
import type {DslCheckpointProvider} from '../../../../src/automation/dsl/emit';
import type {Checkpoint} from '../../../../src/automation/runner/checkpoint/types';

const entityProvider = (reversibility: () => 'reversible' | 'irreversible'): WorkspaceEntityRulesProvider => ({
    availability: 'ready',
    workflowName: 'ws-runtime-image',
    listProfiles: () => ['orders'],
    getProfile: (profileName) => profileName === 'orders' ? ({
        kind: 'entity_rules',
        name: 'orders',
        page: {kind: 'form'},
        match: {version: 2, rules: [
            {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'form'}},
            {ruleId: 'submit', source: 'node', expect: 'unique', within: 'root', match: {textContains: 'Submit'}},
        ]},
        annotation: {version: 2, bindings: [
            {ruleId: 'root', entityKey: 'form', businessTag: 'orders.form', entityKind: 'form'},
            {ruleId: 'submit', actionIntent: 'submit', effect: {reversibility: reversibility()}},
        ]},
    } as any) : null,
    resolveExports: (profileName) => profileName === 'orders'
        ? {
            index: {
                profileName: 'orders',
                entities: [{
                    profileName: 'orders',
                    entityKey: 'form',
                    businessTag: 'orders.form',
                    kind: 'form',
                    fields: [],
                    actions: [{actionIntent: 'submit', targetKind: 'form.action', effect: {reversibility: reversibility()}}],
                    columns: [],
                    rowActions: [],
                    supportedQueries: ['form.actions'],
                    members: [{kind: 'action', symbol: 'submit'}],
                }],
                resolve: () => undefined,
            },
            diagnostics: [],
        }
        : {index: null, diagnostics: []},
});

const workflow = (resolveId: () => string): Workflow => ({
    get: (name: string) => name === 'external'
        ? {kind: 'dsl', name, content: '', stepResolves: {button: {resolveId: resolveId()}}}
        : null,
} as unknown as Workflow);

test('runtime closure image freezes Page Knowledge and resolve bundles across live Library edits', () => {
    let risk: 'reversible' | 'irreversible' = 'reversible';
    let resolveId = 'resolve-old';
    const snapshot = materializeCheckpointRuntimeSnapshot({
        checkpoints: [], checkpointStepResolves: {}, checkpointBodies: {},
        assetSources: ['use entity_rules "orders" as orders', 'use resolves "external" as target'],
        entityRulesProvider: entityProvider(() => risk),
        workflow: workflow(() => resolveId),
    });
    assert.ok(snapshot.image);
    assert.equal(snapshot.entityRulesResolver?.resolveProfile('orders').profile?.entities[0].actions[0].effect?.reversibility, 'reversible');
    const initialResolve = snapshot.resolveResolver?.resolveBundle('external').resolves?.button as {resolveId?: string} | undefined;
    assert.equal(initialResolve?.resolveId, 'resolve-old');

    risk = 'irreversible';
    resolveId = 'resolve-new';
    const restored = checkpointRuntimeSnapshotFromImage(JSON.parse(JSON.stringify(snapshot.image)));
    assert.equal(restored.entityRulesResolver?.resolveProfile('orders').profile?.entities[0].actions[0].effect?.reversibility, 'reversible');
    const restoredResolve = restored.resolveResolver?.resolveBundle('external').resolves?.button as {resolveId?: string} | undefined;
    assert.equal(restoredResolve?.resolveId, 'resolve-old');
});

test('referenced Procedure bodies contribute semantic dependencies to the durable closure', () => {
    const checkpoint: Checkpoint = {id: 'submit-procedure', kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}};
    const body = ['use entity_rules "orders" as orders', 'click orders.form.submit'].join('\n');
    const provider: DslCheckpointProvider = {
        getCheckpoint: (id) => id === checkpoint.id ? checkpoint : null,
        getCheckpointResolves: () => ({}),
        getCheckpointBody: (id) => id === checkpoint.id ? {source: body, stepResolves: {}} : null,
        listCheckpoints: () => [checkpoint],
    };
    const snapshot = materializeReferencedCheckpointRuntimeSnapshot({
        sources: ['let result = use checkpoint "submit-procedure"'],
        checkpointProvider: provider,
        entityRulesProvider: entityProvider(() => 'reversible'),
    });
    assert.ok(snapshot.image);
    assert.equal(snapshot.checkpointBodies[checkpoint.id], body);
    assert.equal(snapshot.image?.entityRules.profiles.orders.name, 'orders');
});

test('runtime closure parser rejects unknown version and malformed nested maps', () => {
    const snapshot = materializeCheckpointRuntimeSnapshot({checkpoints: [], checkpointStepResolves: {}, checkpointBodies: {}});
    assert.ok(snapshot.image);
    const unknownVersion = structuredClone(snapshot.image!) as any;
    unknownVersion.version = 99;
    assert.equal(parseCheckpointRuntimeSnapshotImage(unknownVersion).ok, false);
    const corruptProfiles = structuredClone(snapshot.image!) as any;
    corruptProfiles.entityRules.profiles = {orders: {kind: 'entity_rules'}};
    assert.equal(parseCheckpointRuntimeSnapshotImage(corruptProfiles).ok, false);
    const corruptResolves = structuredClone(snapshot.image!) as any;
    corruptResolves.resolveBundles = {external: {resolves: [], diagnostics: []}};
    assert.equal(parseCheckpointRuntimeSnapshotImage(corruptResolves).ok, false);
});

test('PageSession refresh uses the frozen Entity Rules provider instead of edited live Page Knowledge', async () => {
    const {chromium} = await import('playwright');
    const {ensureFreshPageSession} = await import('../../../../src/automation/runner/session/capture');
    const {buildPageSessionEntityView} = await import('../../../../src/automation/runner/session/entity_view');
    const {completeRunStepsDeps} = await import('../../../helpers/run_steps_workspace');
    const {buildEntityRuleExportIndex} = await import('../../../../src/automation/workflow');

    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<form id="Orders"><input name="orderNo"><button id="Submit" type="button">Submit</button></form>');
        let businessTag = 'orders.old';
        const dynamicProvider: WorkspaceEntityRulesProvider = {
            availability: 'ready',
            workflowName: 'ws-runtime-image',
            listProfiles: () => ['orders'],
            getProfile: (name) => name === 'orders' ? ({
                kind: 'entity_rules',
                name: 'orders',
                page: {kind: 'form'},
                match: {version: 2, rules: [
                    {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'form'}},
                    {ruleId: 'submit', source: 'node', expect: 'unique', within: 'root', match: {textContains: 'Submit'}},
                ]},
                annotation: {version: 2, bindings: [
                    {ruleId: 'root', entityKey: 'form', businessTag, entityKind: 'form'},
                    {ruleId: 'submit', actionIntent: 'submit'},
                ]},
            } as any) : null,
            resolveExports(name) {
                const profile = this.getProfile(name);
                return profile ? buildEntityRuleExportIndex(profile) : {index: null, diagnostics: []};
            },
        };
        const frozen = materializeCheckpointRuntimeSnapshot({
            checkpoints: [], checkpointStepResolves: {}, checkpointBodies: {},
            assetSources: ['use entity_rules "orders" as orders'],
            entityRulesProvider: dynamicProvider,
        });
        assert.ok(frozen.entityRulesProvider);
        businessTag = 'orders.new';

        const deps = completeRunStepsDeps({
            pluginHost: {} as never,
            resolveEntityRulesProvider: () => dynamicProvider,
        }, {workspaceName: 'ws-1', tabName: 'tab-1', page});
        const control = {selection: 'explicit' as const, profiles: ['orders'], strict: true};
        const frozenEntry = await ensureFreshPageSession(deps, 'ws-1', {
            explicit: true,
            entityRules: control,
            entityRulesProvider: frozen.entityRulesProvider,
        });
        assert.deepEqual(
            buildPageSessionEntityView(frozenEntry.entry).entities.map((entity) => entity.businessTag).filter(Boolean),
            ['orders.old'],
        );

        deps.pageSession.markDirty(page, 'interaction');
        const liveEntry = await ensureFreshPageSession(deps, 'ws-1', {explicit: true, entityRules: control});
        assert.deepEqual(
            buildPageSessionEntityView(liveEntry.entry).entities.map((entity) => entity.businessTag).filter(Boolean),
            ['orders.new'],
        );
        assert.deepEqual(frozen.entityRulesProvider.listProfiles(), ['orders']);
    } finally {
        await browser.close();
    }
});
