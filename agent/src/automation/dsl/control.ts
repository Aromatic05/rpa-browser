import { replyAction } from '../../interface/actions/action_protocol';
import { ActionError, ERROR_CODES } from '../../interface/actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
import { runDslSource, validateDslSource } from './runtime';
import { createDslEntityRulesResolver, createDslResolveResolver, type DslEntityRulesResolver, type DslResolveResolver } from './link';
import { DslValidationError } from '../../program/dsl/diagnostics';
import { runWorkspaceExecution } from '../runtime/workspace/execution_coordinator';
import type { RunStepsDeps } from '../runner/run_steps';
import type { WorkspaceEntityRulesProvider } from '../snapshot/rules/runtime/contracts';
import {workflowArtifactRevision, type Workflow, type WorkflowDsl, type WorkflowDummy} from '../workflow';
import type { StepResolve } from '../runner/steps/types';
import { materializeReferencedCheckpointRuntimeSnapshot } from '../runner/checkpoint';
import { validateDslCheckpointGraph } from './validate';
import type { DslCheckpointProvider } from './emit';
import {saveWorkflowDsl} from './save';

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

const withCheckpointResolveBundle = (
    base: DslResolveResolver,
    checkpointId: string,
    stepResolves: Record<string, StepResolve>,
): DslResolveResolver => ({
    resolveBundle: (name) => name === checkpointId
        ? {resolves: stepResolves, diagnostics: []}
        : base.resolveBundle(name),
});

const validateCheckpointGraph = (
    source: string,
    checkpointProvider: DslCheckpointProvider,
    entityRulesResolver: DslEntityRulesResolver | undefined,
    resolveResolver: DslResolveResolver,
) => validateDslCheckpointGraph(source, checkpointProvider, {
    validateBody: ({checkpoint, source: bodySource, stepResolves}) => validateDslSource(
        bodySource,
        entityRulesResolver,
        withCheckpointResolveBundle(resolveResolver, checkpoint.id, stepResolves),
    ).diagnostics,
});

const readExpectedRevision = (value: unknown): string | null | undefined => {
    if (value === undefined) {return undefined;}
    if (value === null) {return null;}
    if (typeof value !== 'string' || value.length === 0) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'expectedRevision must be a non-empty string or null');
    }
    return value;
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
            expectedRevision?: unknown;
        };

        if (action.type === 'dsl.get') {
            const dslName = payload.dslName || resolveDefaultDslName(workflow);
            const dsl = requireDsl(workflow, dslName);
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    dslName,
                    content: dsl.content,
                    stepResolves: dsl.stepResolves,
                    artifactRevision: workflowArtifactRevision(dsl),
                }),
                events: [],
            };
        }

        const entityRulesResolver = resolveEntityRulesResolver(workspace, workflow);
        if (action.type === 'dsl.save') {
            if (typeof payload.content !== 'string') {
                throw new ActionError(ERROR_CODES.ERR_WORKFLOW_BAD_ARGS, 'dsl.save requires content');
            }
            const dslName = payload.dslName || resolveDefaultDslName(workflow);
            const expectedRevision = readExpectedRevision(payload.expectedRevision);
            const saved = saveWorkflowDsl({
                workflow,
                checkpointProvider: workspace.checkpoint.getProvider(workflow),
                entityRulesResolver,
                dslName,
                content: payload.content,
                ...(payload.stepResolves === undefined ? {} : {stepResolves: payload.stepResolves}),
                expectedRevision,
            });
            return {
                reply: replyAction(action, {
                    workspaceName: workspace.name,
                    dslName,
                    artifactRevision: workflowArtifactRevision(saved),
                    saved: true,
                }),
                events: [],
            };
        }

        const dslName = payload.dslName || resolveDefaultDslName(workflow);
        const dsl = requireDsl(workflow, dslName);
        const resolveResolver = resolveDslResolves(workflow);
        if (action.type === 'dsl.validate' || action.type === 'dsl.test') {
            const validation = validateDslSource(dsl.content, entityRulesResolver, resolveResolver);
            const checkpointDiagnostics = validation.diagnostics.length === 0
                ? validateCheckpointGraph(
                    dsl.content,
                    workspace.checkpoint.getProvider(workflow),
                    entityRulesResolver,
                    resolveResolver,
                )
                : [];
            const diagnostics = [...validation.diagnostics, ...checkpointDiagnostics];
            return {
                reply: replyAction(action, {
                    ok: diagnostics.length === 0,
                    diagnostics,
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
            const executionEntityRulesResolver = checkpointRuntime.entityRulesResolver || entityRulesResolver;
            const executionResolveResolver = checkpointRuntime.resolveResolver || resolveResolver;
            const preflight = validateDslSource(
                dsl.content,
                executionEntityRulesResolver,
                executionResolveResolver,
            );
            if (preflight.diagnostics.length > 0) {
                throw new DslValidationError(preflight.diagnostics);
            }
            const checkpointDiagnostics = validateCheckpointGraph(
                dsl.content,
                checkpointRuntime.provider,
                executionEntityRulesResolver,
                executionResolveResolver,
            );
            if (checkpointDiagnostics.length > 0) {
                throw new DslValidationError(checkpointDiagnostics);
            }
            return await runDslSource(
                dsl.content,
                {
                    workspaceName: workspace.name,
                    deps: services.runStepsDeps,
                    input: payload.input || {},
                    checkpointProvider: checkpointRuntime.provider,
                    entityRulesResolver: executionEntityRulesResolver,
                    resolveResolver: executionResolveResolver,
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
