import { replyAction } from './action_protocol';
import type { ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import { runDslSource } from '../dsl/runtime';
import { getRecordingBundle } from '../record/recording';
import {
    createWorkflowOnFs,
    ensureWorkflowOnFs,
    listWorkflowNames,
    loadWorkflowFromFs,
    renameWorkflowOnFs,
    type Workflow,
    type WorkflowCheckpoint,
    type WorkflowDummy,
    type WorkflowDsl,
    type WorkflowRecording,
} from '../workflow';

const toDefaultRecordingName = (now = new Date()): string => {
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `recording-${y}${m}${d}-${hh}${mm}${ss}`;
};

const RECORDING_DUMMY: WorkflowDummy = { kind: 'recording' };
const CHECKPOINT_DUMMY: WorkflowDummy = { kind: 'checkpoint' };
const DSL_DUMMY: WorkflowDummy = { kind: 'dsl' };

const requireControlWorkflowName = (payload: Record<string, unknown>): string => {
    const workflowName = typeof payload.workflowName === 'string' ? payload.workflowName.trim() : '';
    if (!workflowName) {
        throw new DslRuntimeError('workflowName is required', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
    }
    return workflowName;
};

const requireWorkspaceName = (action: Parameters<ActionHandler>[1]): string => {
    const workspaceName = action.workspaceName || '';
    if (!workspaceName) {
        throw new DslRuntimeError('workspaceName is required', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
    }
    return workspaceName;
};

const requireWorkspaceWorkflow = (ctx: Parameters<ActionHandler>[0], workspaceName: string): Workflow => {
    const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
    if (!workspace) {
        throw new DslRuntimeError(`workspace not found: ${workspaceName}`, ERROR_CODES.ERR_BAD_ARGS);
    }
    if (workspace.workflow.name !== workspace.name) {
        throw new DslRuntimeError(
            `workspace/workflow identity mismatch: workspace=${workspace.name} workflow=${workspace.workflow.name}`,
            ERROR_CODES.ERR_WORKFLOW_BAD_ARGS,
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
        throw new DslRuntimeError(`dsl not found: ${dslName}`, 'ERR_WORKFLOW_DSL_NOT_FOUND');
    }
    return artifact;
};

const createCheckpointProvider = (workflow: Workflow) => {
    const checkpoints = workflow.list(CHECKPOINT_DUMMY);
    const byName = new Map<string, WorkflowCheckpoint>();
    for (const item of checkpoints) {
        const artifact = workflow.get(item.name, CHECKPOINT_DUMMY);
        if (artifact && artifact.kind === 'checkpoint') {
            byName.set(item.name, artifact);
        }
    }
    return {
        getCheckpoint: (id: string) => byName.get(id)?.checkpoint || null,
        getCheckpointResolves: (id: string) => byName.get(id)?.stepResolves || null,
    };
};

export const workflowHandlers: Record<string, ActionHandler> = {
    'workflow.list': async (_ctx, action) => {
        const workflows: Array<{
            workflowName: string;
            recordings: ReturnType<Workflow['list']>;
            checkpoints: ReturnType<Workflow['list']>;
            dsls: ReturnType<Workflow['list']>;
            entityRules: ReturnType<Workflow['list']>;
        }> = [];
        const diagnostics: Array<{ workflowName: string; code?: string; message: string }> = [];
        for (const name of listWorkflowNames()) {
            try {
                const workflow = loadWorkflowFromFs(name);
                workflows.push({
                    workflowName: name,
                    recordings: workflow.list({ kind: 'recording' }),
                    checkpoints: workflow.list({ kind: 'checkpoint' }),
                    dsls: workflow.list({ kind: 'dsl' }),
                    entityRules: workflow.list({ kind: 'entity_rules' }),
                });
            } catch (error) {
                diagnostics.push({
                    workflowName: name,
                    code: error instanceof DslRuntimeError ? error.code : undefined,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return replyAction(action, { workflows, diagnostics });
    },

    'workflow.create': async (ctx, action) => {
        const payload = (action.payload || {}) as Record<string, unknown>;
        const workflowName = requireControlWorkflowName(payload);
        const workflow = createWorkflowOnFs(workflowName);
        const workspace = ctx.workspaceRegistry.createWorkspace(workflowName, workflow);
        if (workspace.name !== workspace.workflow.name) {
            throw new DslRuntimeError('workspace/workflow identity mismatch after create', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        return replyAction(action, { workflowName, workspaceName: workspace.name, created: true });
    },

    'workflow.open': async (ctx, action) => {
        const payload = (action.payload || {}) as Record<string, unknown>;
        const workflowName = requireControlWorkflowName(payload);
        const workflow = loadWorkflowFromFs(workflowName);
        const workspace = ctx.workspaceRegistry.createWorkspace(workflowName, workflow);
        if (workspace.name !== workspace.workflow.name) {
            throw new DslRuntimeError('workspace/workflow identity mismatch after open', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        return replyAction(action, { workflowName, workspaceName: workspace.name, opened: true });
    },

    'workflow.rename': async (ctx, action) => {
        const payload = (action.payload || {}) as Record<string, unknown>;
        const fromName = typeof payload.fromName === 'string' ? payload.fromName.trim() : '';
        const toName = typeof payload.toName === 'string' ? payload.toName.trim() : '';
        if (!fromName || !toName) {
            throw new DslRuntimeError('fromName and toName are required', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        renameWorkflowOnFs(fromName, toName);
        const renamedWorkflow = loadWorkflowFromFs(toName);
        const workspace = ctx.workspaceRegistry.renameWorkspace(fromName, toName, renamedWorkflow);
        if (workspace.name !== workspace.workflow.name) {
            throw new DslRuntimeError('workspace/workflow identity mismatch after rename', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        return replyAction(action, { fromName, toName, workspaceName: workspace.name, renamed: true });
    },

    'workflow.status': async (ctx, action) => {
        const workspaceName = requireWorkspaceName(action);
        const workspace = ctx.workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {
            return replyAction(action, { workspaceName, exists: false, active: false });
        }
        if (workspace.name !== workspace.workflow.name) {
            throw new DslRuntimeError('workspace/workflow identity mismatch', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const active = ctx.workspaceRegistry.getActiveWorkspace()?.name === workspaceName;
        return replyAction(action, { workspaceName, exists: true, active });
    },

    'workflow.record.save': async (ctx, action) => {
        const workspaceName = requireWorkspaceName(action);
        const payload = (action.payload || {}) as { recordingName?: string };
        const workflow = requireWorkspaceWorkflow(ctx, workspaceName);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.resolveTab().name, { workspaceName });
        const recordingName = payload.recordingName || toDefaultRecordingName();
        const artifact: WorkflowRecording = {
            kind: 'recording',
            name: recordingName,
            recording: {
                version: 1,
                recordingName,
                workspaceName,
                entryUrl: bundle.manifest?.entryUrl,
                tabs: (bundle.manifest?.tabs || []).map((item) => ({
                    tabName: item.tabName || item.tabRef,
                    url: item.lastSeenUrl || item.firstSeenUrl,
                })),
                createdAt: Date.now(),
                stepCount: bundle.steps.length,
            },
            steps: bundle.steps,
            stepResolves: {},
        };
        workflow.save(artifact);
        return replyAction(action, { workspaceName, recordingName, stepCount: bundle.steps.length });
    },

    'workflow.record.load': async (ctx, action) => {
        const workspaceName = requireWorkspaceName(action);
        const payload = (action.payload || {}) as { recordingName?: string };
        const workflow = requireWorkspaceWorkflow(ctx, workspaceName);
        const recordingName = (payload.recordingName || '').trim();
        if (!recordingName) {
            throw new DslRuntimeError('recordingName is required', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const loaded = workflow.get(recordingName, RECORDING_DUMMY);
        if (!loaded || loaded.kind !== 'recording') {
            throw new DslRuntimeError(`recording not found: ${recordingName}`, ERROR_CODES.ERR_BAD_ARGS);
        }
        return replyAction(action, {
            workspaceName,
            recordingName,
            stepCount: loaded.steps.length,
            loaded: true,
        });
    },

    'workflow.dsl.get': async (ctx, action) => {
        const workspaceName = requireWorkspaceName(action);
        const payload = (action.payload || {}) as { dslName?: string };
        const workflow = requireWorkspaceWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || resolveDefaultDslName(workflow);
        const dsl = requireDsl(workflow, dslName);
        return replyAction(action, { workspaceName, dslName, content: dsl.content });
    },

    'workflow.dsl.save': async (ctx, action) => {
        const workspaceName = requireWorkspaceName(action);
        const payload = (action.payload || {}) as { dslName?: string; content?: string };
        if (typeof payload.content !== 'string') {
            throw new DslRuntimeError('workflow.dsl.save requires content', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const workflow = requireWorkspaceWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || resolveDefaultDslName(workflow);
        workflow.save({ kind: 'dsl', name: dslName, content: payload.content });
        return replyAction(action, { workspaceName, dslName, saved: true });
    },

    'workflow.dsl.test': async (ctx, action) => {
        const workspaceName = requireWorkspaceName(action);
        const payload = (action.payload || {}) as { dslName?: string; input?: Record<string, unknown> };
        if (!ctx.runStepsDeps) {
            throw new DslRuntimeError('run steps deps not initialized for workflow.dsl.test', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const workflow = requireWorkspaceWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || resolveDefaultDslName(workflow);
        const dsl = requireDsl(workflow, dslName);
        const runResult = await runDslSource(dsl.content, {
            workspaceName,
            deps: ctx.runStepsDeps,
            input: payload.input || {},
            checkpointProvider: createCheckpointProvider(workflow),
        });
        return replyAction(action, {
            ok: true,
            output: runResult.scope.output,
            diagnostics: runResult.diagnostics,
            workspaceName,
        });
    },

    'workflow.releaseRun': async (ctx, action) => {
        const workspaceName = requireWorkspaceName(action);
        const payload = (action.payload || {}) as { dslName?: string; input?: Record<string, unknown> };
        if (!ctx.runStepsDeps) {
            throw new DslRuntimeError('run steps deps not initialized for workflow.releaseRun', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const workflow = requireWorkspaceWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || resolveDefaultDslName(workflow);
        const dsl = requireDsl(workflow, dslName);
        const runResult = await runDslSource(dsl.content, {
            workspaceName,
            deps: ctx.runStepsDeps,
            input: payload.input || {},
            checkpointProvider: createCheckpointProvider(workflow),
        });
        return replyAction(action, {
            workspaceName,
            output: runResult.scope.output,
            diagnostics: runResult.diagnostics,
        });
    },
};
