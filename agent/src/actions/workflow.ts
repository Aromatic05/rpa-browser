import fs from 'node:fs';
import path from 'node:path';
import { replyAction } from './action_protocol';
import type { ActionHandler } from './execute';
import { loadWorkflow, runWorkflow } from '../workflow';
import { resolveWorkflowWorkspace } from '../workflow/workspace_binding';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import { runDslSource } from '../dsl/runtime';
import { getRecordingBundle } from '../record/recording';
import { saveWorkflowRecordingArtifacts } from '../record/persistence';
import type { DslCheckpointProvider } from '../dsl/emit';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import YAML from 'yaml';
import { validateCheckpointResolveFileForSerialization, validateSingleCheckpointFileForSerialization, type CheckpointResolveFile, type SingleCheckpointFile } from '../runner/serialization/types';

const DEFAULT_ARTIFACTS_ROOT = path.resolve(process.cwd(), 'agent/.artifacts');
const DEFAULT_WORKFLOWS_DIR = path.resolve(DEFAULT_ARTIFACTS_ROOT, 'workflows');

const toWorkflowWorkspaceId = (scene: string): string => `workflow:${scene}`;

const countSubdirs = (dir: string): number => {
    if (!fs.existsSync(dir)) {return 0;}
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
};

const restoreWorkflowWorkspace = async (
    ctx: Parameters<ActionHandler>[0],
    workspaceId: string,
): Promise<{ workspaceId: string; tabId: string; tabToken: string }> => {
    const target = ctx.pageRegistry.listWorkspaces().find((item) => item.workspaceId === workspaceId);
    if (!target) {
        throw new Error(`workspace not found: ${workspaceId}`);
    }
    const tabId = target.activeTabId || (await ctx.pageRegistry.createTab(workspaceId));
    ctx.pageRegistry.setActiveWorkspace(workspaceId);
    ctx.pageRegistry.setActiveTab(workspaceId, tabId);
    return {
        workspaceId,
        tabId,
        tabToken: ctx.pageRegistry.resolveTabToken({ workspaceId, tabId }),
    };
};

const toDefaultRecordingName = (now = new Date()): string => {
    const y = String(now.getFullYear());
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `recording-${y}${m}${d}-${hh}${mm}${ss}`;
};

const createWorkflowCheckpointProvider = (
    scene: string,
    checkpoints: Array<{ id: string; checkpointPath: string; checkpointResolvePath: string }>,
): DslCheckpointProvider => {
    const checkpointsById = new Map<string, Checkpoint>();
    const resolvesById = new Map<string, Record<string, StepResolve>>();

    for (const entry of checkpoints) {
        if (!fs.existsSync(entry.checkpointPath)) {
            throw new DslRuntimeError(
                `workflow checkpoint not found: scene=${scene} path=${entry.checkpointPath}`,
                'ERR_WORKFLOW_CHECKPOINT_NOT_FOUND',
            );
        }
        const checkpointFile = YAML.parse(fs.readFileSync(entry.checkpointPath, 'utf8')) as SingleCheckpointFile;
        validateSingleCheckpointFileForSerialization(checkpointFile);
        checkpointsById.set(entry.id, checkpointFile.checkpoint);

        if (fs.existsSync(entry.checkpointResolvePath)) {
            const resolveFile = YAML.parse(fs.readFileSync(entry.checkpointResolvePath, 'utf8')) as CheckpointResolveFile;
            validateCheckpointResolveFileForSerialization(resolveFile);
            resolvesById.set(entry.id, resolveFile.resolves || {});
        }
    }

    return {
        getCheckpoint: (id: string) => {
            if (!checkpointsById.has(id)) {
                throw new DslRuntimeError(
                    `workflow checkpoint not declared: scene=${scene} checkpoint=${id}`,
                    'ERR_WORKFLOW_CHECKPOINT_NOT_DECLARED',
                );
            }
            return checkpointsById.get(id) || null;
        },
        getCheckpointResolves: (id: string) => resolvesById.get(id) || null,
    };
};

