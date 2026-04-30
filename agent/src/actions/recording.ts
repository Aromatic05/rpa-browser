/**
 * recording action：record / play 相关动作。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { failedAction, replyAction } from './action_protocol';
import type { ActionHandler } from './execute';
import { ACTION_TYPES } from './action_types';
import {
    startRecording,
    stopRecording,
    getRecordingBundle,
    clearRecording,
    ensureRecorder,
    beginReplay,
    endReplay,
    cancelReplay,
    recordStep,
    recordEvent,
    listWorkspaceRecordings,
} from '../record/recording';
import { ERROR_CODES } from './error_codes';
import type { StepUnion } from '../runner/steps/types';
import { setRecorderRuntimeEnabled, type RecorderEvent } from '../record/recorder';
import { replayRecording, type ReplayEvent } from '../play/replay';
import {
    type StepFile,
    type StepResolveFile,
    validateStepFileForSerialization,
    validateStepResolveFileForSerialization,
} from '../runner/serialization/types';
import { resolveWorkflowRecordingDir, saveWorkflowRecordingArtifacts } from '../record/persistence';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ARTIFACTS_ROOT = path.resolve(__dirname, '../../.artifacts');
const DEFAULT_WORKFLOWS_DIR = path.resolve(DEFAULT_ARTIFACTS_ROOT, 'workflows');

const toArtifactManifest = (recordingName: string, workspaceId: string | undefined, bundle: {
    steps: StepUnion[];
    manifest?: { entryUrl?: string; tabs?: Array<{ tabId?: string; tabRef?: string; lastSeenUrl?: string; firstSeenUrl?: string }> };
}) => ({
    version: 1,
    recordingName,
    workspaceId: workspaceId || '',
    entryUrl: bundle.manifest?.entryUrl || '',
    tabs: (bundle.manifest?.tabs || []).map((item) => ({
        tabId: item.tabId || item.tabRef || '',
        url: item.lastSeenUrl || item.firstSeenUrl || '',
    })),
    createdAt: Date.now(),
    stepCount: bundle.steps.length,
});

const toStepFile = (steps: StepUnion[]): StepFile => ({
    version: 1,
    steps: steps.map((step) => ({
        id: step.id,
        name: step.name,
        args: step.args,
    })) as StepFile['steps'],
});

const toSceneFromWorkspaceId = (workspaceId: string): string => {
    if (workspaceId.startsWith('workflow:')) {
        const scene = workspaceId.slice('workflow:'.length).trim();
        if (scene) {return scene;}
    }
    return workspaceId.trim();
};

const ensureWorkflowScaffold = (scene: string): { workflowRoot: string; created: boolean } => {
    const workflowRoot = path.join(DEFAULT_WORKFLOWS_DIR, scene);
    const workflowPath = path.join(workflowRoot, 'workflow.yaml');
    fs.mkdirSync(path.join(workflowRoot, 'records'), { recursive: true });
    fs.mkdirSync(path.join(workflowRoot, 'checkpoints'), { recursive: true });
    let created = false;
    if (!fs.existsSync(workflowPath)) {
        fs.writeFileSync(
            workflowPath,
            ['version: 1', `id: ${scene}`, `name: ${scene}`, 'entry:', '  dsl: dsl/main.dsl', 'records: []', 'checkpoints: []'].join('\n') + '\n',
            'utf8',
        );
        created = true;
    }
    return { workflowRoot, created };
};

const resolveLatestRecordingName = (scene: string): string | null => {
    const recordsRoot = path.join(DEFAULT_WORKFLOWS_DIR, scene, 'records');
    if (!fs.existsSync(recordsRoot)) {return null;}
    const dirs = fs.readdirSync(recordsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (!dirs.length) {return null;}
    dirs.sort((a, b) => {
        const aTs = fs.statSync(path.join(recordsRoot, a.name)).mtimeMs;
        const bTs = fs.statSync(path.join(recordsRoot, b.name)).mtimeMs;
        return bTs - aTs;
    });
    return dirs[0].name;
};

export const recordingHandlers: Record<string, ActionHandler> = {
    'record.start': async (ctx, action) => {
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        await startRecording(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs, {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            entryUrl: ctx.page.url(),
        });
        await ensureRecorder(ctx.recordingState, ctx.page, ctx.tabToken, ctx.navDedupeWindowMs);
        await setRecorderRuntimeEnabled(ctx.page, true);
        return replyAction(action, { pageUrl: ctx.page.url() });
    },
    'record.stop': async (ctx, action) => {
        const workspaceId = action.workspaceName;
        stopRecording(ctx.recordingState, ctx.tabToken, { workspaceId });
        try {
            await setRecorderRuntimeEnabled(ctx.page, false);
        } catch {
            // ignore unavailable page in pageless mode
        }
        if (workspaceId) {
            try {
                const tabs = await ctx.pageRegistry.listTabs(workspaceId);
                for (const tab of tabs) {
                    try {
                        const page = await ctx.pageRegistry.resolvePage({ workspaceId, tabId: tab.tabId });
                        await setRecorderRuntimeEnabled(page, false);
                    } catch {
                        // ignore tabs without live page binding
                    }
                }
            } catch {
                // ignore workspace listing failures
            }
        }
        let pageUrl = '';
        try {
            pageUrl = ctx.page.url();
        } catch {
            // pageless mode: no concrete page target
        }
        return replyAction(action, { pageUrl });
    },
    'record.get': async (ctx, action) => {
        const workspaceId = action.workspaceName;
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, workspaceId ? { workspaceId } : undefined);
        return replyAction(action, { steps: bundle.steps, manifest: bundle.manifest, enrichments: bundle.enrichments });
    },
    'record.save': async (ctx, action) => {
        const workspaceId = action.workspaceName;
        if (!workspaceId) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceId is required for record.save');
        }
        const payload = (action.payload || {}) as { scene?: string; recordingName?: string; includeStepResolve?: boolean };
        const scene = (payload.scene || '').trim() || toSceneFromWorkspaceId(workspaceId);
        if (!scene) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'scene is required for record.save');
        }
        const scaffold = ensureWorkflowScaffold(scene);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, workspaceId ? { workspaceId } : undefined);
        const recordingName = (payload.recordingName || '').trim() || `recording-${Date.now()}`;
        const stepsFile = toStepFile(bundle.steps);
        validateStepFileForSerialization(stepsFile);
        const includeStepResolve = payload.includeStepResolve === true;
        const stepResolveFile: StepResolveFile | undefined = includeStepResolve ? { version: 1, resolves: {} } : undefined;
        if (stepResolveFile) {
            validateStepResolveFileForSerialization(stepResolveFile);
        }
        const recordsDir = await saveWorkflowRecordingArtifacts({
            artifactsRootDir: DEFAULT_ARTIFACTS_ROOT,
            scene,
            recordingName,
            workspaceId,
            entryUrl: bundle.manifest?.entryUrl,
            tabs: (bundle.manifest?.tabs || []).map((item) => ({
                tabId: item.tabId || item.tabRef,
                url: item.lastSeenUrl || item.firstSeenUrl,
            })),
            steps: bundle.steps,
            includeStepResolve,
        });
        return replyAction(action, {
            saved: true,
            scene,
            recordingName,
            workspaceId,
            recordsDir,
            workflowRoot: scaffold.workflowRoot,
            workflowCreated: scaffold.created,
            stepCount: bundle.steps.length,
        });
    },
    'record.load': async (ctx, action) => {
        const workspaceId = action.workspaceName;
        if (!workspaceId) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'workspaceId is required for record.load');
        }
        const payload = (action.payload || {}) as {
            scene?: string;
            recordingName?: string;
        };
        const scene = (payload.scene || '').trim() || toSceneFromWorkspaceId(workspaceId);
        if (!scene) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'scene is required for record.load');
        }
        const scaffold = ensureWorkflowScaffold(scene);
        const recordingName = (payload.recordingName || '').trim() || resolveLatestRecordingName(scene) || '';
        if (!recordingName) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'record.load requires recordingName or existing records');
        }
        const recordsDir = await resolveWorkflowRecordingDir(DEFAULT_ARTIFACTS_ROOT, scene, recordingName);
        const stepsText = fs.readFileSync(path.join(recordsDir, 'steps.yaml'), 'utf8');
        const manifestText = fs.readFileSync(path.join(recordsDir, 'manifest.yaml'), 'utf8');
        const parsedSteps = YAML.parse(stepsText) as StepFile;
        validateStepFileForSerialization(parsedSteps);
        const parsedManifest = YAML.parse(manifestText) as {
            entryUrl?: string;
            tabs?: Array<{ tabId?: string; url?: string }>;
        };
        const stepResolvePath = path.join(recordsDir, 'step_resolve.yaml');
        if (fs.existsSync(stepResolvePath)) {
            const resolveText = fs.readFileSync(stepResolvePath, 'utf8');
            const parsedResolve = YAML.parse(resolveText) as StepResolveFile;
            validateStepResolveFileForSerialization(parsedResolve);
        }
        const recordingToken = crypto.randomUUID();
        const now = Date.now();
        const steps: StepUnion[] = parsedSteps.steps.map((step) => ({
            id: step.id,
            name: step.name,
            args: step.args,
            meta: { source: 'record', ts: now, workspaceId },
        })) as StepUnion[];
        ctx.recordingState.recordings.set(recordingToken, steps);
        ctx.recordingState.recordingEnhancements.set(recordingToken, {});
        ctx.recordingState.recordingManifests.set(recordingToken, {
            recordingToken,
            workspaceId,
            entryUrl: typeof parsedManifest.entryUrl === 'string' ? parsedManifest.entryUrl : undefined,
            startedAt: now,
            tabs: (Array.isArray(parsedManifest.tabs) ? parsedManifest.tabs : []).map((tab) => ({
                tabToken: recordingToken,
                tabRef: tab.tabId || 'main',
                tabId: tab.tabId,
                firstSeenUrl: tab.url,
                lastSeenUrl: tab.url,
                firstSeenAt: now,
                lastSeenAt: now,
            })),
        });
        ctx.recordingState.workspaceLatestRecording.set(workspaceId, recordingToken);
        return replyAction(action, {
            imported: true,
            scene,
            recordingName,
            stepCount: steps.length,
            workspaceId,
            recordingToken,
            recordsDir,
            workflowRoot: scaffold.workflowRoot,
            workflowCreated: scaffold.created,
        });
    },
    'record.clear': async (ctx, action) => {
        const workspaceId = action.workspaceName;
        clearRecording(ctx.recordingState, ctx.tabToken, workspaceId ? { workspaceId } : undefined);
        return replyAction(action, { cleared: true });
    },
    'record.list': async (ctx, action) => {
        const recordings = listWorkspaceRecordings(ctx.recordingState);
        return replyAction(action, { recordings });
    },
    'play.stop': async (ctx, action) => {
        cancelReplay(ctx.recordingState, ctx.tabToken);
        return replyAction(action, { stopped: true });
    },
    'play.start': async (ctx, action) => {
        const payload = (action.payload || {}) as { stopOnError?: boolean };
        const scope = ctx.pageRegistry.resolveScopeFromToken(ctx.tabToken);
        const bundle = getRecordingBundle(ctx.recordingState, ctx.tabToken, { workspaceId: scope.workspaceId });
        const steps = bundle.steps;
        const stopOnError = payload.stopOnError ?? true;
        const recordedWorkspaceId = bundle.manifest?.workspaceId;
        const existingWorkspaceIds = new Set(ctx.pageRegistry.listWorkspaces().map((ws) => ws.workspaceId));
        if (recordedWorkspaceId && !existingWorkspaceIds.has(recordedWorkspaceId)) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'recording workspace not found');
        }
        const replayWorkspaceId = recordedWorkspaceId || scope.workspaceId;
        // Prefer the currently targeted tab when scope is valid in the same workspace.
        // Only create a new tab if we must switch workspace and no tab is available there.
        let initialTabId = scope.workspaceId === replayWorkspaceId ? scope.tabId : '';
        if (!initialTabId) {
            const targetWs = ctx.pageRegistry.listWorkspaces().find((ws) => ws.workspaceId === replayWorkspaceId);
            initialTabId = targetWs?.activeTabId || '';
        }
        if (!initialTabId) {
            initialTabId = await ctx.pageRegistry.createTab(replayWorkspaceId);
        }
        // Never reuse recorded tab token; bind replay to the current runtime tab token.
        if (bundle.manifest?.entryUrl) {
            try {
                const page = await ctx.pageRegistry.resolvePage({ workspaceId: replayWorkspaceId, tabId: initialTabId });
                if (page.url() !== bundle.manifest.entryUrl) {
                    await page.goto(bundle.manifest.entryUrl, { waitUntil: 'domcontentloaded' });
                }
            } catch {
                // ignore preflight navigation failures, replay steps will surface deterministic errors later.
            }
        }
        ctx.pageRegistry.setActiveWorkspace(replayWorkspaceId);
        ctx.pageRegistry.setActiveTab(replayWorkspaceId, initialTabId);
        const initialTabToken = ctx.pageRegistry.resolveTabToken({ workspaceId: replayWorkspaceId, tabId: initialTabId });
        beginReplay(ctx.recordingState, ctx.tabToken);
        const emitPlayEvent = (type: string, payload: Record<string, unknown>) => {
            ctx.emit?.({
                v: 1,
                id: crypto.randomUUID(),
                type,
                workspaceName: replayWorkspaceId,
                payload,
                at: Date.now(),
                traceId: action.traceId,
            });
        };

        const publishReplayEvent = (event: ReplayEvent) => {
            if (event.type === 'step.started') {
                emitPlayEvent(ACTION_TYPES.PLAY_STEP_STARTED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    ...event,
                });
                return;
            }
            if (event.type === 'step.finished') {
                emitPlayEvent(ACTION_TYPES.PLAY_STEP_FINISHED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    ...event,
                });
                return;
            }
            emitPlayEvent(ACTION_TYPES.PLAY_PROGRESS, {
                workspaceId: replayWorkspaceId,
                tabId: initialTabId,
                completed: event.completed,
                total: event.total,
            });
        };

        void (async () => {
            try {
                const replayed = await replayRecording({
                    workspaceId: replayWorkspaceId,
                    initialTabId,
                    initialTabToken,
                    steps,
                    enrichments: bundle.enrichments,
                    recordingManifest: bundle.manifest,
                    stopOnError,
                    replayOptions: ctx.replayOptions,
                    pageRegistry: {
                        listTabs: (workspaceId: string) => ctx.pageRegistry.listTabs(workspaceId),
                        resolveTabIdFromToken: (tabToken: string) => {
                            try {
                                return ctx.pageRegistry.resolveScopeFromToken(tabToken).tabId;
                            } catch {
                                return undefined;
                            }
                        },
                        resolveTabIdFromRef: (tabRef: string) => {
                            return tabRef || undefined;
                        },
                    },
                    isCanceled: () => ctx.recordingState.replayCancel.has(ctx.tabToken),
                    onEvent: publishReplayEvent,
                });
                if (replayed.error?.code === 'ERR_CANCELED') {
                    emitPlayEvent(ACTION_TYPES.PLAY_CANCELED, {
                        workspaceId: replayWorkspaceId,
                        tabId: initialTabId,
                        results: replayed.results,
                    });
                    return;
                }
                if (!replayed.ok && stopOnError) {
                    const firstFailed = replayed.results.find((item) => !item.ok);
                    emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                        workspaceId: replayWorkspaceId,
                        tabId: initialTabId,
                        code: ERROR_CODES.ERR_ASSERTION_FAILED,
                        message: firstFailed?.error?.message || replayed.error?.message || 'replay failed',
                        details: { results: replayed.results, failed: firstFailed?.error || replayed.error },
                    });
                    return;
                }
                emitPlayEvent(ACTION_TYPES.PLAY_COMPLETED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    results: replayed.results,
                });
            } catch (error) {
                emitPlayEvent(ACTION_TYPES.PLAY_FAILED, {
                    workspaceId: replayWorkspaceId,
                    tabId: initialTabId,
                    code: ERROR_CODES.ERR_BAD_ARGS,
                    message: error instanceof Error ? error.message : String(error),
                });
            } finally {
                endReplay(ctx.recordingState, ctx.tabToken);
            }
        })();

        return replyAction(
            action,
            {
                started: true,
                workspaceId: replayWorkspaceId,
                tabId: initialTabId,
                tabToken: initialTabToken,
                stepCount: steps.length,
                stopOnError,
            },
            ACTION_TYPES.PLAY_STARTED,
        );
    },
    'record.event': async (ctx, action) => {
        const payload = action.payload as StepUnion | RecorderEvent | undefined;
        if (!payload) {
            return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'missing record.event payload');
        }

        if (isRawRecorderEventPayload(payload)) {
            await recordEvent(ctx.recordingState, payload, ctx.navDedupeWindowMs, ctx.page);
            return replyAction(action, { accepted: true, mode: 'raw-event' });
        }

        const step = payload;
        const token = ctx.tabToken;
        const scope = ctx.pageRegistry.resolveScopeFromToken(token);
        let currentUrl: string;
        try {
            const targetPage = await ctx.pageRegistry.resolvePage({ workspaceId: scope.workspaceId, tabId: scope.tabId });
            currentUrl = targetPage.url();
        } catch {
            currentUrl = '';
        }
        const normalizedStep: StepUnion = {
            ...step,
            meta: {
                ...step.meta,
                source: step.meta?.source ?? 'record',
                ts: step.meta?.ts ?? Date.now(),
                workspaceId: scope.workspaceId,
                tabId: scope.tabId,
                tabToken: token,
                tabRef: step.meta?.tabRef || scope.tabId,
                urlAtRecord: step.meta?.urlAtRecord || currentUrl || undefined,
            },
        };
        recordStep(ctx.recordingState, token, normalizedStep, ctx.navDedupeWindowMs);
        return replyAction(action, { accepted: true });
    },
};

const isRawRecorderEventPayload = (payload: StepUnion | RecorderEvent): payload is RecorderEvent => {
    const maybe = payload as Partial<RecorderEvent>;
    return typeof maybe.type === 'string' && typeof maybe.tabToken === 'string' && typeof maybe.ts === 'number';
};
