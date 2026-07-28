import type { Locator, Page } from 'playwright';
import { resolveExecutableLocator } from '../../../indexes/locator/execute';
import type { LocatorIndex } from '../../../indexes/locator/contracts';
import { captureControlSnapshot } from '../capture/browser';
import { resolveControlRef } from '../assembly/build';
import type {
    ControlComponent,
    ControlOption,
    ControlSnapshot,
    SelectOptionActionResult,
    SelectOptionRequest,
} from '../model/contracts';

export type ExecuteSelectOptionOptions = {
    timeoutMs?: number;
};

export const executeSelectOptionOnPage = async (
    page: Page,
    request: SelectOptionRequest,
    options: ExecuteSelectOptionOptions = {},
): Promise<SelectOptionActionResult> => {
    const values = validateValues(request.values);
    if (!values) {
        return failure('ERR_BAD_ARGS', 'values must contain non-empty strings', { values: request.values });
    }

    const initial = await captureControlSnapshot(page);
    const target = await resolveRequestedControl(page, initial, request);
    if (!target.ok) {return target.error;}
    let control = target.control;

    if (control.kind !== request.kind) {
        return failure('ERR_BAD_ARGS', 'control kind does not match request', {
            expectedKind: request.kind,
            actualKind: control.kind,
            controlRef: control.ref,
        });
    }

    if (request.kind === 'custom_select' && !control.capabilities.includes('select_option')) {
        if (!control.capabilities.includes('open_popup')) {
            return failure(
                control.status === 'ambiguous' ? 'ERR_AMBIGUOUS' : 'ERR_UNRESOLVED',
                'custom select cannot be opened from an exact canonical locator',
                controlDetails(control),
            );
        }
        const triggerNodeId = control.triggerNodeId ?? control.controlNodeId;
        if (!triggerNodeId) {
            return failure('ERR_UNRESOLVED', 'custom select has no trigger node', controlDetails(control));
        }
        const trigger = await executableNode(page, initial, triggerNodeId);
        if (!trigger.ok) {return trigger.error;}
        await trigger.locator.click({ timeout: options.timeoutMs });
        const openedResult = await waitForCustomSelectComplete(
            page,
            control.ref,
            options.timeoutMs ?? 3000,
        );
        if (!openedResult.ok) {return openedResult.error;}
        const opened = openedResult.snapshot;
        control = openedResult.control;
        const action = await executeCustomSelect(page, opened, control, values, options.timeoutMs);
        if (!action.ok) {return action;}
        return await verifySelection(page, control.ref, request.kind, values);
    }

    if (!control.capabilities.includes('select_option')) {
        return failure(
            control.status === 'ambiguous' ? 'ERR_AMBIGUOUS' : 'ERR_UNRESOLVED',
            'control does not expose select_option capability',
            controlDetails(control),
        );
    }

    let action: SelectOptionActionResult;
    switch (request.kind) {
        case 'native_select':
            action = await executeNativeSelect(page, initial, control, values, options.timeoutMs);
            break;
        case 'radio_group':
            action = await executeRadioGroup(page, initial, control, values, options.timeoutMs);
            break;
        case 'checkbox_group':
            action = await executeCheckboxGroup(page, initial, control, values, options.timeoutMs);
            break;
        case 'custom_select':
            action = await executeCustomSelect(page, initial, control, values, options.timeoutMs);
            break;
    }
    if (!action.ok) {return action;}
    return await verifySelection(page, control.ref, request.kind, values);
};

const waitForCustomSelectComplete = async (
    page: Page,
    controlRef: string,
    timeoutMs: number,
): Promise<
    | { ok: true; snapshot: ControlSnapshot; control: ControlComponent }
    | { ok: false; error: SelectOptionActionResult }
> => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastControl: ControlComponent | undefined;
    do {
        const snapshot = await captureControlSnapshot(page);
        const resolution = resolveControlRef(snapshot.controls, controlRef);
        if (resolution.status === 'ambiguous') {
            return { ok: false, error: failure('ERR_AMBIGUOUS', 'custom select ref became ambiguous after opening', {
                controlRef,
                candidates: resolution.candidates.map(controlDetails),
            }) };
        }
        if (resolution.status === 'resolved') {
            lastControl = resolution.value;
            if (lastControl.kind === 'custom_select' && lastControl.capabilities.includes('select_option')) {
                return { ok: true, snapshot, control: lastControl };
            }
            if (lastControl.status === 'ambiguous') {
                return { ok: false, error: failure('ERR_AMBIGUOUS', 'custom select popup ownership is ambiguous after opening', controlDetails(lastControl)) };
            }
        }
        if (Date.now() >= deadline) {break;}
        await page.waitForTimeout(50);
    } while (true);
    return { ok: false, error: failure(
        lastControl ? 'ERR_UNRESOLVED' : 'ERR_STALE',
        lastControl
            ? 'custom select did not assemble a complete exact popup after opening'
            : 'custom select disappeared after opening',
        lastControl ? controlDetails(lastControl) : { controlRef },
    ) };
};

