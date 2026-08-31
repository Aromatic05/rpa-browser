import crypto from 'node:crypto';
import {createWorkspaceHarness} from './workspace_harness';
import {createWorkflowOnFs, type Workflow, type WorkflowEntityRules, type WorkflowRecording} from '../../src/automation/workflow';
import type {StepUnion} from '../../src/automation/runner/steps/types';
import {createWorkspaceLibrary} from '../../src/agent/library/workspace';
import type {Library} from '../../src/agent/library/contracts';

export const unique = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

export const ORDERS_PAGE_PROFILE = 'orders-page';
export const ENSURE_LOGIN_PROCEDURE = 'ensure-login';
export const NESTED_CHECK_PROCEDURE = 'nested-check';
export const RENEW_SESSION_RECOVERY = 'renew-session';
export const DEMO_ONBOARDING = 'demo-onboarding';
export const SUBMIT_REPORT_AUTOMATION = 'submit-report';
export const GHOST_PAGE_PROFILE = 'ghost-page';

export const ordersPageEntityRule = (): WorkflowEntityRules => ({
    kind: 'entity_rules',
    name: ORDERS_PAGE_PROFILE,
    page: {kind: 'table', urlPattern: '^https://example\\.test/orders'},
    match: {
        version: 2,
        rules: [
            {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'table', idEquals: 'Orders'}},
            {ruleId: 'order-no', source: 'node', expect: 'unique', within: 'root', match: {nameEquals: 'orderNo'}},
            {ruleId: 'query', source: 'node', expect: 'one_or_more', within: 'root', match: {idEquals: 'Query'}},
            {ruleId: 'confirm-shipment', source: 'node', expect: 'one_or_more', within: 'root', match: {textContains: 'Confirm shipment'}},
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
            },
            {ruleId: 'order-no', fieldKey: 'orderNo', fieldRole: 'filter', fieldName: 'Order No'},
            {
                ruleId: 'query',
                actionIntent: 'query',
                actionRole: 'module',
                actionText: 'Query',
                effect: {reversibility: 'reversible'},
            },
            {
                ruleId: 'confirm-shipment',
                actionIntent: 'confirmShipment',
                actionRole: 'row',
                actionText: 'Confirm shipment',
                columnFieldKey: 'actions',
                effect: {reversibility: 'irreversible'},
            },
        ],
    },
});

export const populateLibraryWorkspace = (workflow: Workflow, workspaceName: string): void => {
    workflow.save(ordersPageEntityRule());
    workflow.save({
        kind: 'checkpoint',
        name: ENSURE_LOGIN_PROCEDURE,
        checkpoint: {
            id: ENSURE_LOGIN_PROCEDURE,
            kind: 'procedure',
            trigger: {matchRules: []},
            body: {language: 'dsl', source: 'body.dsl'},
        },
        stepResolves: {},
        hints: {},
        bodyDsl: [
            `use entity_rules "${ORDERS_PAGE_PROFILE}" as orders`,
            'output authenticated = input.value',
        ].join('\n'),
    });
    workflow.save({
        kind: 'checkpoint',
        name: NESTED_CHECK_PROCEDURE,
        checkpoint: {
            id: NESTED_CHECK_PROCEDURE,
            kind: 'procedure',
            trigger: {matchRules: []},
            body: {language: 'dsl', source: 'body.dsl'},
        },
        stepResolves: {},
        hints: {},
        bodyDsl: [
            `use entity_rules "${ORDERS_PAGE_PROFILE}" as orders`,
            `use checkpoint "${ENSURE_LOGIN_PROCEDURE}" with {`,
            '  value: input.orderNo',
            '}',
            'output handled = input.orderNo',
        ].join('\n'),
    });
    workflow.save({
        kind: 'checkpoint',
        name: RENEW_SESSION_RECOVERY,
        checkpoint: {
            id: RENEW_SESSION_RECOVERY,
            kind: 'recovery',
            trigger: {
                matchRules: [
                    {errorCode: 'ERR_AGENT_SESSION_EXPIRED'},
                    {stepName: 'browser.click'},
                ],
            },
            policy: {maxAttempts: 2, retryOriginal: true},
            body: {language: 'dsl', source: 'body.dsl'},
        },
        stepResolves: {},
        hints: {},
        bodyDsl: [
            `use entity_rules "${ORDERS_PAGE_PROFILE}" as orders`,
            'output renewed = input.value',
        ].join('\n'),
    });
    workflow.save(demoOnboarding(workspaceName));
    workflow.save({
        kind: 'dsl',
        name: SUBMIT_REPORT_AUTOMATION,
        content: [
            `use entity_rules "${ORDERS_PAGE_PROFILE}" as orders`,
            `use checkpoint "${NESTED_CHECK_PROCEDURE}" with {`,
            '  orderNo: input.orderNo',
            '}',
            'output processed = input.orderNo',
        ].join('\n'),
        stepResolves: {},
    });
};

export const demoOnboarding = (workspaceName: string): WorkflowRecording => ({
    kind: 'recording',
    name: DEMO_ONBOARDING,
    recording: {
        version: 1,
        recordingName: DEMO_ONBOARDING,
        workspaceName,
        activeTabRef: 'tab-1',
        initialTabs: [
            {tabName: 'main', tabRef: 'tab-1', url: 'https://example.test/orders', title: 'Orders', active: true},
        ],
        tabs: [],
        createdAt: 0,
        stepCount: 2,
    },
    steps: [
        {id: 's1', name: 'browser.goto', args: {url: 'https://example.test/orders'}},
        {id: 's2', name: 'browser.click', args: {}},
    ] as unknown as StepUnion[],
    stepResolves: {},
});

export type LibraryHarness = {
    runStepsDeps: ReturnType<typeof createWorkspaceHarness>['runStepsDeps'];
    workspaceName: string;
    workflow: Workflow;
    library: Library;
};

export const createLibraryHarness = (): LibraryHarness => {
    const {registry, runStepsDeps} = createWorkspaceHarness();
    const workspaceName = unique('library-fixture');
    const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    populateLibraryWorkspace(workspace.workflow, workspaceName);
    const library = createWorkspaceLibrary({workspaceName, deps: runStepsDeps});
    return {runStepsDeps, workspaceName, workflow: workspace.workflow, library};
};