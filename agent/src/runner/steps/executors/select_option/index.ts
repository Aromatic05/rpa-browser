import { awaitPageBoundBinding } from '../../helpers/runtime_binding';
import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import type { SnapshotResult, UnifiedNode } from '../snapshot/core/types';
import { getLogger } from '../../../../logging/logger';
import { mapTraceError } from '../../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../../helpers/delay';
import { resolveTarget } from '../../helpers/resolve_target';
import { generateSemanticSnapshot } from '../snapshot/pipeline/snapshot';
import type { SelectOptionControl } from './types';
import { badArgs, isStepResult } from './assert';
import { resolveChoiceGroupControl, resolveSelectOptionControl } from './resolve_control';
import { executeNativeSelect } from './native_select';
import { executeRadioGroup, executeCheckboxGroup } from './choice_group';
import { executeCustomSelect } from './custom_select';

export { registerSelectOptionControls } from './register_controls';

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['resolveBinding']>>,
    selector: string,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector });
    if (!scroll.ok) {return scroll;}
    return await binding.traceTools['trace.locator.waitForVisible']({ selector, timeout });
};

export const findTargetNode = (
    snapshot: SnapshotResult,
    step: Step<'browser.select_option'>,
    candidateSelector: string,
    options?: { includeResolveTarget?: boolean },
): UnifiedNode | undefined => {
    const includeResolveTarget = options?.includeResolveTarget !== false;
    const nodeId = step.args.nodeId || (includeResolveTarget ? step.resolve?.hint?.target?.nodeId : undefined);
    if (nodeId) {
        return snapshot.nodeIndex[nodeId];
    }

    const sel = candidateSelector || step.args.selector;
    if (!sel) return undefined;

    const cleanSel = sel.replace(/:visible$/, '');

    for (const [nid, locator] of Object.entries(snapshot.locatorIndex)) {
        if (locator.direct?.query === cleanSel || locator.direct?.fallback === cleanSel) {
            return snapshot.nodeIndex[nid];
        }
    }

    const idMatch = cleanSel.match(/^#([A-Za-z][A-Za-z0-9_-]*)$/);
    if (idMatch) {
        const targetId = idMatch[1];
        for (const [nid, attrs] of Object.entries(snapshot.attrIndex)) {
            if (attrs['id'] === targetId) {
                return snapshot.nodeIndex[nid];
            }
        }
    }

    const testIdMatch = cleanSel.match(/^\[data-testid="([^"]+)"\]$/);
    if (testIdMatch) {
        const targetTestId = testIdMatch[1];
        for (const [nid, attrs] of Object.entries(snapshot.attrIndex)) {
            if (attrs['data-testid'] === targetTestId) {
                return snapshot.nodeIndex[nid];
            }
        }
    }

    return undefined;
};

const isChoiceGroupKind = (kind: string): boolean =>
    kind === 'radio_group' || kind === 'checkbox_group';

const executeResolvedControl = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
    snapshot: SnapshotResult,
): Promise<StepResult> => {
    switch (step.args.kind) {
        case 'native_select':
            return await executeNativeSelect(step, deps, workspaceName, control, snapshot);
        case 'radio_group':
            return await executeRadioGroup(step, deps, workspaceName, control);
        case 'checkbox_group':
            return await executeCheckboxGroup(step, deps, workspaceName, control);
        case 'custom_select':
            return await executeCustomSelect(step, deps, workspaceName, control);
        default:
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_BAD_ARGS',
                    message: `unsupported control kind: ${(control as SelectOptionControl).kind}`,
                    details: { kind: (control as SelectOptionControl).kind },
                },
            };
    }
};

