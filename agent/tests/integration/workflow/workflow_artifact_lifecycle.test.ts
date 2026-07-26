import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Action } from '../../../src/actions/action_protocol';
import { createWorkspaceHarness } from '../../helpers/workspace_harness';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';
import { createWorkflowOnFs, deleteWorkflowFromFs, loadWorkflowFromFs } from '../../../src/workflow';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';
import { getRunnerConfig } from '../../../src/config';
import { applyBusinessEntityRules } from '../../../src/runner/steps/executors/snapshot/entity_rules/apply';
import type { EntityIndex, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const cleanup = (name: string) => { try { deleteWorkflowFromFs(name); } catch {} };

const action = (type: string, workspaceName: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
    payload,
    at: Date.now(),
});

const createRunStepsDeps = (): RunStepsDeps => completeRunStepsDeps({
    runtime: {
        ensureActivePage: async () => ({
            workspaceName: 'unused',
            tabName: 'unused',
            page: {} as any,
            traceTools: {},
            traceCtx: { cache: {} },
        }),
    },
    config: getRunnerConfig(),
    pluginHost: {
        getExecutors: () => ({
            'browser.snapshot': async (step: StepUnion) => ({ stepId: step.id, ok: true, data: {} }),
        }) as any,
    } as any,
});

const entityRules = (businessTag: string) => ({
    kind: 'entity_rules' as const,
    name: 'shared-profile',
    match: {
        version: 1,
        page: { kind: 'form' },
        entities: [
            { ruleId: 'main_form', source: 'region', expect: 'unique', match: { kind: 'form' } },
        ],
    },
    annotation: {
        version: 1,
        page: { kind: 'form' },
        annotations: [
            { ruleId: 'main_form', businessTag, businessName: businessTag },
        ],
    },
});

const entityFixture = () => {
    const form: UnifiedNode = { id: 'form', role: 'form', name: 'Form', children: [] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [form] };
    const entityIndex: EntityIndex = {
        entities: {
            form_entity: { id: 'form_entity', type: 'region', kind: 'form', nodeId: 'form', name: 'Form' },
        },
        byNodeId: {
            form: [{ type: 'region', entityId: 'form_entity', role: 'container' }],
        },
    };
    return { root, entityIndex };
};

test('DSL, checkpoint and entity rules survive runtime rebuild and remain workflow-scoped', async () => {
    const alpha = uniqueName('workflow-alpha');
    const beta = uniqueName('workflow-beta');
    cleanup(alpha);
    cleanup(beta);

    try {
        const runStepsDeps = createRunStepsDeps();
        const { registry } = createWorkspaceHarness({ runStepsDeps });
        const alphaWorkspace = registry.createWorkspace(alpha, createWorkflowOnFs(alpha));
        const betaWorkspace = registry.createWorkspace(beta, createWorkflowOnFs(beta));

        for (const [workspace, source] of [[alphaWorkspace, 'alpha'], [betaWorkspace, 'beta']] as const) {
            const checkpointSave = await workspace.router.handle(
                action('checkpoint.save', workspace.name, {
                    checkpoint: { id: 'shared-checkpoint', trigger: { matchRules: [{ errorCode: 'ERR_UNUSED' }] }, output: { source } },
                }),
                workspace,
                registry,
            );
            assert.equal(checkpointSave.reply.type, 'checkpoint.save.result');

            const dslSave = await workspace.router.handle(
                action('dsl.save', workspace.name, {
                    dslName: 'main',
                    content: 'use checkpoint "shared-checkpoint"',
                }),
                workspace,
                registry,
            );
            assert.equal(dslSave.reply.type, 'dsl.save.result');

            const rulesSave = await workspace.router.handle(
                action('entity_rules.save', workspace.name, { entityRules: entityRules(`workflow.${source}`) }),
                workspace,
                registry,
            );
            assert.equal(rulesSave.reply.type, 'entity_rules.save.result');
        }

        registry.removeWorkspace(alpha);
        registry.removeWorkspace(beta);
        const reopenedAlpha = registry.createWorkspace(alpha, loadWorkflowFromFs(alpha));
        const reopenedBeta = registry.createWorkspace(beta, loadWorkflowFromFs(beta));

        const alphaRun = await reopenedAlpha.router.handle(action('dsl.run', alpha), reopenedAlpha, registry);
        const betaRun = await reopenedBeta.router.handle(action('dsl.run', beta), reopenedBeta, registry);
        assert.deepEqual((alphaRun.reply.payload as { output: unknown }).output, { source: 'alpha' });
        assert.deepEqual((betaRun.reply.payload as { output: unknown }).output, { source: 'beta' });

        for (const [workspace, expectedTag] of [[reopenedAlpha, 'workflow.alpha'], [reopenedBeta, 'workflow.beta']] as const) {
            const provider = workspace.entityRules.getProvider(workspace.workflow);
            const bundle = provider.resolveBundle({ pageKind: 'form' });
            assert.ok(bundle);
            const fixture = entityFixture();
            const overlay = applyBusinessEntityRules({ ...fixture, bundle });
            assert.equal(overlay.byEntityId.form_entity?.businessTag, expectedTag);
        }

        assert.equal(reopenedAlpha.workflow.get('main', { kind: 'dsl' })?.kind, 'dsl');
        assert.equal(reopenedAlpha.workflow.get('shared-checkpoint', { kind: 'checkpoint' })?.kind, 'checkpoint');
        assert.equal(reopenedAlpha.workflow.get('shared-profile', { kind: 'entity_rules' })?.kind, 'entity_rules');
    } finally {
        cleanup(alpha);
        cleanup(beta);
    }
});
