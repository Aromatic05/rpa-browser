/**
 * Product mount — the content-surface entry that wires the product controller
 * to the product shell. Idempotent: the second call returns a passive handle and
 * never starts a second controller or panel. Developer mode stays a separate,
 * in-panel surface; the legacy debug panel only loads behind an explicit flag.
 *
 * The authoring bridge reuses the mature capabilities as-is: the structured
 * checkpoint recorder (procedure/recovery), the generic `record.*` demonstration
 * flow, and the existing Annotator Canvas session. This module only observes
 * real action outcomes and forwards them to the product controller; it never
 * re-implements an editor or fakes authoring state.
 */
import type { Action } from '../shared/types.js';
import { button, muted, sectionTitle } from '../product/components/common.js';
import { mountProductUI, type ProductUIHandle } from '../product/shell/mount.js';
import type { BusinessArea } from '../product/model/contracts.js';
import { createProductMessageClient, type ProductBackendClient } from '../shared/product_transport.js';
import { mountCheckpointRecorderUI, type CheckpointRecorderUIHandle } from './checkpoint_recorder_ui.js';
import {
    createProductController,
    type AuthoringActionNotice,
    type ProductAuthoringBridge,
    type ProductControllerHandle,
    type StructuredTeachSnapshot,
} from './product_controller.js';

export type ProductMountOptions = {
    workspaceName: string;
    now?: () => number;
    /** Action dispatcher used for real authoring actions (`record.*`,
     *  `checkpoint.record.*`) against the current tab's workspace. */
    dispatchAction: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
    /** Opens the existing Annotator Canvas session; resolves true only when the
     *  canvas really opened. */
    openAnnotator?: (profileName?: string) => Promise<boolean> | boolean;
    closeAnnotator?: () => void;
    /** Entity-rule preview through the existing annotator session controller. */
    previewCheckpointEntityRule?: (selection: {
        profileName: string;
        businessTag: string;
        entityKind: 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';
    } | null) => void | Promise<void>;
    /** Injectable for tests; defaults to the real shell mount + message client. */
    mountProductUIImpl?: typeof mountProductUI;
    client?: ProductBackendClient;
};

export type ProductMountHandle = {
    refresh: () => Promise<void>;
    onPageChanged: () => void;
    setWorkspace: (workspaceName: string) => void;
    unmount: () => void;
    /** Forwards one observed authoring action outcome (recorder/annotator) to
     *  the product controller projection. */
    noteAuthoringAction: (notice: AuthoringActionNotice) => void;
    /** Truthful annotator canvas open/close signal. */
    noteAnnotateCanvas: (open: boolean) => void;
};

