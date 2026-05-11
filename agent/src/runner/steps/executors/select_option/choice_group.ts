import { awaitPageBoundBinding } from '../../helpers/runtime_binding';
import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import { getLogger } from '../../../../logging/logger';
import type { SelectOptionControl, SelectOptionOption } from './types';
import { matchOption, matchOptions } from './option_match';
import { ambiguous, badArgs, assertionFailed, isStepResult, notFound } from './assert';
import type { SnapshotResult } from '../snapshot/core/types';
import { generateSemanticSnapshot } from '../snapshot/pipeline/snapshot';

type Binding = Awaited<ReturnType<RunStepsDeps['runtime']['resolveBinding']>>;

const toSelectOptions = (component: SelectOptionControl['component']): SelectOptionOption[] => {
    const rawOptions = (component.data.options as Array<Record<string, unknown>>) ?? [];
    return rawOptions.map((opt) => ({
        value: String(opt.value ?? ''),
        label: String(opt.label ?? ''),
        text: opt.text != null ? String(opt.text) : undefined,
        ariaLabel: opt.ariaLabel != null ? String(opt.ariaLabel) : undefined,
        title: opt.title != null ? String(opt.title) : undefined,
        dataValue: opt.dataValue != null ? String(opt.dataValue) : undefined,
        dataKey: opt.dataKey != null ? String(opt.dataKey) : undefined,
        selected: Boolean(opt.selected),
        nodeId: String(opt.nodeId ?? ''),
    }));
};

const resolveNodeSelector = (snapshot: SnapshotResult, nodeId: string): string | undefined => {
    const direct = snapshot.locatorIndex[nodeId]?.direct;
    if (!direct) return undefined;
    if (direct.kind === 'role') return direct.fallback;
    return direct.query;
};

const clickNode = async (
    binding: Binding,
    selector: string,
    timeout?: number,
): Promise<StepResult['error'] | undefined> => {
    const click = await binding.traceTools['trace.locator.click']({ selector, timeout });
    if (!click.ok) {
        return {
            code: click.error?.code ?? 'ERR_INTERNAL',
            message: click.error?.message ?? 'click failed',
        };
    }
    return undefined;
};

const readCheckedNodeIds = async (
    binding: Binding,
    stepId: string,
    snapshot: SnapshotResult,
    options: SelectOptionOption[],
): Promise<Set<string> | StepResult> => {
    const checkedNodeIds = new Set<string>();
    for (const option of options) {
        const selector = resolveNodeSelector(snapshot, option.nodeId);
        if (!selector) {
            return notFound(stepId, 'no selector for checkbox option', {
                nodeId: option.nodeId,
            });
        }
        const checked = await binding.page.locator(selector).isChecked();
        if (checked) {
            checkedNodeIds.add(option.nodeId);
        }
    }
    return checkedNodeIds;
};

const readValuesByNodeIds = (
    options: SelectOptionOption[],
    nodeIds: Set<string>,
): { values: string[]; labels: string[] } => {
    const values: string[] = [];
    const labels: string[] = [];
    for (const option of options) {
        if (!nodeIds.has(option.nodeId)) {continue;}
        values.push(option.value);
        labels.push(option.label);
    }
    return { values, labels };
};

const findDuplicateNodeId = (nodeIds: string[]): string | undefined => {
    const seen = new Set<string>();
    for (const nodeId of nodeIds) {
        if (seen.has(nodeId)) {return nodeId;}
        seen.add(nodeId);
    }
    return undefined;
};


export const executeRadioGroup = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;

    if (step.args.values.length !== 1) {
        return badArgs(step.id, 'radio_group requires exactly 1 value', {
            values: step.args.values,
        });
    }

    const options = toSelectOptions(control.component);
    const targetValue = step.args.values[0];

    const matchResult = matchOption(step.id, options, targetValue);
    if (isStepResult(matchResult)) {return matchResult;}

    const targetOption = matchResult.option;

    if (!targetOption.selected) {
        const snapshot = await generateSemanticSnapshot(binding.page);
        const optionSelector = resolveNodeSelector(snapshot, targetOption.nodeId);
        if (!optionSelector) {
            return assertionFailed(step.id, 'no selector for radio option', {
                nodeId: targetOption.nodeId,
            });
        }

        const clickError = await clickNode(binding, optionSelector, timeout);
        if (clickError) {
            return { stepId: step.id, ok: false, error: clickError };
        }
    }

    const page = binding.page;
    const finalSnapshot = await generateSemanticSnapshot(binding.page);

    const targetSelector = resolveNodeSelector(finalSnapshot, targetOption.nodeId);
    if (!targetSelector) {
        return assertionFailed(step.id, 'no selector for radio option', {
            nodeId: targetOption.nodeId,
        });
    }
    const targetChecked = await page.locator(targetSelector).isChecked();
    if (!targetChecked) {
        return assertionFailed(step.id, 'target radio not selected after action', {
            targetValue,
            targetNodeId: targetOption.nodeId,
        });
    }

    for (const opt of options) {
        if (opt.nodeId === targetOption.nodeId) {continue;}
        const sel = resolveNodeSelector(finalSnapshot, opt.nodeId);
        if (!sel) {continue;}
        const checked = await page.locator(sel).isChecked();
        if (checked) {
            return assertionFailed(step.id, 'other radio options should not be selected', {
                unexpectedSelected: [opt.value],
            });
        }
    }

    return { stepId: step.id, ok: true };
};

