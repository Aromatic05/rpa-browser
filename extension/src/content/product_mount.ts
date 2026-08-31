/**
 * Product mount — the content-surface entry that wires the product controller
 * to the product shell. Idempotent: the second call returns a passive handle and
 * never starts a second controller or panel. Developer mode stays a separate,
 * in-panel surface; the legacy debug panel only loads behind an explicit flag.
 */
import { button, muted, sectionTitle } from '../product/components/common.js';
import { mountProductUI, type ProductUIHandle } from '../product/shell/mount.js';
import { createProductMessageClient, type ProductBackendClient } from '../shared/product_transport.js';
import {
    createProductController,
    type ProductAuthoringBridge,
    type ProductControllerHandle,
} from './product_controller.js';

export type ProductMountOptions = {
    workspaceName: string;
    now?: () => number;
    /** Action dispatcher used to reuse real authoring actions (`record.*`). */
    dispatchAction: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
    openAnnotator?: (profileName?: string) => void;
    /** Injectable for tests; defaults to the real shell mount + message client. */
    mountProductUIImpl?: typeof mountProductUI;
    client?: ProductBackendClient;
};

export type ProductMountHandle = {
    refresh: () => Promise<void>;
    onPageChanged: () => void;
    setWorkspace: (workspaceName: string) => void;
    unmount: () => void;
};

const passiveHandle = (): ProductMountHandle => ({
    refresh: () => Promise.resolve(),
    onPageChanged: () => undefined,
    setWorkspace: () => undefined,
    unmount: () => undefined,
});

const buildAuthoringBridge = (options: ProductMountOptions): ProductAuthoringBridge => {
    let demoStarted = false;
    return {
        openAnnotator: (profileName) => options.openAnnotator?.(profileName),
        closeAnnotator: () => undefined,
        // The product authoring projection/commands are not exposed by the
        // backend yet (spec §19 #7/#13). Only the generic Demonstration flow has
        // a clean existing action bridge (`record.*`); reused without inventing
        // any fake persisted authoring state.
        startTeach: (kind) => {
            if (kind !== 'demonstration') {
                return undefined;
            }
            demoStarted = true;
            return options.dispatchAction('record.start', {});
        },
        stopTeach: () => (demoStarted ? options.dispatchAction('record.stop', {}) : undefined),
        saveTeach: () => (demoStarted ? options.dispatchAction('record.save', {}) : undefined),
        discardTeach: () => {
            if (!demoStarted) {
                return undefined;
            }
            demoStarted = false;
            return options.dispatchAction('record.clear', {});
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
    const controller = createProductController({
        client,
        workspace: options.workspaceName,
        now: options.now,
        authoring: buildAuthoringBridge(options),
    });
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
        unmount: () => {
            if (unmounted) {
                return;
            }
            unmounted = true;
            unsubscribe();
            controller.stop();
            uiHandle.unmount();
        },
    };
};