const passiveHandle = (): ProductMountHandle => ({
    refresh: () => Promise.resolve(),
    onPageChanged: () => undefined,
    setWorkspace: () => undefined,
    unmount: () => undefined,
    noteAuthoringAction: () => undefined,
    noteAnnotateCanvas: () => undefined,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const asAction = (value: unknown): Action | null =>
    isRecord(value) && typeof value.type === 'string' ? (value as unknown as Action) : null;

const actionSucceeded = (action: Action | null): action is Action =>
    action !== null && !action.type.endsWith('.failed');

const actionPayload = (action: Action | null): Record<string, unknown> | undefined =>
    action && isRecord(action.payload) ? action.payload : undefined;

/** Projects the recorder's entity-rule options into the bounded business-area
 *  list (user-visible labels + coarse counts only; the selector stays opaque). */
const businessAreasFrom = (payload: Record<string, unknown>): BusinessArea[] => {
    if (!Array.isArray(payload.entityRules)) {return [];}
    return payload.entityRules.flatMap((item): BusinessArea[] => {
        if (!isRecord(item)
            || typeof item.profileName !== 'string'
            || typeof item.businessTag !== 'string'
            || typeof item.label !== 'string') {return [];}
        const fields = Array.isArray(item.fields) ? item.fields.length : 0;
        const actions = Array.isArray(item.actions) ? item.actions.length : 0;
        const rowActions = Array.isArray(item.rowActions) ? item.rowActions.length : 0;
        return [{
            profileName: item.profileName,
            label: item.label,
            entityCount: fields + actions + rowActions,
            selector: `${item.profileName}\u0000${item.businessTag}`,
        }];
    });
};

const parseStructuredSnapshot = (payload: Record<string, unknown>): StructuredTeachSnapshot | null => {
    const status = payload.status;
    if (status !== 'idle' && status !== 'recording' && status !== 'review') {return null;}
    const kind = payload.kind === 'recovery'
        ? 'recovery' as const
        : payload.kind === 'demonstration'
            ? 'demonstration' as const
            : 'procedure' as const;
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    const stepSummaries = steps.flatMap((step) =>
        isRecord(step) && typeof step.label === 'string' && step.label ? [step.label] : []);
    const entityRule = isRecord(payload.entityRule) ? payload.entityRule : undefined;
    const selectedSelector = entityRule
        && typeof entityRule.profileName === 'string'
        && typeof entityRule.businessTag === 'string'
        ? `${entityRule.profileName}\u0000${entityRule.businessTag}`
        : undefined;
    return {
        status,
        kind,
        stepCount: typeof payload.stepCount === 'number' ? payload.stepCount : stepSummaries.length,
        stepSummaries,
        businessAreas: businessAreasFrom(payload),
        ...(selectedSelector ? {selectedSelector} : {}),
    };
};

export type BuildAuthoringBridgeResult = ProductAuthoringBridge & {dispose: () => void};

export const buildAuthoringBridge = (
    options: ProductMountOptions,
    notify: (notice: AuthoringActionNotice) => void,
): BuildAuthoringBridgeResult => {
    let recorder: CheckpointRecorderUIHandle | null = null;
    let recorderHost: HTMLElement | null = null;
    let demoActive: 'recording' | 'review' | null = null;

    const ensureRecorder = (): CheckpointRecorderUIHandle => {
        if (recorder) {return recorder;}
        recorderHost = document.createElement('div');
        recorderHost.id = 'rpa-product-authoring';
        recorderHost.setAttribute('data-rpa-snapshot-ignore', 'true');
        document.documentElement.appendChild(recorderHost);
        const recorderShadow = recorderHost.attachShadow({ mode: 'open' });
        const surface = document.createElement('div');
        recorderShadow.appendChild(surface);
        const launchers = document.createElement('div');
        recorder = mountCheckpointRecorderUI({
            launchers,
            surface,
            sendAction: async (type, payload) => {
                const reply = asAction(await options.dispatchAction(type, payload));
                notify({
                    type,
                    ok: actionSucceeded(reply),
                    ...(payload ? {payload} : {}),
                    ...(actionPayload(reply) ? {reply: actionPayload(reply)} : {}),
                });
                return reply ?? {v: 1, id: '', type: `${type}.failed`};
            },
            ...(options.previewCheckpointEntityRule
                ? {
                    onEntityRulePreview: async (selection) => {
                        await options.previewCheckpointEntityRule?.(selection ?? null);
                    },
                }
                : {}),
        });
        return recorder;
    };

    /** Dispatches one non-recorder authoring action and reports the real
     *  outcome to the controller projection. */
    const dispatchObserved = async (
        type: string,
        payload?: Record<string, unknown>,
    ): Promise<{ok: boolean; payload?: Record<string, unknown>}> => {
        const reply = asAction(await options.dispatchAction(type, payload ?? {}));
        const ok = actionSucceeded(reply);
        notify({
            type,
            ok,
            ...(payload ? {payload} : {}),
            ...(actionPayload(reply) ? {reply: actionPayload(reply)} : {}),
        });
        return {ok, ...(actionPayload(reply) ? {payload: actionPayload(reply)} : {})};
    };

    return {
        beginStructuredTeach: (kind, selector) => {
            void ensureRecorder().begin(kind, selector);
        },
        stopStructuredTeach: () => {
            void ensureRecorder().stop();
        },
        saveStructuredTeach: () => {
            void ensureRecorder().save();
        },
        discardStructuredTeach: () => {
            if (recorder) {void recorder.cancel();}
        },
        readStructuredTeachState: async () => {
            const reply = asAction(await options.dispatchAction('checkpoint.record.get', {}));
            const payload = actionPayload(reply);
            return actionSucceeded(reply) && payload ? parseStructuredSnapshot(payload) : null;
        },
        startDemonstration: () => {
            void (async () => {
                const result = await dispatchObserved('record.start', {});
                if (result.ok) {demoActive = 'recording';}
            })();
        },
        stopDemonstration: () => {
            void (async () => {
                const result = await dispatchObserved('record.stop', {});
                if (result.ok) {demoActive = 'review';}
            })();
        },
        saveDemonstration: () => {
            void (async () => {
                const result = await dispatchObserved('record.save', {});
                if (result.ok) {demoActive = null;}
            })();
        },
        discardDemonstration: () => {
            void (async () => {
                const result = await dispatchObserved('record.clear', {});
                if (result.ok) {demoActive = null;}
            })();
        },
        readDemonstrationState: async () => {
            if (demoActive === 'recording') {return null;}
            const reply = asAction(await options.dispatchAction('record.get', {}));
            const payload = actionPayload(reply);
            const unsaved = payload && isRecord(payload.unsaved) ? payload.unsaved : undefined;
            const stepCount = typeof unsaved?.stepCount === 'number' ? unsaved.stepCount : 0;
            if (!actionSucceeded(reply)) {return null;}
            if (stepCount > 0) {
                demoActive = 'review';
                return {status: 'review', stepCount};
            }
            demoActive = null;
            return {status: 'idle', stepCount: 0};
        },
        openAnnotator: async (profileName) => {
            const opened = await options.openAnnotator?.(profileName);
            return opened ?? false;
        },
        closeAnnotator: () => {
            options.closeAnnotator?.();
        },
        endLinkedTeach: () => {
            if (recorder) {void recorder.cancel();}
            if (demoActive === 'recording') {
                void (async () => {
                    await dispatchObserved('record.stop', {}).catch(() => undefined);
                    await dispatchObserved('record.clear', {}).catch(() => undefined);
                    demoActive = null;
                })();
                return;
            }
            if (demoActive === 'review') {
                void dispatchObserved('record.clear', {}).catch(() => undefined);
                demoActive = null;
            }
        },
        dispose: () => {
            recorder?.unmount();
            recorder = null;
            recorderHost?.remove();
            recorderHost = null;
        },
    };
};

const renderDeveloperSurface = (root: HTMLElement, controller: ProductControllerHandle): void => {
    root.dataset.rpaProductDevSurface = 'true';
    root.append(sectionTitle('Developer mode'));
    root.append(
        muted(
            'Provider, model, execution mode, session ids, raw reports and internal actions live here — none of it is part of the ordinary product surface.',
        ),
    );
    const override = controller.getView().activeTask?.devOverride;
    if (override?.model || override?.executionMode) {
        const parts: string[] = [];
        if (override.model) {
            parts.push(`model=${override.model}`);
        }
        if (override.executionMode) {
            parts.push(`mode=${override.executionMode}`);
        }
        root.append(muted(`Dev override active: ${parts.join(' · ')}`));
    }
    const row = document.createElement('div');
    row.className = 'rpa-row';
    row.append(
        button(
            'Enable legacy debug panel',
            () => {
                void (async () => {
                    await chrome.storage.local.set({ rpaProductDevMode: true });
                    location.reload();
                })();
            },
            'ghost',
            { dataAction: 'enable-legacy-debug' },
        ),
    );
    root.append(row);
};

export const mountProductFromContent = (options: ProductMountOptions): ProductMountHandle => {
    const existing = document.getElementById('rpa-product-panel');
    if (existing) {
        return passiveHandle();
    }
    const mountProductUIImpl = options.mountProductUIImpl ?? mountProductUI;
    const client = options.client ?? createProductMessageClient();
    let controllerRef: ProductControllerHandle | null = null;
    const notify = (notice: AuthoringActionNotice): void => {
        controllerRef?.noteAuthoringAction(notice);
    };
    const bridge = buildAuthoringBridge(options, notify);
    const controller = createProductController({
        client,
        workspace: options.workspaceName,
        now: options.now,
        authoring: bridge,
    });
    controllerRef = controller;
    const uiHandle: ProductUIHandle = mountProductUIImpl({
        view: controller.getView(),
        commands: controller.commands,
        now: options.now,
        renderDeveloperSurface: (root) => {
            renderDeveloperSurface(root, controller);
        },
    });
    const unsubscribe = controller.subscribe((view) => {
        uiHandle.setView(view);
    });
    controller.start();

    let unmounted = false;
    return {
        refresh: async () => {
            if (unmounted) {
                return;
            }
            await controller.refresh();
        },
        onPageChanged: () => {
            if (unmounted) {
                return;
            }
            void controller.refresh();
        },
        setWorkspace: () => {
            if (unmounted) {
                return;
            }
            void controller.refresh();
        },
        noteAuthoringAction: (notice) => {
            if (!unmounted) {controller.noteAuthoringAction(notice);}
        },
        noteAnnotateCanvas: (open) => {
            if (!unmounted) {controller.noteAnnotateCanvas(open);}
        },
        unmount: () => {
            if (unmounted) {
                return;
            }
            unmounted = true;
            bridge.dispose();
            unsubscribe();
            controller.stop();
            uiHandle.unmount();
        },
    };
};
