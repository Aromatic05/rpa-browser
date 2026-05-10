import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import type { SelectOptionControl, SelectOptionOption } from './types';
import { matchOption, matchOptions } from './option_match';
import { badArgs, assertionFailed, isStepResult } from './assert';
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
    return snapshot.locatorIndex[nodeId]?.direct?.query;
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


export const executeRadioGroup = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
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

    // Already selected: no click needed
    if (targetOption.selected) {
        return { stepId: step.id, ok: true };
    }

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

    const page = binding.page;
    const targetChecked = await page.locator(optionSelector).isChecked();
    if (!targetChecked) {
        return assertionFailed(step.id, 'target radio not selected after action', {
            targetValue,
            targetNodeId: targetOption.nodeId,
        });
    }

    for (const opt of options) {
        if (opt.nodeId === targetOption.nodeId) {continue;}
        const sel = resolveNodeSelector(snapshot, opt.nodeId);
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
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;

    const options = toSelectOptions(control.component);
    const targetValues = step.args.values;

    const matchResults = matchOptions(step.id, options, targetValues);
    if (isStepResult(matchResults)) {return matchResults;}

    const targetNodeIds = new Set<string>(
        matchResults.map((r) => r.option.nodeId),
    );
    const currentSelectedNodeIds = new Set<string>(
        options.filter((o) => o.selected).map((o) => o.nodeId),
    );

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

    const snapshot = await generateSemanticSnapshot(binding.page);

    // Check missing items
    for (const nodeId of toCheck) {
        const sel = resolveNodeSelector(snapshot, nodeId);
        if (!sel) {
            return assertionFailed(step.id, 'no selector for checkbox option', { nodeId });
        }
        const err = await clickNode(binding, sel, timeout);
        if (err) {
            return { stepId: step.id, ok: false, error: err };
        }
    }

    // Uncheck extra items
    for (const nodeId of toUncheck) {
        const sel = resolveNodeSelector(snapshot, nodeId);
        if (!sel) {
            return assertionFailed(step.id, 'no selector for checkbox option', { nodeId });
        }
        const err = await clickNode(binding, sel, timeout);
        if (err) {
            return { stepId: step.id, ok: false, error: err };
        }
    }

    const page = binding.page;
    const targetSet = new Set<string>(targetValues.map((v) => v.trim()));

    for (const opt of options) {
        const sel = resolveNodeSelector(snapshot, opt.nodeId);
        if (!sel) {continue;}
        const checked = await page.locator(sel).isChecked();
        const wantsChecked = targetSet.has(opt.value.trim()) || targetSet.has(opt.label.trim());
        if (checked !== wantsChecked) {
            const checkedValues: string[] = [];
            for (const o of options) {
                const s = resolveNodeSelector(snapshot, o.nodeId);
                if (s && await page.locator(s).isChecked()) {
                    checkedValues.push(o.value);
                }
            }
            return assertionFailed(step.id, 'checkbox group final set does not match target', {
                expected: [...targetSet],
                selectedValues: checkedValues,
                selectedLabels: [],
            });
        }
    }

    return { stepId: step.id, ok: true };
};