const executeNativeSelect = async (
    page: Page,
    snapshot: ControlSnapshot,
    control: ControlComponent,
    values: string[],
    timeoutMs?: number,
): Promise<SelectOptionActionResult> => {
    if (!control.controlNodeId) {
        return failure('ERR_UNRESOLVED', 'native select has no control node', controlDetails(control));
    }
    const matched = matchOptions(control.options, values);
    if (!matched.ok) {return matched.error;}
    const target = await executableNode(page, snapshot, control.controlNodeId);
    if (!target.ok) {return target.error;}
    const selections = matched.options.map((option) =>
        option.value.length > 0 ? { value: option.value } : { label: option.label });
    await target.locator.selectOption(selections, { timeout: timeoutMs });
    return provisional(control);
};

const executeRadioGroup = async (
    page: Page,
    snapshot: ControlSnapshot,
    control: ControlComponent,
    values: string[],
    timeoutMs?: number,
): Promise<SelectOptionActionResult> => {
    if (values.length !== 1) {
        return failure('ERR_BAD_ARGS', 'radio_group requires exactly one value', { values });
    }
    const matched = matchOptions(control.options, values);
    if (!matched.ok) {return matched.error;}
    const target = await executableNode(page, snapshot, matched.options[0].nodeId);
    if (!target.ok) {return target.error;}
    await target.locator.check({ timeout: timeoutMs });
    return provisional(control);
};

const executeCheckboxGroup = async (
    page: Page,
    snapshot: ControlSnapshot,
    control: ControlComponent,
    values: string[],
    timeoutMs?: number,
): Promise<SelectOptionActionResult> => {
    const matched = matchOptions(control.options, values);
    if (!matched.ok) {return matched.error;}
    const selectedNodeIds = new Set(matched.options.map((option) => option.nodeId));
    const targets: Array<{ option: ControlOption; locator: Locator; initialChecked: boolean }> = [];

    for (const option of control.options) {
        const target = await executableNode(page, snapshot, option.nodeId);
        if (!target.ok) {return target.error;}
        try {
            targets.push({
                option,
                locator: target.locator,
                initialChecked: await target.locator.isChecked({ timeout: timeoutMs }),
            });
        } catch (error) {
            return checkboxActionFailure('checkbox group preflight failed', error, {
                controlRef: control.ref,
                nodeId: option.nodeId,
                phase: 'preflight',
            });
        }
    }

    try {
        for (const target of targets) {
            const shouldBeChecked = selectedNodeIds.has(target.option.nodeId);
            if (shouldBeChecked === target.initialChecked) {continue;}
            if (shouldBeChecked) {
                await target.locator.check({ timeout: timeoutMs });
            } else {
                await target.locator.uncheck({ timeout: timeoutMs });
            }
        }
    } catch (error) {
        const rollbackFailures: Array<{ nodeId: string; message: string }> = [];
        for (const target of targets) {
            try {
                const checked = await target.locator.isChecked({ timeout: timeoutMs });
                if (checked === target.initialChecked) {continue;}
                if (target.initialChecked) {
                    await target.locator.check({ timeout: timeoutMs });
                } else {
                    await target.locator.uncheck({ timeout: timeoutMs });
                }
            } catch (rollbackError) {
                rollbackFailures.push({
                    nodeId: target.option.nodeId,
                    message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                });
            }
        }
        return checkboxActionFailure('checkbox group action failed and was rolled back', error, {
            controlRef: control.ref,
            phase: 'apply',
            rollbackComplete: rollbackFailures.length === 0,
            rollbackFailures,
        });
    }

    return provisional(control);
};

const executeCustomSelect = async (
    page: Page,
    snapshot: ControlSnapshot,
    control: ControlComponent,
    values: string[],
    timeoutMs?: number,
): Promise<SelectOptionActionResult> => {
    if (values.length !== 1) {
        return failure('ERR_BAD_ARGS', 'custom_select currently requires exactly one value', { values });
    }
    const matched = matchOptions(control.options, values);
    if (!matched.ok) {return matched.error;}
    const target = await executableNode(page, snapshot, matched.options[0].nodeId);
    if (!target.ok) {return target.error;}
    await target.locator.click({ timeout: timeoutMs });
    return provisional(control);
};

