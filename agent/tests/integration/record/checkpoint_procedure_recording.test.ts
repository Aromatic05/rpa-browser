import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildRecordedCheckpoint,
    checkpointEntityRuleOptions,
} from '../../../src/record/checkpoint_recording';
import {runCheckpointProcedure} from '../../../src/runner/checkpoint/runtime';
import type {StepResult, StepUnion} from '../../../src/runner/steps/types';
import type {WorkflowArtifact, WorkflowEntityRules} from '../../../src/workflow';

const entityRule: WorkflowEntityRules = {
    kind: 'entity_rules',
    name: 'order-query-rule',
    page: {kind: 'table', urlPattern: '^https://example\\.test/orders'},
    match: {
        version: 2,
        rules: [
            {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'table', idEquals: 'Orders'}},
            {ruleId: 'order-no', source: 'node', expect: 'unique', within: 'root', match: {nameEquals: 'orderNo'}},
            {ruleId: 'buyer', source: 'node', expect: 'unique', within: 'root', match: {nameEquals: 'buyer'}},
            {ruleId: 'query', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'Query'}},
        ],
    },
    annotation: {
        version: 2,
        bindings: [
            {
                ruleId: 'root',
                businessTag: 'orders.query',
                displayName: '订单查询',
                legacyCanvas: {
                    version: 1,
                    profileName: 'order-query-rule',
                    page: {kind: 'table'},
                    entities: [{
                        id: 'e0',
                        source: 'region',
                        kind: 'table',
                        name: '订单查询',
                        businessTag: 'orders.query',
                        target: {idEquals: 'Orders'},
                        annotations: [
                            {id: 'f1', type: 'field', name: '订单编号', businessKey: 'orderNo', target: {}, origin: 'confirmed', disposition: 'active'},
                            {id: 'f2', type: 'field', name: '采购人', businessKey: 'buyer', target: {}, origin: 'confirmed', disposition: 'active'},
                            {id: 'a1', type: 'action', name: '查询', businessKey: 'query', target: {}, origin: 'confirmed', disposition: 'active'},
                        ],
                        columns: [{id: 'c1', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'confirmed', disposition: 'active'}],
                        origin: 'confirmed',
                    }],
                    preserved: {},
                },
            },
            {ruleId: 'order-no', fieldKey: 'orderNo', fieldRole: 'filter', fieldName: '订单编号'},
            {ruleId: 'buyer', fieldKey: 'buyer', fieldRole: 'filter', fieldName: '采购人'},
            {ruleId: 'query', actionIntent: 'query', actionRole: 'module', actionText: '查询'},
        ],
    },
};


const errorEntityRule: WorkflowEntityRules = {
    kind: 'entity_rules',
    name: 'expired-session-rule',
    page: {kind: 'panel', urlPattern: '^https://example\\.test/error'},
    match: {
        version: 2,
        rules: [
            {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'panel', idEquals: 'SessionAlert'}},
            {ruleId: 'dismiss', source: 'node', expect: 'unique', within: 'root', match: {idEquals: 'Dismiss'}},
        ],
    },
    annotation: {
        version: 2,
        bindings: [
            {
                ruleId: 'root',
                businessTag: 'auth.expired',
                entityKind: 'panel',
                displayName: '登录失效提示',
                legacyCanvas: {
                    version: 1,
                    profileName: 'expired-session-rule',
                    page: {kind: 'panel'},
                    entities: [{
                        id: 'expired',
                        source: 'region',
                        kind: 'panel',
                        name: '登录失效提示',
                        businessTag: 'auth.expired',
                        target: {idEquals: 'SessionAlert'},
                        annotations: [
                            {id: 'dismiss', type: 'action', name: '关闭提示', businessKey: 'dismiss', target: {}, origin: 'confirmed', disposition: 'active'},
                        ],
                        columns: [],
                        origin: 'confirmed',
                    }],
                    preserved: {},
                },
            },
            {ruleId: 'dismiss', actionIntent: 'dismiss', actionRole: 'form', actionText: '关闭提示'},
        ],
    },
};

const recoverySteps: StepUnion[] = [
    {id: 'click-dismiss', name: 'browser.click', args: {selector: '#dismiss'}} as StepUnion,
];

const recoveryEnhancements = {
    'click-dismiss': {
        version: 1 as const,
        target: {
            nodeId: 'dismiss',
            semanticHints: {
                profileName: 'expired-session-rule',
                businessTag: 'auth.expired',
                entityKind: 'panel',
                actionIntent: 'dismiss',
            },
        },
    },
};


