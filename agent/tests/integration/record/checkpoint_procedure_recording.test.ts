import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildRecordedCheckpoint,
    checkpointEntityRuleOptions,
} from '../../../src/automation/recording/checkpoint_recording';
import {ActionError, ERROR_CODES} from '../../../src/interface/actions/results';
import {runDslSource} from '../../../src/program/dsl/runtime';
import {runCheckpointDslBody} from '../../../src/automation/runner/checkpoint/dsl_body';
import {createDslEntityRulesResolver} from '../../../src/program/dsl/link';
import {createWorkspaceEntityRulesProvider} from '../../../src/automation/snapshot/rules/runtime';
import {createWorkflowCheckpointProvider} from '../../../src/automation/workflow/checkpoint';
import {createCheckpointCodec} from '../../../src/automation/workflow/checkpoint';
import type {StepUnion} from '../../../src/automation/runner/steps/types';
import type {WorkflowArtifact, WorkflowEntityRules} from '../../../src/automation/workflow';

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
            {ruleId: 'confirm-shipment', source: 'node', expect: 'one_or_more', within: 'root', match: {textContains: '确认发货'}},
        ],
    },
    annotation: {
        version: 2,
        bindings: [
            {
                ruleId: 'root',
                businessTag: 'orders.query',
                entityKey: 'ordersQuery',
                primaryKey: {fieldKey: 'orderNo'},
                columns: [{fieldKey: 'orderNo'}],
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
                        primaryKey: {fieldKey: 'orderNo', columns: ['订单编号']},
                        annotations: [
                            {id: 'f1', type: 'field', name: '订单编号', businessKey: 'orderNo', target: {}, origin: 'confirmed', disposition: 'active'},
                            {id: 'f2', type: 'field', name: '采购人', businessKey: 'buyer', target: {}, origin: 'confirmed', disposition: 'active'},
                            {id: 'a1', type: 'action', name: '查询', businessKey: 'query', target: {}, origin: 'confirmed', disposition: 'active'},
                        ],
                        columns: [
                            {id: 'c1', fieldKey: 'orderNo', name: '订单编号', actions: [], origin: 'confirmed', disposition: 'active'},
                            {
                                id: 'c2',
                                fieldKey: 'actions',
                                name: '操作',
                                kind: 'action_column',
                                actions: [{
                                    id: 'a2',
                                    actionIntent: 'confirmShipment',
                                    text: '确认发货',
                                    target: {},
                                    origin: 'confirmed',
                                    disposition: 'active',
                                }],
                                origin: 'confirmed',
                                disposition: 'active',
                            },
                        ],
                        origin: 'confirmed',
                    }],
                    preserved: {},
                },
            },
            {ruleId: 'order-no', fieldKey: 'orderNo', fieldRole: 'filter', fieldName: '订单编号'},
            {ruleId: 'buyer', fieldKey: 'buyer', fieldRole: 'filter', fieldName: '采购人'},
            {ruleId: 'query', actionIntent: 'query', actionRole: 'module', actionText: '查询'},
            {ruleId: 'confirm-shipment', actionIntent: 'confirmShipment', actionRole: 'row', actionText: '确认发货', columnFieldKey: 'actions'},
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
                entityKey: 'authExpired',
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

const rowActionSteps: StepUnion[] = [
    {id: 'fill-target-order', name: 'browser.fill', args: {selector: '#orderNo', value: 'SO-002'}} as StepUnion,
    {id: 'click-query-orders', name: 'browser.click', args: {selector: '#query'}} as StepUnion,
    {id: 'click-confirm-shipment', name: 'browser.click', args: {selector: '#ship-so-002'}} as StepUnion,
];

