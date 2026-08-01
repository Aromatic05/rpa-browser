import { replyAction } from '../actions/action_protocol';
import { ActionError, ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import { runDslSource, validateDslSource } from './runtime';
import { createDslEntityRulesResolver, createDslResolveResolver, type DslEntityRulesResolver, type DslResolveResolver } from './link';
import { DslValidationError } from './diagnostics';
import { runWorkspaceExecution } from '../runtime/workspace/execution_coordinator';
import type { RunStepsDeps } from '../runner/run_steps';
import type { WorkspaceEntityRulesProvider } from '../snapshot/rules/runtime/contracts';
import type { Workflow, WorkflowDsl, WorkflowDummy } from '../workflow';
import type { StepResolve } from '../runner/steps/types';
import { validateStepResolveFileForSerialization } from '../runner/serialization/types';
import { materializeReferencedCheckpointRuntimeSnapshot } from '../runner/checkpoint';

const DSL_DUMMY: WorkflowDummy = {kind: 'dsl'};

export type DslControlServices = {
    runStepsDeps: RunStepsDeps;
};

export type DslControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

const requireWorkspaceWorkflow = (input: WorkspaceRouterInput): Workflow => {
    const {workspace} = input;
    if (workspace.workflow.name !== workspace.name) {
        throw new ActionError(
            ERROR_CODES.ERR_WORKFLOW_BAD_ARGS,
            `workspace/workflow identity mismatch: workspace=${workspace.name} workflow=${workspace.workflow.name}`,
        );
    }
    return workspace.workflow;
};

const resolveDefaultDslName = (workflow: Workflow): string => {
    if (!workflow.entryDslName) {
        throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'workflow does not expose an entry DSL');
    }
    return workflow.entryDslName();
};

const requireDsl = (workflow: Workflow, dslName: string): WorkflowDsl => {
    const artifact = workflow.get(dslName, DSL_DUMMY);
    if (artifact?.kind !== 'dsl') {
        throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `dsl not found: ${dslName}`);
    }
    return artifact;
};

const resolveEntityRulesResolver = (
    workspace: WorkspaceRouterInput['workspace'],
    workflow: Workflow,
): DslEntityRulesResolver | undefined => {
    const entityRules = (workspace as {entityRules?: {getProvider: (workflow: Workflow) => WorkspaceEntityRulesProvider}}).entityRules;
    if (!entityRules) {return undefined;}
    return createDslEntityRulesResolver(entityRules.getProvider(workflow));
};

const resolveDslResolves = (workflow: Workflow): DslResolveResolver => createDslResolveResolver(workflow);

const validateStepResolves = (value: unknown): Record<string, StepResolve> => {
    try {
        const resolves = structuredClone(value) as Record<string, StepResolve>;
        validateStepResolveFileForSerialization({version: 1, resolves});
        return resolves;
    } catch (error) {
        throw new ActionError(
            ERROR_CODES.ERR_WORKFLOW_BAD_ARGS,
            `invalid DSL resolve sidecar: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
};

export const createDslControl = (services: DslControlServices): DslControl => ({
    handle: async (input) => {
        const {action, workspace} = input;

        if (action.type !== 'dsl.get'
            && action.type !== 'dsl.save'
            && action.type !== 'dsl.test'
            && action.type !== 'dsl.validate'
            && action.type !== 'dsl.run') {
            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        }

        const workflow = requireWorkspaceWorkflow(input);
        const payload = (action.payload || {}) as {
            dslName?: string;
            content?: string;
            input?: Record<string, unknown>;
            stepResolves?: Record<string, StepResolve>;
        };

        if (action.type === 'dsl.get') {
            const dslName = payload.dslName || resolveDefaultDslName(workflow);
            const dsl = requireDsl(workflow, dslName);
            return {
                reply: replyAction(action, {workspaceName: workspace.name, dslName, content: dsl.content, stepResolves: dsl.stepResolves}),
                events: [],
            };
        }

        const entityRulesResolver = resolveEntityRulesResolver(workspace, workflow);
        if (action.type === 'dsl.save') {
            if (typeof payload.content !== 'string') {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'dsl.save requires content');
            }
            const dslName = payload.dslName || resolveDefaultDslName(workflow);
            const stepResolves = payload.stepResolves === undefined
                ? existingDslResolves(workflow, dslName)
                : validateStepResolves(payload.stepResolves);
            const resolveResolver = createDslResolveResolver(workflow, new Map([[dslName, stepResolves]]));
            const validation = validateDslSource(payload.content, entityRulesResolver, resolveResolver);
            if (validation.diagnostics.length > 0) {
                throw new DslValidationError(validation.diagnostics);
            }
            workflow.save({kind: 'dsl', name: dslName, content: payload.content, stepResolves});
            return {
                reply: replyAction(action, {workspaceName: workspace.name, dslName, saved: true}),
                events: [],
            };
        }

        const dslName = payload.dslName || resolveDefaultDslName(workflow);
        const dsl = requireDsl(workflow, dslName);
        const resolveResolver = resolveDslResolves(workflow);
        if (action.type === 'dsl.validate' || action.type === 'dsl.test') {
            const validation = validateDslSource(dsl.content, entityRulesResolver, resolveResolver);
            return {
                reply: replyAction(action, {
                    ok: validation.diagnostics.length === 0,
                    diagnostics: validation.diagnostics,
                    workspaceName: workspace.name,
                    ...(action.type === 'dsl.test'
                        ? {deprecated: 'dsl.test validates only; use dsl.run to execute'}
                        : {}),
                }),
                events: [],
            };
        }

        const runResult = await runWorkspaceExecution(workspace, action.type, async () => {
            const checkpointRuntime = materializeReferencedCheckpointRuntimeSnapshot({
                sources: [dsl.content], checkpointProvider: workspace.checkpoint.getProvider(workflow), workflow,
                entityRulesProvider: services.runStepsDeps.resolveEntityRulesProvider?.(workspace.name),
            });
            return await runDslSource(
                dsl.content,
                {
                    workspaceName: workspace.name,
                    deps: services.runStepsDeps,
                    input: payload.input || {},
                    checkpointProvider: checkpointRuntime.provider,
                    entityRulesResolver: checkpointRuntime.entityRulesResolver || entityRulesResolver,
                    resolveResolver: checkpointRuntime.resolveResolver || resolveResolver,
                },
            );
        });

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

const existingDslResolves = (workflow: Workflow, dslName: string): Record<string, StepResolve> => {
    const existing = workflow.get(dslName, DSL_DUMMY);
    return existing?.kind === 'dsl' ? existing.stepResolves : {};
};
