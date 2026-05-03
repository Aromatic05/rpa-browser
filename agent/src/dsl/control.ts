import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import { runDslSource } from './runtime';
import type { RunStepsDeps } from '../runner/run_steps';
import type { Workflow, WorkflowDsl, WorkflowDummy } from '../workflow';
import { createWorkspaceCheckpointProvider } from '../checkpoint/provider';

const DSL_DUMMY: WorkflowDummy = { kind: 'dsl' };

export type DslControlServices = {
    runStepsDeps: RunStepsDeps;
};

export type DslControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

const requireWorkspaceWorkflow = (input: WorkspaceRouterInput): Workflow => {
    const { workspace } = input;
    if (workspace.workflow.name !== workspace.name) {
        throw new ActionError(
            ERROR_CODES.ERR_WORKFLOW_BAD_ARGS,
            `workspace/workflow identity mismatch: workspace=${workspace.name} workflow=${workspace.workflow.name}`,
        );
    }
    return workspace.workflow;
};

const resolveDefaultDslName = (workflow: Workflow): string => {
    const items = workflow.list(DSL_DUMMY);
    return items[0]?.name || 'main';
};

const requireDsl = (workflow: Workflow, dslName: string): WorkflowDsl => {
    const artifact = workflow.get(dslName, DSL_DUMMY);
    if (!artifact || artifact.kind !== 'dsl') {
        throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `dsl not found: ${dslName}`);
    }
    return artifact;
};

export const createDslControl = (services: DslControlServices): DslControl => ({
    handle: async (input) => {
        const { action, workspace } = input;

        if (action.type !== 'dsl.get' && action.type !== 'dsl.save' && action.type !== 'dsl.test' && action.type !== 'dsl.run') {
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        }

        const workflow = requireWorkspaceWorkflow(input);
        const payload = (action.payload || {}) as { dslName?: string; content?: string; input?: Record<string, unknown> };

        if (action.type === 'dsl.get') {
            const dslName = payload.dslName || resolveDefaultDslName(workflow);
            const dsl = requireDsl(workflow, dslName);
            return { reply: replyAction(action, { workspaceName: workspace.name, dslName, content: dsl.content }), events: [] };
        }

        if (action.type === 'dsl.save') {
            if (typeof payload.content !== 'string') {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'dsl.save requires content');
            }
            const dslName = payload.dslName || resolveDefaultDslName(workflow);
            workflow.save({ kind: 'dsl', name: dslName, content: payload.content });
            return { reply: replyAction(action, { workspaceName: workspace.name, dslName, saved: true }), events: [] };
        }

        const dslName = payload.dslName || resolveDefaultDslName(workflow);
        const dsl = requireDsl(workflow, dslName);
        const runResult = await runDslSource(dsl.content, {
            workspaceName: workspace.name,
            deps: services.runStepsDeps,
            input: payload.input || {},
            checkpointProvider: createWorkspaceCheckpointProvider(workflow),
        });

        if (action.type === 'dsl.test') {
            return {
                reply: replyAction(action, {
                    ok: true,
                    output: runResult.scope.output,
                    diagnostics: runResult.diagnostics,
                    workspaceName: workspace.name,
                }),
                events: [],
            };
        }

        return {
            reply: replyAction(action, {
                workspaceName: workspace.name,
                output: runResult.scope.output,
                diagnostics: runResult.diagnostics,
            }),
            events: [],
        };
    },
});
