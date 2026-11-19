import type { Frame, Locator, Page } from 'playwright';
import { resolveExecutableLocator } from '../../../indexes/locator/execute';
import { captureControlSnapshot, captureLocatorExecutionSnapshot } from '../capture/browser';
import { captureLocatorTarget, captureSelectorTarget } from './selector_capture';
import { captureRecordedFallback, type RecordedTargetOptions } from './recorded_fallback';
import { recordedFrameFailure, resolveRecordedFrame, verifyRecordedFrameTarget } from './recorded_frame';
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
    replayFallback?: true;
};

export type AtomicActionTargetResolution =
    | { ok: true; target: AtomicActionTarget }
    | { ok: false; error: AtomicActionFailure };

export const resolveAtomicActionTarget = async (
    page: Page,
    request: AtomicActionTargetRequest & RecordedTargetOptions,
): Promise<AtomicActionTargetResolution> => {
    let frame: Frame | undefined;
    if (request.framePath !== undefined) {
        const scope = await resolveRecordedFrame(page, request.framePath);
        if (!scope.ok) {return {ok: false, error: scope};}
        frame = scope.frame;
    }
    const exact = await resolveExactTarget(page, request, frame);
    if (exact.ok) {return exact;}
    const captured = await captureRecordedFallback(page, request, exact.error, frame);
    if (!captured) {return exact;}
    if (!captured.ok) {return {ok: false, error: captured};}

    const resolved = await resolveCanonicalTarget(page, captured.snapshot, captured.nodeId, request.requiredCapabilities ?? []);
    if (!resolved.ok) {
        return failed(resolved.error.code, resolved.error.message, {...resolved.error.details, ...captured.details});
    }
    return {ok: true, target: {...resolved.target, replayFallback: true}};
};

const resolveExactTarget = async (
    page: Page,
    request: AtomicActionTargetRequest & RecordedTargetOptions,
    frame?: Frame,
): Promise<AtomicActionTargetResolution> => {
    if (frame) {
        if (!request.selector) {return failed('ERR_NOT_FOUND', 'recorded iframe has no primary selector');}
        if (request.selector.includes('>>')) {return {ok: false, error: recordedFrameFailure('unsupported')};}
        const captured = await captureLocatorTarget(page, frame.locator(request.selector), {});
        if (!captured.ok) {return {ok: false, error: captured};}
        const failure = await verifyRecordedFrameTarget(page, frame, request.framePath ?? [], captured.snapshot.observation, captured.nodeId);
        if (failure) {return {ok: false, error: failure};}
        return await resolveCanonicalTarget(page, captured.snapshot, captured.nodeId, request.requiredCapabilities ?? []);
    }
    if (!request.nodeId && !request.selector) {
        return failed('ERR_BAD_ARGS', 'nodeId or selector is required');
    }

    const selectorCapture = request.selector ? await captureSelectorTarget(page, request.selector) : undefined;
    if (selectorCapture && !selectorCapture.ok) {
        return failed(selectorCapture.code, selectorCapture.message, selectorCapture.details);
    }
    const snapshot = selectorCapture?.snapshot ?? await captureControlSnapshot(page);
    const nodeId = request.nodeId ?? selectorCapture?.nodeId;
    if (!nodeId || !Object.hasOwn(snapshot.observation.nodes, nodeId)) {
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

    return await resolveCanonicalTarget(page, snapshot, nodeId, request.requiredCapabilities ?? []);
};

const resolveCanonicalTarget = async (
    page: Page,
    snapshot: ControlSnapshot,
    nodeId: string,
    required: readonly ControlCapability[],
): Promise<AtomicActionTargetResolution> => {
    const controls = controlsForNode(snapshot, nodeId, required);
    if (required.length > 0 && controls.length === 0) {
        return failed('ERR_UNRESOLVED', 'canonical node does not expose the required capability', {
            nodeId,
            requiredCapabilities: required,
            owningControls: (snapshot.controls.byNodeId[nodeId] ?? [])
                .map((id) => controlSummary(snapshot.controls.controls[id])),
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
    const actionNodeId = chooseActionNode(control, nodeId, required);
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
        { refresh: () => captureLocatorExecutionSnapshot(page) },
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