export const executeBrowserSelectOption = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
): Promise<StepResult> => {
    if (!Array.isArray(step.args.values) || step.args.values.length === 0) {
        return badArgs(step.id, 'values must be a non-empty array', { values: step.args.values });
    }

    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;
    const stepLog = getLogger('step');

    if (isChoiceGroupKind(step.args.kind)) {
        const snapshot = await generateSemanticSnapshot(binding.page);
        const targetNode = findTargetNode(snapshot, step, step.args.selector || '', {
            includeResolveTarget: false,
        });

        const anchorControl = resolveSelectOptionControl({
            stepId: step.id,
            stepArgs: step.args,
            targetNode,
            snapshot,
        });

        let control: SelectOptionControl | StepResult = anchorControl;
        if (isStepResult(anchorControl)) {
            stepLog.debug('select_option_control_anchor_miss', {
                stepId: step.id,
                kind: step.args.kind,
                values: step.args.values,
                errorCode: anchorControl.error?.code,
            });
            control = resolveChoiceGroupControl({
                stepId: step.id,
                stepArgs: step.args,
                targetNode,
                snapshot,
            });
            if (!isStepResult(control)) {
                stepLog.debug('select_option_choice_group_control_resolved', {
                    stepId: step.id,
                    kind: step.args.kind,
                    values: step.args.values,
                    controlRef: control.ref,
                });
            }
        }

        if (isStepResult(control)) {
            return control;
        }

        const execResult = await executeResolvedControl(step, deps, workspaceName, control, snapshot);
        if (!execResult.ok) {
            return execResult;
        }

        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.typeDelayMsRange.min,
                deps.config.humanPolicy.typeDelayMsRange.max,
            );
            if (delayMs > 0) {
                await waitForHumanDelay(binding.page, delayMs);
            }
        }

        return { stepId: step.id, ok: true };
    }

    const resolved = await resolveTarget(binding, {
        nodeId: step.args.nodeId,
        selector: step.args.selector,
        resolve: step.resolve,
    }, {
        deps,
        workspaceName,
        reason: 'browser.select_option',
        stepId: step.id,
        stepName: step.name,
    });
    if (!resolved.ok) {
        return { stepId: step.id, ok: false, error: resolved.error };
    }

    const highlightBeforeActionMs = deps.config.waitPolicy.highlightBeforeActionMs;
    let lastError: StepResult['error'] | undefined;

    for (let candidateIndex = 0; candidateIndex < resolved.target.candidates.length; candidateIndex += 1) {
        const candidate = resolved.target.candidates[candidateIndex];

        const visible = await ensureVisible(binding, candidate.selector, timeout);
        if (!visible.ok) {
            lastError = mapTraceError(visible.error);
            continue;
        }

        const highlight = await binding.traceTools['trace.locator.highlight']({
            selector: candidate.selector,
            highlightMs: highlightBeforeActionMs,
            candidateIndex,
            stepId: step.id,
            stepName: step.name,
        });
        if (!highlight.ok) {
            lastError = mapTraceError(highlight.error);
            continue;
        }

        const snapshot = await generateSemanticSnapshot(binding.page);
        const targetNode = findTargetNode(snapshot, step, candidate.selector);

        const controlResult = resolveSelectOptionControl({
            stepId: step.id,
            stepArgs: step.args,
            targetNode,
            snapshot,
            candidateCount: resolved.target.candidates.length,
        });
        if (isStepResult(controlResult)) {
            lastError = controlResult.error;
            continue;
        }
        const control = controlResult;

        const execResult = await executeResolvedControl(step, deps, workspaceName, control, snapshot);

        if (!execResult.ok) {
            lastError = execResult.error;
            continue;
        }

        if (deps.config.humanPolicy.enabled) {
            const delayMs = pickDelayMs(
                deps.config.humanPolicy.typeDelayMsRange.min,
                deps.config.humanPolicy.typeDelayMsRange.max,
            );
            if (delayMs > 0) {
                await waitForHumanDelay(binding.page, delayMs);
            }
        }

        return { stepId: step.id, ok: true };
    }

    return {
        stepId: step.id,
        ok: false,
        error: lastError || {
            code: 'ERR_NOT_FOUND',
            message: 'no select target candidate matched',
        },
    };
};
