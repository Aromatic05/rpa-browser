import type { Locator, Page } from 'playwright';
import { resolveExecutableLocator } from '../../../indexes/locator/execute';
import { captureControlSnapshot } from '../capture/browser';
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

    const snapshot = await captureControlSnapshot(page);
    const selectorNode = request.selector
        ? await resolveUniqueSelectorNode(page, snapshot, request.selector)
        : undefined;
    if (selectorNode && !selectorNode.ok) {return selectorNode;}

    const nodeId = request.nodeId ?? selectorNode?.nodeId;
    if (!nodeId || !snapshot.observation.nodes[nodeId]) {
        return failed(
            request.nodeId ? 'ERR_STALE' : 'ERR_UNRESOLVED',
            request.nodeId ? 'canonical node no longer exists' : 'selector could not be mapped to a canonical node',
            { nodeId: request.nodeId, selector: request.selector },
        );
    }
    if (request.nodeId && selectorNode?.nodeId && selectorNode.nodeId !== request.nodeId) {
        return failed('ERR_AMBIGUOUS', 'nodeId and selector refer to different canonical nodes', {
            nodeId: request.nodeId,
            selector: request.selector,
            selectorNodeId: selectorNode.nodeId,
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

const resolveUniqueSelectorNode = async (
    page: Page,
    snapshot: ControlSnapshot,
    selector: string,
): Promise<{ ok: true; nodeId: string } | { ok: false; error: AtomicActionFailure }> => {
    let locator: Locator;
    try {
        locator = page.locator(selector);
        const count = await locator.count();
        if (count === 0) {
            return failed('ERR_NOT_FOUND', 'selector did not match a node', { selector });
        }
        if (count > 1) {
            return failed('ERR_AMBIGUOUS', 'selector matched multiple nodes', { selector, count });
        }
    } catch (error) {
        return failed('ERR_BAD_ARGS', 'selector is invalid', {
            selector,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    const identity = await locator.evaluate((node) => {
        if (!(node instanceof Element)) {return {};}
        return {
            id: node.getAttribute('id'),
            testId: node.getAttribute('data-testid'),
            name: node.getAttribute('name'),
            tag: node.tagName.toLowerCase(),
        };
    });
    const matches = Object.keys(snapshot.observation.nodes).filter((nodeId) => {
        const node = snapshot.observation.nodes[nodeId];
        const attrs = snapshot.observation.attributes[nodeId] ?? {};
        if (identity.id !== null && identity.id !== undefined) {return attrs.id === identity.id;}
        if (identity.testId !== null && identity.testId !== undefined) {
            return attrs['data-testid'] === identity.testId;
        }
        if (identity.name !== null && identity.name !== undefined) {
            return node.tag === identity.tag && attrs.name === identity.name;
        }
        return (snapshot.locators.byNodeId[nodeId] ?? []).some((locatorId) =>
            snapshot.locators.locators[locatorId]?.selector === selector);
    });
    if (matches.length === 0) {
        return failed('ERR_UNRESOLVED', 'unique selector has no exact canonical identity', { selector });
    }
    if (matches.length > 1) {
        return failed('ERR_AMBIGUOUS', 'selector identity maps to multiple canonical nodes', {
            selector,
            nodeIds: matches,
        });
    }
    return { ok: true, nodeId: matches[0] };
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
