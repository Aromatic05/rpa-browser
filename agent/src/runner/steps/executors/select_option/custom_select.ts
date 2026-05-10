import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import type { SelectOptionControl, SelectOptionOption } from './types';
import { matchOption } from './option_match';
import { badArgs, notFound, assertionFailed, isStepResult } from './assert';
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

const resolveNodeSelector = (
    snapshot: import('../snapshot/core/types').SnapshotResult,
    nodeId: string,
): string | undefined => {
    return snapshot.locatorIndex[nodeId]?.direct?.query;
};

export const executeCustomSelect = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
): Promise<StepResult> => {
    const binding = await deps.runtime.resolveBinding(workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;

    if (step.args.values.length !== 1) {
        return badArgs(step.id, 'custom_select requires exactly 1 value', {
            values: step.args.values,
        });
    }

    if (!control.component.popupNodeId) {
        return notFound(step.id, 'custom_select missing popupNodeId');
    }

    const options = toSelectOptions(control.component);
    if (options.length === 0) {
        return notFound(step.id, 'custom_select has no options');
    }

    const targetValue = step.args.values[0];
    const matchResult = matchOption(step.id, options, targetValue);
    if (isStepResult(matchResult)) {return matchResult;}

    const snapshot = await generateSemanticSnapshot(binding.page);

    const triggerNodeId = control.component.triggerNodeId ?? control.component.controlNodeId;
    if (!triggerNodeId) {
        return notFound(step.id, 'custom_select missing triggerNodeId and controlNodeId');
    }

    const triggerSelector = resolveNodeSelector(snapshot, triggerNodeId);
    if (!triggerSelector) {
        return notFound(step.id, 'no selector for trigger node', { triggerNodeId });
    }

    const triggerClick = await binding.traceTools['trace.locator.click']({
        selector: triggerSelector,
        timeout,
    });
    if (!triggerClick.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: triggerClick.error?.code ?? 'ERR_INTERNAL',
                message: triggerClick.error?.message ?? 'failed to open popup via trigger click',
            },
        };
    }

    const openSnapshot = await generateSemanticSnapshot(binding.page);

    const freshComponent = openSnapshot.controlIndex[control.ref];
    if (!freshComponent) {
        return assertionFailed(step.id, 'control not found in post-trigger snapshot', {
            ref: control.ref,
        });
    }
    const freshOptions = toSelectOptions(freshComponent);
    const freshMatch = matchOption(step.id, freshOptions, targetValue);
    if (isStepResult(freshMatch)) {return freshMatch;}

    let optionSelector = resolveNodeSelector(openSnapshot, freshMatch.option.nodeId);
    if (!optionSelector) {
        const popupAttrs = openSnapshot.attrIndex[control.component.popupNodeId];
        const popupDomId = popupAttrs?.['id'];
        if (popupDomId) {
            optionSelector = `#${popupDomId} >> [role="option"]:has-text("${freshMatch.option.label || freshMatch.option.value}")`;
        }
    }
    if (!optionSelector) {
        return notFound(step.id, 'no selector for option node', { optionNodeId: freshMatch.option.nodeId });
    }

    const optionClick = await binding.traceTools['trace.locator.click']({
        selector: optionSelector,
        timeout,
    });
    if (!optionClick.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: optionClick.error?.code ?? 'ERR_INTERNAL',
                message: optionClick.error?.message ?? 'failed to click option',
            },
        };
    }

    const trimmed = targetValue.trim();
    const ariaSelected = await binding.page.locator(optionSelector).getAttribute('aria-selected');
    if (ariaSelected === 'true') {
        return { stepId: step.id, ok: true };
    }

    const afterSnapshot = await generateSemanticSnapshot(binding.page);
    const afterComponent = afterSnapshot.controlIndex[control.ref];
    if (!afterComponent) {
        return assertionFailed(step.id, 'control not found in post-action snapshot', {
            ref: control.ref,
        });
    }

    const afterOptions = toSelectOptions(afterComponent);
    const selectedValues = afterOptions.filter((o) => o.selected).map((o) => o.value);
    const selectedLabels = afterOptions.filter((o) => o.selected).map((o) => o.label);

    const hitViaValues = selectedValues.some((v) => v.trim() === trimmed);
    const hitViaLabels = selectedLabels.some((l) => l.trim() === trimmed);

    if (hitViaValues || hitViaLabels) {
        return { stepId: step.id, ok: true };
    }

    return assertionFailed(step.id, 'custom_select target value not selected after action', {
        targetValue,
        selectedValues,
        selectedLabels,
    });
};
