import test from 'node:test';
import assert from 'node:assert/strict';
import type {EntityRulesRuntime} from '../../../../src/automation/snapshot/rules';
import {inspectKnowledgeAsset} from '../../../../src/agent/execution/knowledge/inspect';
import type {KnowledgeSeamDeps} from '../../../../src/agent/execution/knowledge';
import {
    createLibraryHarness,
    NESTED_CHECK_PROCEDURE,
    ORDERS_PAGE_PROFILE,
    RENEW_SESSION_RECOVERY,
    DEMO_ONBOARDING,
} from '../../../helpers/library_harness';

const seamDeps = (): KnowledgeSeamDeps & {entityRulesRuntime: EntityRulesRuntime} => {
    const harness = createLibraryHarness();
    const runtime = harness.runStepsDeps.resolveWorkspace(harness.workspaceName).entityRules;
    return {
        library: harness.library,
        entityRulesRuntime: runtime,
        entityRules: runtime.getProvider(harness.workflow),
    };
};

const inspect = async (input: {kind: 'procedure' | 'page_knowledge' | 'recovery' | 'demonstration' | 'automation'; name: string; includeBody?: boolean}) => {
    const deps = seamDeps();
    if (input.kind === 'procedure' || input.kind === 'page_knowledge') {
        await deps.library.validate({kind: input.kind, name: input.name});
    }
    return inspectKnowledgeAsset(deps, input);
};

test('Procedure inspect exposes stable id, signature and dependencies by default; DSL body only on explicit includeBody', async () => {
    const loaded = await inspect({kind: 'procedure', name: NESTED_CHECK_PROCEDURE});
    assert.equal(loaded.status, 'loaded');
    if (loaded.status !== 'loaded') {return;}
    assert.equal(loaded.kind, 'procedure');
    assert.equal(loaded.name, NESTED_CHECK_PROCEDURE);
    assert.deepEqual(loaded.inputs, ['orderNo']);
    assert.deepEqual(loaded.outputs, ['handled']);
    assert.equal(loaded.health, 'ready');
    assert.equal(loaded.capabilities.callableFromDsl, true);
    assert.equal(loaded.capabilities.modelLoadSeam, true);
    assert.deepEqual(loaded.dependencies.map((item) => [item.kind, item.name]).sort(), [
        ['page_knowledge', ORDERS_PAGE_PROFILE],
        ['procedure', 'ensure-login'],
    ].sort());
    assert.equal(Object.hasOwn(loaded, 'body'), false, 'body must be absent unless includeBody:true is explicit');

    const withBody = await inspect({kind: 'procedure', name: NESTED_CHECK_PROCEDURE, includeBody: true});
    assert.equal(withBody.status, 'loaded');
    if (withBody.status === 'loaded' && withBody.kind === 'procedure') {
        assert.equal(typeof withBody.body, 'string');
        assert.equal(withBody.body?.includes('use checkpoint "ensure-login"'), true, 'explicit includeBody must carry the DSL body');
        assert.equal(withBody.body?.includes('body.dsl'), false);
    }

    const noBody = await inspect({kind: 'procedure', name: NESTED_CHECK_PROCEDURE, includeBody: false});
    assert.equal(noBody.status, 'loaded');
    if (noBody.status === 'loaded' && noBody.kind === 'procedure') {
        assert.equal(noBody.inputs.includes('orderNo'), true);
        assert.equal(Object.hasOwn(noBody, 'body'), false, 'includeBody:false must not load the DSL body');
    }
});

test('Page Knowledge inspect exposes a sanitized semantic entity schema and strips selectors and rule internals', async () => {
    const loaded = await inspect({kind: 'page_knowledge', name: ORDERS_PAGE_PROFILE});
    assert.equal(loaded.status, 'loaded');
    if (loaded.status !== 'loaded') {return;}
    assert.equal(loaded.kind, 'page_knowledge');
    assert.equal(loaded.health, 'ready');
    assert.equal(loaded.capabilities.modelLoadSeam, true);
    assert.deepEqual(loaded.applicability, {kind: 'table', urlPattern: '^https://example\\.test/orders'});
    assert.equal(loaded.entities.length, 1);

    const entity = loaded.entities[0];
    assert.equal(entity.entityKey, 'ordersQuery');
    assert.equal(entity.businessTag, 'orders.query');
    assert.equal(entity.kind, 'table');
    assert.equal(entity.primaryKey?.fieldKey, 'orderNo');
    assert.deepEqual(entity.supportedQueries, ['table.currentRows', 'table.rowCount']);
    assert.deepEqual(entity.fields.map((field) => ({...field, name: field.name, reversibility: field.reversibility})), [{
        fieldKey: 'orderNo',
        name: 'Order No',
        targetKind: 'table.filter',
        reversibility: 'unknown',
    }]);
    assert.deepEqual(entity.actions.map((action) => ({actionIntent: action.actionIntent, name: action.name, reversibility: action.reversibility})), [{
        actionIntent: 'query',
        name: 'Query',
        reversibility: 'reversible',
    }]);
    assert.deepEqual(entity.rowActions.map((action) => ({actionIntent: action.actionIntent, name: action.name, reversibility: action.reversibility})), [{
        actionIntent: 'confirmShipment',
        name: 'Confirm shipment',
        reversibility: 'irreversible',
    }]);

    const serialized = JSON.stringify(loaded);
    for (const forbidden of ['idEquals', 'nameEquals', 'textContains', 'ruleId', 'within', 'contains', 'annotation', 'match', 'bindings', 'nodeId', 'selector', 'idContains']) {
        assert.equal(serialized.includes(forbidden), false, `page knowledge leak: ${forbidden}`);
    }
});

test('Recovery and Demonstration inspect stay catalog-only with truthful capabilities and never dump steps', async () => {
    const recovery = await inspect({kind: 'recovery', name: RENEW_SESSION_RECOVERY});
    assert.equal(recovery.status, 'catalog_only');
    if (recovery.status !== 'catalog_only') {return;}
    assert.equal(recovery.kind, 'recovery');
    assert.equal(recovery.capabilities.runnerRecovery, true);
    assert.equal(recovery.capabilities.modelLoadSeam, false);
    assert.equal(recovery.capabilities.replayable, false);
    assert.equal(recovery.note.length > 0, true);
    assert.equal(Object.hasOwn(recovery, 'body'), false);

    const demo = await inspect({kind: 'demonstration', name: DEMO_ONBOARDING});
    assert.equal(demo.status, 'catalog_only');
    if (demo.status !== 'catalog_only') {return;}
    assert.equal(demo.kind, 'demonstration');
    assert.equal(demo.capabilities.replayable, true);
    assert.equal(demo.capabilities.modelLoadSeam, false);
    assert.equal(demo.stepCount, 2);
    assert.equal(Object.hasOwn(demo, 'steps'), false, 'raw StepUnion arrays must never reach the model');
    const serialized = JSON.stringify(demo);
    assert.equal(serialized.includes('"steps"'), false);
});

test('inspect is a pure read: automation is unsupported, missing assets are not_found', async () => {
    const automation = await inspect({kind: 'automation', name: 'submit-report'});
    assert.equal(automation.status, 'unsupported');
    const missing = await inspect({kind: 'procedure', name: 'does-not-exist'});
    assert.equal(missing.status, 'not_found');
});