const rowActionEnhancements = {
    'fill-target-order': {
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
    'click-query-orders': {
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
    'click-confirm-shipment': {
        version: 1 as const,
        target: {
            nodeId: 'ship-so-002',
            semanticHints: {
                profileName: 'order-query-rule',
                businessTag: 'orders.query',
                entityKind: 'table',
                actionIntent: 'confirmShipment',
                actionRole: 'row' as const,
                rowPrimaryKey: {fieldKey: 'orderNo', value: 'SO-002'},
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
        rowActions: [{actionIntent: 'confirmShipment', label: '确认发货', targetKind: 'table.row_action'}],
        primaryKey: {fieldKey: 'orderNo', label: '订单编号'},
        outputs: [
            {kind: 'none', label: '无'},
            {kind: 'table.currentRows', label: '当前列表数据'},
            {kind: 'table.rowCount', label: '当前列表行数'},
        ],
    }]);
});

test('procedure recording emits a parameterized entity-rule DSL body', async () => {
    const artifact = buildRecordedCheckpoint(workspace, recordedSteps, recordedEnhancements, savePayload);
    assert.equal(artifact.checkpoint.kind, 'procedure');
    assert.equal(artifact.checkpoint.name, '查询订单');
    assert.deepEqual(artifact.checkpoint.trigger?.matchRules, [{
        entityExists: {query: '', kind: 'table', businessTag: 'orders.query'},
    }]);
    assert.deepEqual(artifact.checkpoint.input, {orderNo: 'SO-001', buyer: '王小虎'});
    assert.equal(artifact.checkpoint.output, undefined);

    assert.deepEqual(artifact.checkpoint.body, {language: 'dsl', source: 'body.dsl'});
    assert.equal(artifact.checkpoint.prepare, undefined);
    assert.equal(artifact.checkpoint.content, undefined);
    assert.equal(artifact.checkpoint.output, undefined);
    assert.equal(artifact.bodyDsl, [
        'use entity_rules "order-query-rule" as entity',
        'fill entity.ordersQuery.orderNo with input.orderNo',
        'fill entity.ordersQuery.buyer with input.buyer',
        'click entity.ordersQuery.query',
    ].join('\n'));
    assert.equal(artifact.bodyDsl.includes('SO-001'), false);
    assert.equal(artifact.bodyDsl.includes('王小虎'), false);
    assert.equal(artifact.bodyDsl.includes('#orderNo'), false);
});

test('recorded snapshots compile to DSL without a resolve sidecar', () => {
    const snapshotSteps = [{id: 'snapshot', name: 'browser.snapshot', args: {}} as StepUnion];
    const procedure = buildRecordedCheckpoint(workspace, snapshotSteps, {}, savePayload);
    const recovery = buildRecordedCheckpoint(workspace, snapshotSteps, {}, {
        kind: 'recovery',
        name: '恢复时快照',
        profileName: 'expired-session-rule',
        businessTag: 'auth.expired',
        entityKind: 'panel',
    });

    assert.deepEqual(procedure.stepResolves, {});
    assert.equal(procedure.bodyDsl, 'use entity_rules "order-query-rule" as entity\nsnapshot');
    assert.deepEqual(recovery.stepResolves, {});
    assert.equal(recovery.bodyDsl, 'use entity_rules "expired-session-rule" as entity\nsnapshot');
});

test('unmapped scroll noise does not poison mapped business checkpoint steps', () => {
    const steps = [
        recordedSteps[0],
        {id: 'incidental-scroll', name: 'browser.scroll', args: {deltaY: 480}} as StepUnion,
        recordedSteps[1],
        recordedSteps[2],
    ];
    const artifact = buildRecordedCheckpoint(workspace, steps, recordedEnhancements, savePayload);

    assert.equal(artifact.bodyDsl, [
        'use entity_rules "order-query-rule" as entity',
        'fill entity.ordersQuery.orderNo with input.orderNo',
        'fill entity.ordersQuery.buyer with input.buyer',
        'click entity.ordersQuery.query',
    ].join('\n'));
});

test('unsupported legacy recorder steps remain explicit bad-argument errors', () => {
    for (const name of ['browser.hover', 'browser.scroll', 'browser.press_key', 'browser.take_screenshot'] as const) {
        assert.throws(
            () => buildRecordedCheckpoint(workspace, [{id: name, name, args: {}} as StepUnion], {}, savePayload),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
        );
    }
});

test('procedure recording can collect table output through the same entity rule', () => {
    const artifact = buildRecordedCheckpoint(workspace, recordedSteps, recordedEnhancements, {
        ...savePayload,
        outputKind: 'table.currentRows',
    });
    assert.equal(artifact.checkpoint.output, undefined);
    assert.equal(artifact.bodyDsl?.endsWith('output rows = checkpointOutput'), true);
});

test('recorded procedure survives close/reload and executes through the formal checkpoint provider', async () => {
    const artifact = buildRecordedCheckpoint(workspace, recordedSteps, recordedEnhancements, savePayload);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-recorder-dsl-'));
    const previous = process.env.RPA_WORKFLOW_ROOT;
    process.env.RPA_WORKFLOW_ROOT = root;
    try {
        const codec = createCheckpointCodec('ws-reload');
        codec.save(artifact);
        const loaded = codec.load(artifact.name);
        assert.ok(loaded);
        const yaml = fs.readFileSync(path.join(root, 'ws-reload', 'checkpoints', artifact.name, 'checkpoint.yaml'), 'utf8');
        assert.match(yaml, /body:/);
        assert.doesNotMatch(yaml, /(?:prepare|content|output):/);
        const calls: StepUnion[] = [];
        await runDslSource(`use checkpoint "${artifact.name}" with {
  orderNo: input.orderNo
  buyer: input.buyer
}`, {
            workspaceName: 'ws-reload', deps: {} as never,
            input: {orderNo: 'SO-999', buyer: '李雷'},
            checkpointProvider: createWorkflowCheckpointProvider(new Map([[loaded.name, loaded]])),
            entityRulesResolver: createDslEntityRulesResolver(createWorkspaceEntityRulesProvider(workflow as never)),
            stepExecutionPort: {
                execute: async (step) => {
                    calls.push(structuredClone(step));
                    if (step.name === 'browser.query') {
                        const target = (step.args as {target?: {fieldKey?: string; actionIntent?: string}}).target;
                        return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: target?.fieldKey ?? target?.actionIntent}};
                    }
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        });
        assert.deepEqual(calls.filter((step) => step.name === 'browser.fill').map((step) => step.args), [
            {nodeId: 'orderNo', value: 'SO-999'}, {nodeId: 'buyer', value: '李雷'},
        ]);
        assert.deepEqual(calls.find((step) => step.name === 'browser.click')?.args, {nodeId: 'query'});
    } finally {
        if (previous === undefined) {delete process.env.RPA_WORKFLOW_ROOT;} else {process.env.RPA_WORKFLOW_ROOT = previous;}
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('procedure recording turns a repeated row control into a primary-key row action', async () => {
    const artifact = buildRecordedCheckpoint(workspace, rowActionSteps, rowActionEnhancements, {
        ...savePayload,
        name: '查询并确认发货',
    });
    assert.deepEqual(artifact.checkpoint.input, {orderNo: 'SO-002'});
    const serialized = artifact.bodyDsl || '';
    assert.equal(serialized.includes('#ship-so-002'), false);
    assert.equal(serialized.includes('.row(input.orderNo).'), true);
    assert.equal(serialized.includes('confirmShipment'), true);

    assert.equal(artifact.bodyDsl?.includes('click entity.ordersQuery.row(input.orderNo).confirmShipment'), true);
});


test('recovery recording is triggered by the selected error entity rule and executes its DSL body', async () => {
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
    assert.deepEqual(artifact.checkpoint.body, {language: 'dsl', source: 'body.dsl'});
    assert.equal(artifact.checkpoint.content, undefined);
    assert.equal(artifact.bodyDsl, 'use entity_rules "expired-session-rule" as entity\nclick entity.authExpired.dismiss');
    assert.deepEqual(artifact.checkpoint.policy, {
        maxAttempts: 1,
        retryOriginal: true,
    });
    const calls: StepUnion[] = [];
    await runCheckpointDslBody({
        checkpoint: artifact.checkpoint, source: artifact.bodyDsl!, stepResolves: artifact.stepResolves,
        workspaceName: 'ws-1', deps: {} as never,
        entityRulesResolver: createDslEntityRulesResolver(createWorkspaceEntityRulesProvider(workflow as never)),
        executeStep: async (step) => {
            calls.push(structuredClone(step));
            if (step.name === 'browser.query') {return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'dismiss'}};}
            return {stepId: step.id, ok: true, data: {}};
        },
    });
    assert.deepEqual(calls.map((step) => step.name), ['browser.query', 'browser.click']);
    assert.deepEqual(calls[1]?.args, {nodeId: 'dismiss'});
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
