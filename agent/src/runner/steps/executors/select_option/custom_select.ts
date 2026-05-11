import { awaitPageBoundBinding } from '../../helpers/runtime_binding';
import type { Step, StepResult } from '../../types';
import type { RunStepsDeps } from '../../../run_steps';
import { getLogger } from '../../../../logging/logger';
import type { SelectOptionControl, SelectOptionOption } from './types';
import { matchOption, matchOptions } from './option_match';
import { ambiguous, badArgs, notFound, assertionFailed, isStepResult } from './assert';
import { generateSemanticSnapshot } from '../snapshot/pipeline/snapshot';
import type { SnapshotResult } from '../snapshot/core/types';

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

const resolveNodeSelector = (snapshot: SnapshotResult, nodeId: string | undefined): string | undefined => {
    if (!nodeId) {return undefined;}
    const direct = snapshot.locatorIndex[nodeId]?.direct;
    if (!direct) return undefined;
    if (direct.kind === 'role') return direct.fallback;
    return direct.query;
};

const resolveTriggerSelector = (
    snapshot: SnapshotResult,
    control: SelectOptionControl,
    anchorSelector?: string,
): { selector: string; source: string } | undefined => {
    const triggerSelector = resolveNodeSelector(snapshot, control.component.triggerNodeId);
    if (triggerSelector) {return { selector: triggerSelector, source: 'triggerNodeId' };}
    const controlSelector = resolveNodeSelector(snapshot, control.component.controlNodeId);
    if (controlSelector) {return { selector: controlSelector, source: 'controlNodeId' };}
    const rootSelector = resolveNodeSelector(snapshot, control.component.rootNodeId);
    if (rootSelector) {return { selector: rootSelector, source: 'rootNodeId' };}
    if (anchorSelector) {return { selector: anchorSelector, source: 'anchorSelector' };}
    return undefined;
};

const dispatchCustomSelectTrigger = async (
    binding: Binding,
    selector: string,
    timeout: number,
) => await binding.traceTools['trace.page.evaluate']({
    expression: `(async (arg) => {
        const selector = String(arg.selector || '').replace(/:visible$/, '');
        const timeout = Number(arg.timeout || 0);
        const start = Date.now();
        let node = null;
        while (Date.now() - start <= timeout) {
            try {
                node = document.querySelector(selector);
            } catch {
                return { ok: false, code: 'ERR_BAD_ARGS', message: 'custom_select trigger selector is invalid' };
            }
            if (node) { break; }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!node) {
            return { ok: false, code: 'ERR_NOT_FOUND', message: 'custom_select trigger not found' };
        }
        if (!(node instanceof HTMLElement)) {
            return { ok: false, code: 'ERR_BAD_ARGS', message: 'custom_select trigger is not an HTMLElement' };
        }
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return { ok: false, code: 'ERR_NOT_VISIBLE', message: 'custom_select trigger is not visible' };
        }
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        node.dispatchEvent(new MouseEvent('mouseover', options));
        node.dispatchEvent(new MouseEvent('mousemove', options));
        node.dispatchEvent(new MouseEvent('mousedown', options));
        node.dispatchEvent(new MouseEvent('mouseup', options));
        node.dispatchEvent(new MouseEvent('click', options));
        return { ok: true };
    })(arg)`,
    arg: { selector, timeout },
});

const resolveOpenCustomSelectOptionPoint = async (
    binding: Binding,
    targetValue: string,
) => await binding.traceTools['trace.page.evaluate']({
    expression: `((targetValue) => {
        const collapse = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const target = collapse(targetValue);
        const isVisible = (node) => {
            if (!(node instanceof HTMLElement)) { return false; }
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const isOptionNode = (node) => {
            if (!(node instanceof HTMLElement)) { return false; }
            const role = node.getAttribute('role') || '';
            return role === 'option'
                || node.hasAttribute('aria-selected');
        };
        const popups = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]'))
            .filter((node) => isVisible(node));
        const candidates = [];
        for (const popup of popups) {
            const optionNodes = Array.from(popup.querySelectorAll('[role="option"], [aria-selected]'))
                .filter((node) => isOptionNode(node) && isVisible(node));
            for (const node of optionNodes) {
                const text = collapse(node.textContent);
                const value = collapse(node.getAttribute('value') || node.getAttribute('data-value') || node.getAttribute('data-key') || text);
                if (text === target || value === target || text.toLowerCase() === target.toLowerCase() || value.toLowerCase() === target.toLowerCase()) {
                    candidates.push({ node, text, value });
                }
            }
        }
        if (candidates.length === 0) {
            return { ok: false, code: 'ERR_NOT_FOUND', message: 'custom_select option not found in open popup', matchedCount: 0 };
        }
        const uniqueNodes = Array.from(new Set(candidates.map((item) => item.node)));
        if (uniqueNodes.length > 1) {
            return {
                ok: false,
                code: 'ERR_AMBIGUOUS',
                message: 'multiple custom_select options matched in open popup',
                matchedCount: uniqueNodes.length,
                matchedTexts: candidates.map((item) => item.text).slice(0, 8),
            };
        }
        const node = uniqueNodes[0];
        const rect = node.getBoundingClientRect();
        return {
            ok: true,
            text: collapse(node.textContent),
            value: collapse(node.getAttribute('value') || node.getAttribute('data-value') || node.textContent),
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    })(arg)`,
    arg: targetValue,
});