export const workflowHandlers: Record<string, ActionHandler> = {
    'workflow.list': async (_ctx, action) => {
        const workflows: Array<{
            scene: string;
            id: string;
            name?: string;
            entryDsl: string;
            entryInputs?: string;
            workspaceBinding?: string;
            recordCount: number;
            checkpointCount: number;
        }> = [];
        const diagnostics: Array<{ scene: string; code: string; message: string }> = [];

        if (fs.existsSync(DEFAULT_WORKFLOWS_DIR)) {
            const scenes = fs
                .readdirSync(DEFAULT_WORKFLOWS_DIR, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();

            for (const scene of scenes) {
                try {
                    const loaded = loadWorkflow(scene, DEFAULT_WORKFLOWS_DIR);
                    workflows.push({
                        scene,
                        id: loaded.manifest.id,
                        name: loaded.manifest.name,
                        entryDsl: loaded.manifest.entry.dsl,
                        entryInputs: loaded.manifest.entry.inputs,
                        workspaceBinding: loaded.manifest.workspace?.binding,
                        recordCount: countSubdirs(path.join(loaded.rootDir, 'records')),
                        checkpointCount: countSubdirs(path.join(loaded.rootDir, 'checkpoints')),
                    });
                } catch (error) {
                    diagnostics.push({
                        scene,
                        code: error instanceof DslRuntimeError ? error.code : 'ERR_WORKFLOW_INVALID_MANIFEST',
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }

        return replyAction(action, { workflows, diagnostics });
    },

    'workflow.open': async (ctx, action) => {
        const payload = (action.payload || {}) as { scene?: string };
        if (!payload.scene) {
            throw new DslRuntimeError('workflow.open requires scene', 'ERR_BAD_ARGS');
        }
        const loaded = loadWorkflow(payload.scene, DEFAULT_WORKFLOWS_DIR);
        const resolved = await resolveWorkflowWorkspace(
            {
                pageRegistry: ctx.pageRegistry,
                restoreWorkspace: async (workspaceId) => await restoreWorkflowWorkspace(ctx, workspaceId),
            },
            {
                scene: payload.scene,
                binding: loaded.workspaceBinding,
            },
        );

        return replyAction(action, {
            scene: payload.scene,
            workflowRoot: loaded.rootDir,
            workspaceId: resolved.workspaceId,
            tabId: resolved.tabId,
            tabToken: resolved.tabToken,
            entryUrl: loaded.workspaceBinding?.workspace.entryUrl,
        });
    },

    'workflow.status': async (ctx, action) => {
        const payload = (action.payload || {}) as { scene?: string };
        if (!payload.scene) {
            throw new DslRuntimeError('workflow.status requires scene', 'ERR_BAD_ARGS');
        }
        const workspaceId = toWorkflowWorkspaceId(payload.scene);
        const exists = ctx.pageRegistry.listWorkspaces().some((item) => item.workspaceId === workspaceId);
        const active = ctx.pageRegistry.getActiveWorkspace()?.workspaceId === workspaceId;
        return replyAction(action, { scene: payload.scene, workspaceId, exists, active });
    },

    'workflow.record.save': async (ctx, action) => {
        const payload = (action.payload || {}) as { scene?: string; recordingName?: string };
        if (!payload.scene) {
            throw new DslRuntimeError('workflow.record.save requires scene', 'ERR_BAD_ARGS');
        }
        const workspaceId = toWorkflowWorkspaceId(payload.scene);
        const currentWorkspaceId = action.scope?.workspaceId || ctx.pageRegistry.getActiveWorkspace()?.workspaceId || '';
        if (currentWorkspaceId !== workspaceId) {
            throw new DslRuntimeError(
                `workflow workspace mismatch: expected=${workspaceId} actual=${currentWorkspaceId || 'none'}`,
                'ERR_WORKFLOW_WORKSPACE_RESOLVE_FAILED',
            );
        }
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, { workspaceId });
        const recordingName = payload.recordingName || toDefaultRecordingName();
        await saveWorkflowRecordingArtifacts({
            artifactsRootDir: DEFAULT_ARTIFACTS_ROOT,
            scene: payload.scene,
            recordingName,
            workspaceId,
            entryUrl: bundle.manifest?.entryUrl,
            tabs: (bundle.manifest?.tabs || []).map((item) => ({ tabId: item.tabId || item.tabRef, url: item.lastSeenUrl || item.firstSeenUrl })),
            steps: bundle.steps,
        });
        return replyAction(action, { scene: payload.scene, recordingName, stepCount: bundle.steps.length });
    },

    'workflow.dsl.get': async (_ctx, action) => {
        const payload = (action.payload || {}) as { scene?: string };
        if (!payload.scene) {
            throw new DslRuntimeError('workflow.dsl.get requires scene', 'ERR_BAD_ARGS');
        }
        const loaded = loadWorkflow(payload.scene, DEFAULT_WORKFLOWS_DIR);
        return replyAction(action, {
            scene: payload.scene,
            dslPath: loaded.dslPath,
            content: loaded.dslSource,
        });
    },

    'workflow.dsl.save': async (_ctx, action) => {
        const payload = (action.payload || {}) as { scene?: string; content?: string };
        if (!payload.scene || typeof payload.content !== 'string') {
            throw new DslRuntimeError('workflow.dsl.save requires scene and content', 'ERR_BAD_ARGS');
        }
        const loaded = loadWorkflow(payload.scene, DEFAULT_WORKFLOWS_DIR);
        fs.writeFileSync(loaded.dslPath, payload.content, 'utf8');
        return replyAction(action, { scene: payload.scene, dslPath: loaded.dslPath, saved: true });
    },

    'workflow.dsl.test': async (ctx, action) => {
        const payload = (action.payload || {}) as { scene?: string; input?: Record<string, unknown> };
        if (!payload.scene) {
            throw new DslRuntimeError('workflow.dsl.test requires scene', 'ERR_BAD_ARGS');
        }
        if (!ctx.runStepsDeps) {
            throw new DslRuntimeError('run steps deps not initialized for workflow.dsl.test', 'ERR_BAD_ARGS');
        }
        const loaded = loadWorkflow(payload.scene, DEFAULT_WORKFLOWS_DIR);
        await resolveWorkflowWorkspace(
            {
                pageRegistry: ctx.pageRegistry,
                restoreWorkspace: async (workspaceId) => await restoreWorkflowWorkspace(ctx, workspaceId),
            },
            {
                scene: payload.scene,
                binding: loaded.workspaceBinding,
            },
        );
        const checkpointProvider = createWorkflowCheckpointProvider(payload.scene, loaded.checkpoints);
        const input = (payload.input || loaded.inputsExample || {}) as Record<string, unknown>;
        const runResult = await runDslSource(loaded.dslSource, {
            workspaceId: toWorkflowWorkspaceId(payload.scene),
            deps: ctx.runStepsDeps,
            input,
            checkpointProvider,
        });
        return replyAction(action, {
            ok: true,
            output: runResult.scope.output,
            diagnostics: runResult.diagnostics,
            workspaceId: toWorkflowWorkspaceId(payload.scene),
        });
    },

    'workflow.releaseRun': async (ctx, action) => {
        const payload = (action.payload || {}) as { scene?: string; input?: Record<string, unknown> };
        if (!payload.scene) {
            throw new DslRuntimeError('workflow.releaseRun requires scene', 'ERR_BAD_ARGS');
        }
        if (!ctx.runStepsDeps) {
            throw new DslRuntimeError('run steps deps not initialized for workflow.releaseRun', 'ERR_BAD_ARGS');
        }
        const result = await runWorkflow(
            {
                scene: payload.scene,
                input: payload.input,
            },
            {
                pageRegistry: ctx.pageRegistry,
                restoreWorkspace: async (workspaceId) => await restoreWorkflowWorkspace(ctx, workspaceId),
                runStepsDeps: ctx.runStepsDeps,
                workflowsDir: DEFAULT_WORKFLOWS_DIR,
            },
        );
        return replyAction(action, {
            ok: true,
            output: result.scope.output,
            diagnostics: result.diagnostics,
            workspaceId: result.workspaceId,
            tabId: result.tabId,
            tabToken: result.tabToken,
        });
    },
};