const artifacts = new Map<string, WorkflowArtifact>([
    [entityRule.name, entityRule],
    [errorEntityRule.name, errorEntityRule],
]);
const workflow = {
    name: 'ws-1',
    save: (artifact: WorkflowArtifact) => structuredClone(artifact),
    get: (name: string) => structuredClone(artifacts.get(name) ?? null),
    list: (dummy: {kind: string}) => [...artifacts.values()]
        .filter((artifact) => artifact.kind === dummy.kind)
        .map((artifact) => ({
            kind: artifact.kind,
            name: artifact.name,
            title: artifact.name,
            summary: artifact.kind,
            createdAt: 1,
            updatedAt: 1,
            enabled: true,
        })),
    delete: () => false,
};
const workspace = {name: 'ws-1', workflow} as never;

const recordedSteps: StepUnion[] = [
    {id: 'fill-order-no', name: 'browser.fill', args: {selector: '#orderNo', value: 'SO-001'}} as StepUnion,
    {id: 'fill-buyer', name: 'browser.fill', args: {selector: '#buyer', value: '王小虎'}} as StepUnion,
    {id: 'click-query', name: 'browser.click', args: {selector: '#query'}} as StepUnion,
];

const savePayload = {
    kind: 'procedure',
    name: '查询订单',
    profileName: 'order-query-rule',
    businessTag: 'orders.query',
    entityKind: 'table',
    outputKind: 'none',
} as const;

const recordedEnhancements = {
    'fill-order-no': {
        version: 1 as const,
        target: {
            nodeId: 'order-no',
            semanticHints: {
                profileName: 'order-query-rule',
                businessTag: 'orders.query',
                entityKind: 'table',
                fieldKey: 'orderNo',
                fieldLabel: '订单编号',
            },
        },
    },
    'fill-buyer': {
        version: 1 as const,
        target: {
            nodeId: 'buyer',
            semanticHints: {
                profileName: 'order-query-rule',
                businessTag: 'orders.query',
                entityKind: 'table',
                fieldKey: 'buyer',
                fieldLabel: '采购人',
            },
        },
    },
    'click-query': {
        version: 1 as const,
        target: {
            nodeId: 'query',
            semanticHints: {
                profileName: 'order-query-rule',
                businessTag: 'orders.query',
                entityKind: 'table',
                actionIntent: 'query',
            },
        },
    },
};

test('entity-rule options expose business fields and actions without internal rule ids', () => {
    const options = checkpointEntityRuleOptions(workspace, 'https://example.test/orders?page=1');
    assert.deepEqual(options, [{
        profileName: 'order-query-rule',
        businessTag: 'orders.query',
        entityKind: 'table',
        label: '订单查询',
        fields: [
            {fieldKey: 'orderNo', label: '订单编号', targetKind: 'table.filter'},
            {fieldKey: 'buyer', label: '采购人', targetKind: 'table.filter'},
        ],
        actions: [{actionIntent: 'query', label: '查询', targetKind: 'table.module_action'}],
        outputs: [
            {kind: 'none', label: '无'},
            {kind: 'table.currentRows', label: '当前列表数据'},
            {kind: 'table.rowCount', label: '当前列表行数'},
        ],
    }]);
});

