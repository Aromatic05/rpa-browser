import { replyAction } from './action_protocol';
import type { ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import { runDslSource } from '../dsl/runtime';
import { getRecordingBundle } from '../record/recording';
import { createWorkflowOnFs, ensureWorkflowOnFs, listWorkflowNames, loadWorkflowFromFs, type Workflow, type WorkflowArtifact, type WorkflowCheckpoint, type WorkflowDsl, type WorkflowRecording } from '../workflow';

const toDefaultRecordingName = (now = new Date()): string => {
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `recording-${y}${m}${d}-${hh}${mm}${ss}`;
};

const resolveWorkspace = (ctx: Parameters<ActionHandler>[0], workspaceName: string): ReturnType<typeof ctx.workspaceRegistry.createWorkspace> => {
    const existing = ctx.workspaceRegistry.getWorkspace(workspaceName);
    if (existing) {
        return existing;
    }
    return ctx.workspaceRegistry.createWorkspace(workspaceName, ensureWorkflowOnFs(workspaceName));
};

const resolveWorkflow = (ctx: Parameters<ActionHandler>[0], workspaceName: string): Workflow => resolveWorkspace(ctx, workspaceName).workflow;

const requireWorkspaceName = (action: Parameters<ActionHandler>[1], payload: Record<string, unknown>): string => {
    const workspaceName = (typeof payload.workspaceName === 'string' ? payload.workspaceName : action.workspaceName) || '';
    if (!workspaceName) {
        throw new DslRuntimeError('workspaceName is required', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
    }
    return workspaceName;
};

const requireDsl = (workflow: Workflow, dslName: string): WorkflowDsl => {
    const artifact = workflow.get(dslName);
    if (!artifact || artifact.kind !== 'dsl') {
        throw new DslRuntimeError(`dsl not found: ${dslName}`, 'ERR_WORKFLOW_DSL_NOT_FOUND');
    }
    return artifact;
};

const requireCheckpointProvider = (workflow: Workflow) => workflow.getCheckpointProvider();

export const workflowHandlers: Record<string, ActionHandler> = {
    'workflow.init': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        const created = ctx.workspaceRegistry.getWorkspace(workspaceName)
            ? false
            : (() => {
                ctx.workspaceRegistry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
                return true;
            })();
        const workflow = resolveWorkflow(ctx, workspaceName);
        return replyAction(action, { workspaceName, workflowName: workflow.name, created });
    },

    'workflow.list': async (_ctx, action) => {
        const workflows = listWorkflowNames().map((name) => {
            const workflow = loadWorkflowFromFs(name);
            return workflow.list();
        });
        return replyAction(action, { workflows });
    },

    'workflow.open': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        const workspace = resolveWorkspace(ctx, workspaceName);
        return replyAction(action, { workspaceName, workflowName: workspace.workflow.name, active: ctx.workspaceRegistry.getActiveWorkspace()?.name === workspaceName });
    },

    'workflow.status': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        const exists = ctx.workspaceRegistry.hasWorkspace(workspaceName);
        const active = ctx.workspaceRegistry.getActiveWorkspace()?.name === workspaceName;
        return replyAction(action, { workspaceName, exists, active });
    },

    'workflow.record.save': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string; recordingName?: string };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        const workflow = resolveWorkflow(ctx, workspaceName);
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
                tabs: (bundle.manifest?.tabs || []).map((item) => ({ tabName: item.tabName || item.tabRef, url: item.lastSeenUrl || item.firstSeenUrl })),
                createdAt: Date.now(),
                stepCount: bundle.steps.length,
            },
            steps: bundle.steps,
            stepResolves: {},
        };
        workflow.save(artifact);
        return replyAction(action, { workspaceName, recordingName, stepCount: bundle.steps.length });
    },

    'workflow.dsl.get': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string; dslName?: string };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        const workflow = resolveWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || workflow.list().entry.dsl;
        const dsl = requireDsl(workflow, dslName);
        return replyAction(action, { workspaceName, dslName, content: dsl.content });
    },

    'workflow.dsl.save': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string; dslName?: string; content?: string };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        if (typeof payload.content !== 'string') {
            throw new DslRuntimeError('workflow.dsl.save requires content', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const workflow = resolveWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || workflow.list().entry.dsl;
        workflow.save({ kind: 'dsl', name: dslName, content: payload.content });
        return replyAction(action, { workspaceName, dslName, saved: true });
    },

    'workflow.dsl.test': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string; dslName?: string; input?: Record<string, unknown> };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        if (!ctx.runStepsDeps) {
            throw new DslRuntimeError('run steps deps not initialized for workflow.dsl.test', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const workflow = resolveWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || workflow.list().entry.dsl;
        const dsl = requireDsl(workflow, dslName);
        const runResult = await runDslSource(dsl.content, {
            workspaceName,
            deps: ctx.runStepsDeps,
            input: payload.input || {},
            checkpointProvider: requireCheckpointProvider(workflow),
        });
        return replyAction(action, {
            ok: true,
            output: runResult.scope.output,
            diagnostics: runResult.diagnostics,
            workspaceName,
        });
    },

    'workflow.releaseRun': async (ctx, action) => {
        const payload = (action.payload || {}) as { workspaceName?: string; dslName?: string; input?: Record<string, unknown> };
        const workspaceName = requireWorkspaceName(action, payload as unknown as Record<string, unknown>);
        if (!ctx.runStepsDeps) {
            throw new DslRuntimeError('run steps deps not initialized for workflow.releaseRun', ERROR_CODES.ERR_WORKFLOW_BAD_ARGS);
        }
        const workflow = resolveWorkflow(ctx, workspaceName);
        const dslName = payload.dslName || workflow.list().entry.dsl;
        const dsl = requireDsl(workflow, dslName);
        const runResult = await runDslSource(dsl.content, {
            workspaceName,
            deps: ctx.runStepsDeps,
            input: payload.input || {},
            checkpointProvider: requireCheckpointProvider(workflow),
        });
        return replyAction(action, {
            workspaceName,
            output: runResult.scope.output,
            diagnostics: runResult.diagnostics,
        });
    },
};