const verifySelection = async (
    page: Page,
    controlRef: string,
    kind: SelectOptionRequest['kind'],
    values: string[],
): Promise<SelectOptionActionResult> => {
    const finalSnapshot = await captureControlSnapshot(page);
    const resolution = resolveControlRef(finalSnapshot.controls, controlRef);
    if (resolution.status === 'missing') {
        return failure('ERR_STALE', 'control disappeared before post-action verification', { controlRef });
    }
    if (resolution.status === 'ambiguous') {
        return failure('ERR_AMBIGUOUS', 'control ref is ambiguous during post-action verification', {
            controlRef,
            candidates: resolution.candidates.map(controlDetails),
        });
    }
    const control = resolution.value;
    if (control.kind !== kind) {
        return failure('ERR_ASSERTION_FAILED', 'control kind changed after action', {
            controlRef,
            expectedKind: kind,
            actualKind: control.kind,
        });
    }
    const matched = matchOptions(control.options, values);
    if (!matched.ok) {return matched.error;}
    const selectedNodeIds = new Set(control.options.filter((option) => option.selected).map((option) => option.nodeId));
    const expectedNodeIds = new Set(matched.options.map((option) => option.nodeId));

    const exact = kind === 'checkbox_group'
        ? setsEqual(selectedNodeIds, expectedNodeIds)
        : [...expectedNodeIds].every((nodeId) => selectedNodeIds.has(nodeId));
    if (!exact) {
        return failure('ERR_ASSERTION_FAILED', 'selected state does not match requested values after recapture', {
            controlRef,
            expectedValues: values,
            selectedValues: control.state.selectedValues,
            selectedLabels: control.state.selectedLabels,
        });
    }
    return {
        ok: true,
        controlRef,
        selectedValues: control.state.selectedValues,
        selectedLabels: control.state.selectedLabels,
        captureRevision: finalSnapshot.observation.identity.captureRevision,
    };
};

const resolveRequestedControl = async (
    page: Page,
    snapshot: ControlSnapshot,
    request: SelectOptionRequest,
): Promise<{ ok: true; control: ControlComponent } | { ok: false; error: SelectOptionActionResult }> => {
    if (request.controlRef) {
        const resolution = resolveControlRef(snapshot.controls, request.controlRef);
        if (resolution.status === 'resolved') {return { ok: true, control: resolution.value };}
        return {
            ok: false,
            error: failure(
                resolution.status === 'ambiguous' ? 'ERR_AMBIGUOUS' : 'ERR_NOT_FOUND',
                resolution.status === 'ambiguous' ? 'control ref is ambiguous' : 'control ref not found',
                { controlRef: request.controlRef },
            ),
        };
    }

    let nodeId = request.nodeId;
    if (request.selector) {
        let locator: Locator;
        try {
            locator = page.locator(request.selector);
            const count = await locator.count();
            if (count === 0) {
                return { ok: false, error: failure('ERR_NOT_FOUND', 'selector did not match a control', { selector: request.selector }) };
            }
            if (count > 1) {
                return { ok: false, error: failure('ERR_AMBIGUOUS', 'selector matched multiple controls', {
                    selector: request.selector,
                    count,
                }) };
            }
        } catch (error) {
            return { ok: false, error: failure('ERR_BAD_ARGS', 'selector is invalid', {
                selector: request.selector,
                error: error instanceof Error ? error.message : String(error),
            }) };
        }
        nodeId = await resolveSelectorNodeId(locator!, snapshot);
        if (!nodeId) {
            return { ok: false, error: failure('ERR_UNRESOLVED', 'selector is not a canonical control locator', {
                selector: request.selector,
            }) };
        }
    }

    if (!nodeId) {
        return { ok: false, error: failure('ERR_BAD_ARGS', 'nodeId, selector, or controlRef is required') };
    }
    const candidates = (snapshot.controls.byNodeId[nodeId] ?? [])
        .map((id) => snapshot.controls.controls[id])
        .filter((component): component is ControlComponent => Boolean(component) && component.kind === request.kind);
    if (candidates.length === 0) {
        return { ok: false, error: failure('ERR_NOT_FOUND', 'node is not owned by the requested control kind', {
            nodeId,
            kind: request.kind,
        }) };
    }
    if (candidates.length > 1) {
        return { ok: false, error: failure('ERR_AMBIGUOUS', 'node belongs to multiple controls of the requested kind', {
            nodeId,
            kind: request.kind,
            candidates: candidates.map(controlDetails),
        }) };
    }
    return { ok: true, control: candidates[0] };
};

const resolveSelectorNodeId = async (locator: Locator, snapshot: ControlSnapshot): Promise<string | undefined> => {
    const identity = await locator.evaluate((node) => ({
        id: node instanceof Element ? node.getAttribute('id') : null,
        testId: node instanceof Element ? node.getAttribute('data-testid') : null,
        tag: node instanceof Element ? node.tagName.toLowerCase() : null,
        name: node instanceof Element ? node.getAttribute('name') : null,
    }));
    const matches = Object.keys(snapshot.observation.nodes).filter((nodeId) => {
        const node = snapshot.observation.nodes[nodeId];
        const attrs = snapshot.observation.attributes[nodeId] ?? {};
        if (identity.id !== null) {return attrs.id === identity.id;}
        if (identity.testId !== null) {return attrs['data-testid'] === identity.testId;}
        if (identity.name !== null) {return node.tag === identity.tag && attrs.name === identity.name;}
        return false;
    });
    return matches.length === 1 ? matches[0] : undefined;
};