export const executeCheckboxGroup = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;
    const stepLog = getLogger('step');

    const options = toSelectOptions(control.component);
    const targetValues = step.args.values;

    const matchResults = matchOptions(step.id, options, targetValues);
    if (isStepResult(matchResults)) {return matchResults;}

    const matchedTargetNodeIds = matchResults.map((result) => result.option.nodeId);
    const duplicateNodeId = findDuplicateNodeId(matchedTargetNodeIds);
    if (duplicateNodeId) {
        return ambiguous(step.id, 'multiple target values matched the same checkbox option', {
            values: targetValues,
            nodeId: duplicateNodeId,
        });
    }

    const targetNodeIds = new Set<string>(matchedTargetNodeIds);
    const currentSnapshot = await generateSemanticSnapshot(binding.page);
    const currentSelectedNodeIds = await readCheckedNodeIds(binding, step.id, currentSnapshot, options);
    if (isStepResult(currentSelectedNodeIds)) {return currentSelectedNodeIds;}

    stepLog.debug('select_option_checkbox_current_state', {
        stepId: step.id,
        controlRef: control.ref,
        selectedNodeIds: [...currentSelectedNodeIds],
        targetOptionNodeIds: [...targetNodeIds],
    });

    const toCheck: string[] = [];
    const toUncheck: string[] = [];

    for (const nodeId of targetNodeIds) {
        if (!currentSelectedNodeIds.has(nodeId)) {
            toCheck.push(nodeId);
        }
    }
    for (const nodeId of currentSelectedNodeIds) {
        if (!targetNodeIds.has(nodeId)) {
            toUncheck.push(nodeId);
        }
    }

    stepLog.debug('select_option_checkbox_diff', {
        stepId: step.id,
        controlRef: control.ref,
        toCheckNodeIds: toCheck,
        toUncheckNodeIds: toUncheck,
    });

    for (const nodeId of toCheck) {
        const sel = resolveNodeSelector(currentSnapshot, nodeId);
        if (!sel) {
            return notFound(step.id, 'no selector for checkbox option', { nodeId });
        }
        const err = await clickNode(binding, sel, timeout);
        if (err) {
            return { stepId: step.id, ok: false, error: err };
        }
    }

    for (const nodeId of toUncheck) {
        const sel = resolveNodeSelector(currentSnapshot, nodeId);
        if (!sel) {
            return notFound(step.id, 'no selector for checkbox option', { nodeId });
        }
        const err = await clickNode(binding, sel, timeout);
        if (err) {
            return { stepId: step.id, ok: false, error: err };
        }
    }

    const finalSnapshot = await generateSemanticSnapshot(binding.page);
    const finalSelectedNodeIds = await readCheckedNodeIds(binding, step.id, finalSnapshot, options);
    if (isStepResult(finalSelectedNodeIds)) {return finalSelectedNodeIds;}

    const finalSelected = readValuesByNodeIds(options, finalSelectedNodeIds);
    stepLog.debug('select_option_checkbox_final_state', {
        stepId: step.id,
        controlRef: control.ref,
        finalSelectedOptionNodeIds: [...finalSelectedNodeIds],
    });

    if (!nodeIdSetsEqual(finalSelectedNodeIds, targetNodeIds)) {
        const targetValuesMatched = matchResults.map((r) => r.option.value);
        return assertionFailed(step.id, 'checkbox group final set does not match target', {
            expected: targetValuesMatched,
            selectedValues: finalSelected.values,
            selectedLabels: finalSelected.labels,
            targetOptionNodeIds: [...targetNodeIds],
            finalSelectedOptionNodeIds: [...finalSelectedNodeIds],
            toCheckNodeIds: toCheck,
            toUncheckNodeIds: toUncheck,
        });
    }

    return { stepId: step.id, ok: true };
};

const nodeIdSetsEqual = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size !== b.size) {return false;}
    for (const item of a) {
        if (!b.has(item)) {return false;}
    }
    return true;
};
