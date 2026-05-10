import type { BaseControlComponent } from '../snapshot/control/types';

export type SelectOptionKind = 'native_select' | 'radio_group' | 'checkbox_group' | 'custom_select';

export const SELECT_OPTION_KINDS: ReadonlySet<string> = new Set([
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
]);

export type SelectOptionControl = {
    kind: SelectOptionKind;
    ref: string;
    component: BaseControlComponent;
};

export type SelectOptionOption = {
    value: string;
    label: string;
    text?: string;
    ariaLabel?: string;
    title?: string;
    dataValue?: string;
    dataKey?: string;
    selected: boolean;
    nodeId: string;
};

export type SelectOptionState = {
    selectedValues: string[];
    selectedLabels: string[];
    expanded: boolean;
    multiple: boolean;
};

export type SelectOptionMatchResult = {
    option: SelectOptionOption;
    index: number;
};
