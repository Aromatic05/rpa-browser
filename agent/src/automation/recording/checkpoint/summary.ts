import type {StepName, StepUnion} from '../../runner/steps/types';
import type {RecordingEnhancementMap} from '../types';
import type {CheckpointRecordedStepSummary} from './types';
import {normalizeText} from './value';

const RECORDED_STEP_LABELS: Partial<Record<StepName, string>> = {
    'browser.goto': '打开页面',
    'browser.reload': '刷新页面',
    'browser.click': '点击',
    'browser.fill': '填写',
    'browser.type': '输入',
    'browser.select_option': '选择',
    'browser.press_key': '按键',
    'browser.scroll': '滚动',
    'browser.hover': '悬停',
    'browser.drag_and_drop': '拖动',
};

export const recordedValue = (step: StepUnion): unknown => {
    if (step.name === 'browser.fill') {return step.args.value;}
    if (step.name === 'browser.type') {return step.args.text;}
    if (step.name === 'browser.select_option') {return structuredClone(step.args.values);}
    return undefined;
};

export const checkpointStepSummary = (
    steps: readonly StepUnion[],
    enrichments: RecordingEnhancementMap = {},
): CheckpointRecordedStepSummary[] => steps.map((step, index) => {
    const enhancement = Object.hasOwn(enrichments, step.id) ? enrichments[step.id] : undefined;
    const semantic = enhancement
        ? enhancement.semanticHints ?? enhancement.target?.semanticHints
        : undefined;
    const profileName = normalizeText(semantic?.profileName);
    const businessTag = normalizeText(semantic?.businessTag);
    const fieldKey = normalizeText(semantic?.fieldKey);
    const fieldHint = normalizeText(semantic?.fieldLabel);
    const actionHint = normalizeText(semantic?.actionIntent);
    const actionRole = semantic?.actionRole === 'row' ? 'row' : undefined;
    const rowPrimaryKey = semantic?.rowPrimaryKey
        && normalizeText(semantic.rowPrimaryKey.fieldKey)
        && normalizeText(semantic.rowPrimaryKey.value)
        ? {
            fieldKey: normalizeText(semantic.rowPrimaryKey.fieldKey)!,
            value: normalizeText(semantic.rowPrimaryKey.value)!,
        }
        : undefined;
    const detail = fieldHint ?? actionHint;
    const value = recordedValue(step);
    return {
        index: index + 1,
        stepId: step.id,
        stepName: step.name,
        label: `${RECORDED_STEP_LABELS[step.name] || '页面操作'}${detail ? ` ${detail}` : ''}`,
        ...(value === undefined ? {} : {recordedValue: value}),
        ...(profileName ? {profileName} : {}),
        ...(businessTag ? {businessTag} : {}),
        ...(fieldKey ? {fieldKey} : {}),
        ...(fieldHint ? {fieldHint} : {}),
        ...(actionHint ? {actionHint} : {}),
        ...(actionRole ? {actionRole} : {}),
        ...(rowPrimaryKey ? {rowPrimaryKey} : {}),
    };
});