test('procedure recording parameterizes business inputs and resolves targets through entity rules', async () => {
    const artifact = buildRecordedCheckpoint(workspace, recordedSteps, recordedEnhancements, savePayload);
    assert.equal(artifact.checkpoint.kind, 'procedure');
    assert.equal(artifact.checkpoint.name, '查询订单');
    assert.deepEqual(artifact.checkpoint.trigger?.matchRules, [{
        entityExists: {query: '', kind: 'table', businessTag: 'orders.query'},
    }]);
    assert.deepEqual(artifact.checkpoint.input, {orderNo: 'SO-001', buyer: '王小虎'});
    assert.equal(artifact.checkpoint.output, undefined);

    const content = artifact.checkpoint.content ?? [];
    assert.equal(content.length, 6);
    assert.deepEqual(content[0], {
        type: 'query',
        args: {
            op: 'entity.target',
            businessTag: 'orders.query',
            target: {kind: 'table.filter', fieldKey: 'orderNo'},
        },
        entityRules: {selection: 'explicit', profiles: ['order-query-rule'], strict: true},
        saveAs: 'target1',
    });
    assert.deepEqual(content[1], {
        type: 'act',
        step: {
            name: 'browser.fill',
            args: {nodeId: {ref: 'local.target1.nodeId'}, value: {ref: 'input.orderNo'}},
            entityRules: {selection: 'explicit', profiles: ['order-query-rule'], strict: true},
        },
    });
    assert.equal(JSON.stringify(content).includes('SO-001'), false);
    assert.equal(JSON.stringify(content).includes('王小虎'), false);
    assert.equal(JSON.stringify(content).includes('#orderNo'), false);

    const executed: StepUnion[] = [];
    const result = await runCheckpointProcedure({
        checkpoint: artifact.checkpoint,
        input: {orderNo: 'SO-999', buyer: '李雷'},
        stepIdPrefix: 'procedure-test',
        executeStep: async (step): Promise<StepResult> => {
            executed.push(structuredClone(step));
            if (step.name === 'browser.assert') {return {stepId: step.id, ok: true, data: {}};}
            if (step.name === 'browser.query') {
                const target = (step.args as {target?: {fieldKey?: string; actionIntent?: string}}).target;
                return {stepId: step.id, ok: true, data: {nodeId: target?.fieldKey ?? target?.actionIntent}};
            }
            return {stepId: step.id, ok: true, data: {}};
        },
    });
    assert.equal(result.ok, true);
    const fills = executed.filter((step) => step.name === 'browser.fill');
    assert.deepEqual(fills.map((step) => step.args), [
        {nodeId: 'orderNo', value: 'SO-999'},
        {nodeId: 'buyer', value: '李雷'},
    ]);
    const click = executed.find((step) => step.name === 'browser.click');
    assert.deepEqual(click?.args, {nodeId: 'query'});
});

test('procedure recording can collect table output through the same entity rule', () => {
    const artifact = buildRecordedCheckpoint(workspace, recordedSteps, recordedEnhancements, {
        ...savePayload,
        outputKind: 'table.currentRows',
    });
    assert.deepEqual(artifact.checkpoint.output, {rows: {ref: 'local.checkpointOutput.value'}});
    assert.deepEqual(artifact.checkpoint.content?.at(-1), {
        type: 'query',
        args: {op: 'entity', businessTag: 'orders.query', query: 'table.currentRows'},
        entityRules: {selection: 'explicit', profiles: ['order-query-rule'], strict: true},
        saveAs: 'checkpointOutput',
    });
});


test('recovery recording is triggered by the selected error entity rule and re-resolves semantic actions', () => {
    const artifact = buildRecordedCheckpoint(workspace, recoverySteps, recoveryEnhancements, {
        kind: 'recovery',
        name: '关闭登录失效提示',
        profileName: 'expired-session-rule',
        businessTag: 'auth.expired',
        entityKind: 'panel',
        operation: 'click',
        retryOriginal: true,
    });
    assert.equal(artifact.checkpoint.kind, 'recovery');
    assert.deepEqual(artifact.checkpoint.trigger?.matchRules, [
        {entityExists: {query: '', kind: 'panel', businessTag: 'auth.expired'}},
        {stepName: 'browser.click'},
    ]);
    assert.deepEqual(artifact.checkpoint.content, [
        {
            type: 'query',
            args: {
                op: 'entity.target',
                businessTag: 'auth.expired',
                target: {kind: 'entity.action', actionIntent: 'dismiss'},
            },
            entityRules: {selection: 'explicit', profiles: ['expired-session-rule'], strict: true},
            saveAs: 'target1',
        },
        {
            type: 'act',
            step: {
                name: 'browser.click',
                args: {nodeId: {ref: 'local.target1.nodeId'}},
                entityRules: {selection: 'explicit', profiles: ['expired-session-rule'], strict: true},
            },
        },
    ]);
    assert.deepEqual(artifact.checkpoint.policy, {
        maxAttempts: 1,
        retryOriginal: true,
        stopOnFailure: true,
    });
});

test('legacy recovery constraints are optional additions to the error entity trigger', () => {
    const artifact = buildRecordedCheckpoint(workspace, recoverySteps, recoveryEnhancements, {
        kind: 'recovery',
        name: '登录页关闭提示',
        profileName: 'expired-session-rule',
        businessTag: 'auth.expired',
        entityKind: 'panel',
        triggerKind: 'url_includes',
        triggerValue: '/login',
        retryOriginal: false,
    });
    assert.deepEqual(artifact.checkpoint.trigger?.matchRules, [
        {entityExists: {query: '', kind: 'panel', businessTag: 'auth.expired'}},
        {urlIncludes: '/login'},
    ]);
});
