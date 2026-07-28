import type { Locator, Page } from 'playwright';
import { resolveExecutableLocator } from '../../../indexes/locator/execute';
import { captureControlSnapshot } from '../capture/browser';
import { captureSelectorTarget } from './selector_capture';
import type {
    AtomicActionFailure,
    AtomicActionTargetRequest,
    ControlCapability,
    ControlComponent,
    ControlSnapshot,
} from '../model/contracts';

export type AtomicActionTarget = {
    snapshot: ControlSnapshot;
    nodeId: string;
    actionNodeId: string;
    locator: Locator;
    control?: ControlComponent;
};

export type AtomicActionTargetResolution =
    | { ok: true; target: AtomicActionTarget }
    | { ok: false; error: AtomicActionFailure };

export const resolveAtomicActionTarget = async (
    page: Page,
    request: AtomicActionTargetRequest,
): Promise<AtomicActionTargetResolution> => {
    if (!request.nodeId && !request.selector) {
        return failed('ERR_BAD_ARGS', 'nodeId or selector is required');
    }

    const selectorCapture = request.selector ? await captureSelectorTarget(page, request.selector) : undefined;
    if (selectorCapture && !selectorCapture.ok) {
        return failed(selectorCapture.code, selectorCapture.message, selectorCapture.details);
    }
    const snapshot = selectorCapture?.snapshot ?? await captureControlSnapshot(page);
    const nodeId = request.nodeId ?? selectorCapture?.nodeId;
    if (!nodeId || !snapshot.observation.nodes[nodeId]) {
        return failed(
            request.nodeId ? 'ERR_STALE' : 'ERR_UNRESOLVED',
            request.nodeId ? 'canonical node no longer exists' : 'selector could not be mapped to a canonical node',
            { nodeId: request.nodeId, selector: request.selector },
        );
    }
    if (request.nodeId && selectorCapture?.nodeId && selectorCapture.nodeId !== request.nodeId) {
        return failed('ERR_AMBIGUOUS', 'nodeId and selector refer to different canonical nodes', {
            nodeId: request.nodeId,
            selector: request.selector,
            selectorNodeId: selectorCapture.nodeId,
        });
    }

    const required = request.requiredCapabilities ?? [];
    const controls = controlsForNode(snapshot, nodeId, required);
    if (required.length > 0 && controls.length === 0) {
        return failed('ERR_UNRESOLVED', 'canonical node does not expose the required capability', {
            nodeId,
            requiredCapabilities: required,
            owningControls: (snapshot.controls.byNodeId[nodeId] ?? []).map((id) => {
                const control = snapshot.controls.controls[id];
                return control ? controlSummary(control) : { id };
            }),
        });
    }
    if (controls.length > 1) {
        return failed('ERR_AMBIGUOUS', 'canonical node belongs to multiple executable controls', {
            nodeId,
            requiredCapabilities: required,
            controls: controls.map(controlSummary),
        });
    }

    const control = controls[0];
    const actionNodeId = control ? chooseActionNode(control, nodeId, required) : nodeId;
    const locatorIds = snapshot.locators.byNodeId[actionNodeId] ?? [];
    if (locatorIds.length === 0) {
        return failed('ERR_UNRESOLVED', 'action node has no canonical locator', { nodeId, actionNodeId });
    }
    if (locatorIds.length > 1) {
        return failed('ERR_AMBIGUOUS', 'action node has multiple canonical locators', {
            nodeId,
            actionNodeId,
            locatorIds,
        });
    }
    const executable = await resolveExecutableLocator(
        page,
        snapshot.observation,
        snapshot.locators,
        locatorIds[0],
    );
    if (executable.status !== 'resolved') {
        return failed(
            executable.status === 'stale'
                ? 'ERR_STALE'
                : executable.status === 'ambiguous'
                    ? 'ERR_AMBIGUOUS'
                    : 'ERR_UNRESOLVED',
            executable.message,
            { nodeId, actionNodeId, locatorId: locatorIds[0] },
        );
    }
    return {
        ok: true,
        target: {
            snapshot,
            nodeId,
            actionNodeId,
            locator: executable.locator,
            control,
        },
    };
};

const controlsForNode = (
    snapshot: ControlSnapshot,
    nodeId: string,
    required: readonly ControlCapability[],
): ControlComponent[] => {
    if (required.length === 0) {return [];}
    const result = (snapshot.controls.byNodeId[nodeId] ?? [])
        .map((id) => snapshot.controls.controls[id])
        .filter((control): control is ControlComponent =>
            Boolean(control) && required.some((capability) => control.capabilities.includes(capability)));
    return [...new Map(result.map((control) => [control.id, control])).values()];
};

const chooseActionNode = (
    control: ControlComponent,
    requestedNodeId: string,
    required: readonly ControlCapability[],
): string => {
    if (required.includes('fill') || required.includes('focus')) {
        return control.controlNodeId ?? requestedNodeId;
    }
    if (required.includes('open_popup')) {
        return control.triggerNodeId ?? control.controlNodeId ?? requestedNodeId;
    }
    if (required.includes('click')) {
        if (control.controlNodeId === requestedNodeId || control.rootNodeId === requestedNodeId) {
            return control.controlNodeId ?? requestedNodeId;
        }
        return control.triggerNodeId ?? control.controlNodeId ?? requestedNodeId;
    }
    return requestedNodeId;
};

const controlSummary = (control: ControlComponent): Record<string, unknown> => ({
    id: control.id,
    ref: control.ref,
    kind: control.kind,
    status: control.status,
    capabilities: control.capabilities,
    rootNodeId: control.rootNodeId,
    controlNodeId: control.controlNodeId,
    triggerNodeId: control.triggerNodeId,
});

const failed = (
    code: AtomicActionFailure['code'],
    message: string,
    details?: Record<string, unknown>,
): { ok: false; error: AtomicActionFailure } => ({
    ok: false,
    error: { ok: false, code, message, details },
});
