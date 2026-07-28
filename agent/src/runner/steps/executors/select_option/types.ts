import type { SelectOptionControlKind } from '../../../../snapshot';

export type SelectOptionKind = SelectOptionControlKind;

export const SELECT_OPTION_KINDS: ReadonlySet<SelectOptionKind> = new Set([
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
]);