const executableNode = async (
    page: Page,
    snapshot: ControlSnapshot,
    nodeId: string,
): Promise<{ ok: true; locator: Locator } | { ok: false; error: SelectOptionActionResult }> => {
    const locatorIds = snapshot.locators.byNodeId[nodeId] ?? [];
    if (locatorIds.length === 0) {
        return { ok: false, error: failure('ERR_UNRESOLVED', 'control node has no canonical locator', { nodeId }) };
    }
    if (locatorIds.length > 1) {
        return { ok: false, error: failure('ERR_AMBIGUOUS', 'control node has multiple canonical locators', { nodeId, locatorIds }) };
    }
    const resolution = await resolveExecutableLocator(page, snapshot.observation, snapshot.locators, locatorIds[0]);
    if (resolution.status === 'resolved') {return { ok: true, locator: resolution.locator };}
    return {
        ok: false,
        error: failure(
            resolution.status === 'stale' ? 'ERR_STALE'
                : resolution.status === 'ambiguous' ? 'ERR_AMBIGUOUS'
                    : 'ERR_UNRESOLVED',
            resolution.message,
            { nodeId },
        ),
    };
};

type OptionMatch =
    | { ok: true; options: ControlOption[] }
    | { ok: false; error: SelectOptionActionResult };

const matchOptions = (options: readonly ControlOption[], values: readonly string[]): OptionMatch => {
    const matched: ControlOption[] = [];
    for (const value of values) {
        const candidates = options.filter((option) => optionMatches(option, value));
        if (candidates.length === 0) {
            return { ok: false, error: failure('ERR_NOT_FOUND', 'option not found', {
                value,
                availableValues: options.map((option) => option.value),
                availableLabels: options.map((option) => option.label),
            }) };
        }
        if (candidates.length > 1) {
            return { ok: false, error: failure('ERR_AMBIGUOUS', 'multiple options matched exactly', {
                value,
                candidates: candidates.map((option) => ({ nodeId: option.nodeId, value: option.value, label: option.label })),
            }) };
        }
        if (candidates[0].disabled) {
            return { ok: false, error: failure('ERR_UNRESOLVED', 'matched option is disabled', {
                value,
                nodeId: candidates[0].nodeId,
                label: candidates[0].label,
            }) };
        }
        matched.push(candidates[0]);
    }
    if (new Set(matched.map((option) => option.nodeId)).size !== matched.length) {
        return { ok: false, error: failure('ERR_AMBIGUOUS', 'multiple requested values matched the same option') };
    }
    return { ok: true, options: matched };
};

const optionMatches = (option: ControlOption, target: string): boolean => {
    const fields = [option.value, option.label, option.text, option.ariaLabel, option.title, option.dataValue, option.dataKey];
    return fields.some((field) => typeof field === 'string' && (field === target || field.trim() === target.trim()));
};

const validateValues = (values: string[]): string[] | undefined => {
    if (!Array.isArray(values) || values.length === 0) {return undefined;}
    if (values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {return undefined;}
    return [...values];
};


const checkboxActionFailure = (
    message: string,
    error: unknown,
    details: Record<string, unknown>,
): SelectOptionActionResult => {
    const cause = error instanceof Error ? error.message : String(error);
    return failure(
        /detached|not attached|resolved to 0 elements/i.test(cause) ? 'ERR_STALE' : 'ERR_UNRESOLVED',
        message,
        { ...details, cause },
    );
};

const provisional = (control: ControlComponent): SelectOptionActionResult => ({
    ok: true,
    controlRef: control.ref,
    selectedValues: control.state.selectedValues,
    selectedLabels: control.state.selectedLabels,
    captureRevision: 0,
});

const failure = (
    code: Extract<SelectOptionActionResult, { ok: false }>['code'],
    message: string,
    details?: Record<string, unknown>,
): SelectOptionActionResult => ({ ok: false, code, message, details });

const controlDetails = (control: ControlComponent): Record<string, unknown> => ({
    id: control.id,
    ref: control.ref,
    kind: control.kind,
    status: control.status,
    rootNodeId: control.rootNodeId,
    ownerNodeId: control.ownerNodeId,
    controlNodeId: control.controlNodeId,
    popupNodeId: control.popupNodeId,
    capabilities: control.capabilities,
});

const setsEqual = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
    left.size === right.size && [...left].every((value) => right.has(value));