const resolveCustomSelectControlAfterOpen = (
    step: Step<'browser.select_option'>,
    snapshot: SnapshotResult,
): SelectOptionControl | StepResult => {
    const matchedControls: SelectOptionControl[] = [];

    for (const [controlRef, component] of Object.entries(snapshot.controlIndex || {})) {
        if (component.owner !== 'browser.select_option') {continue;}
        if (!component.capabilities.includes('select_option')) {continue;}
        if (component.kind !== 'custom_select') {continue;}

        const control: SelectOptionControl = { kind: 'custom_select', ref: controlRef, component };
        const options = toSelectOptions(component)
            .filter((option) => component.optionNodeIds.includes(option.nodeId));
        const matchResult = matchOptions(step.id, options, step.args.values);
        if (isStepResult(matchResult)) {continue;}
        matchedControls.push(control);
    }

    const details = {
        values: step.args.values,
        matchedControlRefs: matchedControls.map((control) => control.ref),
        matchedControlCount: matchedControls.length,
    };

    if (matchedControls.length === 0) {
        return notFound(step.id, 'custom_select control not found after open', details);
    }
    if (matchedControls.length > 1) {
        return ambiguous(step.id, 'multiple custom_select controls matched after open', details);
    }
    return matchedControls[0];
};

const readNodeText = (snapshot: SnapshotResult, nodeId: string | undefined): string | undefined => {
    if (!nodeId) {return undefined;}
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {return undefined;}
    if (node.name?.trim()) {return node.name.trim();}
    if (typeof node.content === 'string' && node.content.trim()) {return node.content.trim();}
    if (typeof node.content === 'object' && node.content?.ref) {
        const text = snapshot.contentStore[node.content.ref];
        if (text?.trim()) {return text.trim();}
    }
    return undefined;
};

const readFinalCustomSelectState = (
    stepId: string,
    snapshot: SnapshotResult,
    controlRef: string,
): { controlRef: string; selectedValues: string[]; selectedLabels: string[]; visibleText?: string } | StepResult => {
    const component = snapshot.controlIndex[controlRef];
    if (!component) {
        return notFound(stepId, 'custom_select control not found in final snapshot', { controlRef });
    }

    const options = toSelectOptions(component);
    const selectedValues = options.filter((option) => option.selected).map((option) => option.value);
    const selectedLabels = options.filter((option) => option.selected).map((option) => option.label);
    const visibleText = readNodeText(snapshot, component.triggerNodeId)
        || readNodeText(snapshot, component.controlNodeId)
        || readNodeText(snapshot, component.rootNodeId);

    return { controlRef, selectedValues, selectedLabels, visibleText };
};

const matchesText = (value: string | undefined, targetValue: string): boolean => {
    if (!value) {return false;}
    const collapsed = value.replace(/\s+/g, ' ').trim();
    const target = targetValue.replace(/\s+/g, ' ').trim();
    return collapsed === target || collapsed.includes(target);
};

