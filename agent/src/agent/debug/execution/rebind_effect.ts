import type {DslEffectDescriptor} from '../../../program/dsl/debug/contracts';
import type {BrowserQueryResult, StepArgsMap} from '../../../automation/runner/steps/types';
import type {SelectOptionKind} from '../../../automation/runner/steps/executors/select_option/types';

const SELECT_OPTION_KINDS = new Set<SelectOptionKind>([
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
]);

export type RebindLogicalEffectResult =
    | Readonly<{ok: true; effect: DslEffectDescriptor}>
    | Readonly<{ok: false; reason: 'target_not_single_node' | 'unsupported_effect'}>;

export const rebindLogicalEffectTarget = (
    effect: DslEffectDescriptor,
    target: BrowserQueryResult,
): RebindLogicalEffectResult => {
    if (target.kind !== 'nodeId') {
        return Object.freeze({ok: false as const, reason: 'target_not_single_node' as const});
    }
    const args = rebindArgs(effect, target);
    if (!args) {return Object.freeze({ok: false as const, reason: 'unsupported_effect' as const});}
    return Object.freeze({
        ok: true as const,
        effect: Object.freeze({...effect, args: Object.freeze(args)}),
    });
};

const rebindArgs = (
    effect: DslEffectDescriptor,
    target: Extract<BrowserQueryResult, {kind: 'nodeId'}>,
): Record<string, unknown> | null => {
    if (effect.stepName === 'browser.click') {
        const current = effect.args as StepArgsMap['browser.click'];
        return {nodeId: target.nodeId, ...(current.options ? {options: structuredClone(current.options)} : {})};
    }
    if (effect.stepName === 'browser.fill') {
        const current = effect.args as StepArgsMap['browser.fill'];
        return {nodeId: target.nodeId, value: current.value};
    }
    if (effect.stepName === 'browser.type') {
        const current = effect.args as StepArgsMap['browser.type'];
        return {nodeId: target.nodeId, text: current.text};
    }
    if (effect.stepName === 'browser.select_option') {
        const current = effect.args as StepArgsMap['browser.select_option'];
        const candidate = target.meta?.controlKind;
        const kind = typeof candidate === 'string' && SELECT_OPTION_KINDS.has(candidate as SelectOptionKind)
            ? candidate as SelectOptionKind
            : current.kind;
        return {nodeId: target.nodeId, kind, values: [...current.values]};
    }
    return null;
};