export const executeCustomSelect = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceName: string,
    control: SelectOptionControl,
    anchorSelector?: string,
): Promise<StepResult> => {
    const binding = await awaitPageBoundBinding(deps, workspaceName);
    const timeout = deps.config.waitPolicy.visibleTimeoutMs;
    const stepLog = getLogger('step');

    if (step.args.values.length !== 1) {
        return badArgs(step.id, 'custom_select requires exactly 1 value', {
            values: step.args.values,
        });
    }

    const targetValue = step.args.values[0];
    const snapshot = await generateSemanticSnapshot(binding.page);
    const triggerTarget = resolveTriggerSelector(snapshot, control, anchorSelector);
    if (!triggerTarget) {
        return notFound(step.id, 'no selector for custom_select trigger', {
            triggerNodeId: control.component.triggerNodeId,
            controlNodeId: control.component.controlNodeId,
            rootNodeId: control.component.rootNodeId,
            hasAnchorSelector: Boolean(anchorSelector),
        });
    }

    stepLog.debug('select_option_custom_open_trigger', {
        stepId: step.id,
        controlRef: control.ref,
        triggerSelectorSource: triggerTarget.source,
    });
    const triggerClick = await dispatchCustomSelectTrigger(binding, triggerTarget.selector, timeout);
    const triggerResult = triggerClick.ok ? triggerClick.data as { ok?: boolean; code?: string; message?: string } : undefined;
    if (!triggerClick.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: triggerClick.error?.code ?? 'ERR_INTERNAL',
                message: triggerClick.error?.message ?? 'failed to open popup via trigger dispatch',
            },
        };
    }
    if (triggerResult?.ok === false) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: triggerResult.code ?? 'ERR_INTERNAL',
                message: triggerResult.message ?? 'failed to open popup via trigger dispatch',
            },
        };
    }

    await binding.page.waitForTimeout(100);
    const openSnapshot = await generateSemanticSnapshot(binding.page);
    stepLog.debug('select_option_custom_snapshot_refreshed', {
        stepId: step.id,
    });

    const freshControl = resolveCustomSelectControlAfterOpen(step, openSnapshot);
    let finalControlRef = control.ref;
    if (isStepResult(freshControl)) {
        const optionPoint = await resolveOpenCustomSelectOptionPoint(binding, targetValue);
        const optionResult = optionPoint.ok ? optionPoint.data as {
            ok?: boolean;
            code?: string;
            message?: string;
            matchedCount?: number;
            matchedTexts?: string[];
            x?: number;
            y?: number;
        } : undefined;
        if (!optionPoint.ok) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: optionPoint.error?.code ?? 'ERR_INTERNAL',
                    message: optionPoint.error?.message ?? 'failed to resolve open custom_select option',
                },
            };
        }
        if (optionResult?.ok === false) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: optionResult.code ?? 'ERR_INTERNAL',
                    message: optionResult.message ?? 'failed to click open custom_select option',
                    details: {
                        targetValue,
                        matchedCount: optionResult.matchedCount,
                        matchedTexts: optionResult.matchedTexts,
                    },
                },
            };
        }
        if (!optionResult || !Number.isFinite(optionResult.x) || !Number.isFinite(optionResult.y)) {
            return notFound(step.id, 'custom_select option point not found', { targetValue });
        }
        const x = optionResult.x as number;
        const y = optionResult.y as number;
        const optionClick = await binding.traceTools['trace.mouse.action']({
            action: 'click',
            x,
            y,
        });
        if (!optionClick.ok) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: optionClick.error?.code ?? 'ERR_INTERNAL',
                    message: optionClick.error?.message ?? 'failed to click open custom_select option',
                },
            };
        }
    } else {
        finalControlRef = freshControl.ref;
        stepLog.debug('select_option_custom_control_resolved_after_open', {
            stepId: step.id,
            controlRef: freshControl.ref,
            optionCount: freshControl.component.optionNodeIds.length,
        });

        const freshOptions = toSelectOptions(freshControl.component)
            .filter((option) => freshControl.component.optionNodeIds.includes(option.nodeId));
        const freshMatch = matchOption(step.id, freshOptions, targetValue);
        if (isStepResult(freshMatch)) {return freshMatch;}

        const optionSelector = resolveNodeSelector(openSnapshot, freshMatch.option.nodeId);
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
    }

    const afterSnapshot = await generateSemanticSnapshot(binding.page);
    const finalState = readFinalCustomSelectState(step.id, afterSnapshot, finalControlRef);
    if (isStepResult(finalState)) {return finalState;}
    stepLog.debug('select_option_custom_final_state', {
        stepId: step.id,
        controlRef: finalState.controlRef,
        selectedValues: finalState.selectedValues,
        selectedLabels: finalState.selectedLabels,
        visibleText: finalState.visibleText,
    });

    const trimmed = targetValue.trim();
    const hitViaValues = finalState.selectedValues.some((v) => v.trim() === trimmed);
    const hitViaLabels = finalState.selectedLabels.some((l) => l.trim() === trimmed);
    const hitViaVisibleText = matchesText(finalState.visibleText, targetValue);

    if (hitViaValues || hitViaLabels || hitViaVisibleText) {
        return { stepId: step.id, ok: true };
    }

    return assertionFailed(step.id, 'custom_select target value not selected after action', {
        targetValue,
        selectedValues: finalState.selectedValues,
        selectedLabels: finalState.selectedLabels,
        visibleText: finalState.visibleText,
    });
};
