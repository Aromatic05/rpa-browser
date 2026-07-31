import type { EntityKind, PickCandidate } from '../types.js';

export type RecommendedType =
    | 'field'
    | 'action'
    | 'column'
    | 'pagination'
    | 'entity'
    | 'group'
    | 'row_action'
    | 'ignore';

const INPUT_ROLES = new Set([
    'textbox',
    'combobox',
    'searchbox',
    'spinbutton',
    'checkbox',
    'radio',
    'slider',
    'switch',
    'listbox',
    'option',
]);

const BUTTON_ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'treeitem',
]);

const CELL_ROLES = new Set([
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
]);

const normalize = (value: string | undefined): string => (value ?? '').toLowerCase();

const PAGINATION_HINTS = [
    'pagination',
    'pager',
    '上一页',
    '下一页',
    '首页',
    '末页',
    'next',
    'previous',
    'prev',
    'first page',
    'last page',
];

const looksLikePagination = (candidate: PickCandidate): boolean => {
    if (candidate.proposedTargets?.some((target) => target.relation === 'pagination')) {
        return true;
    }
    const text = normalize(candidate.text);
    if (!text) {return false;}
    return PAGINATION_HINTS.some((hint) => text.includes(hint));
};

const isCellLike = (candidate: PickCandidate): boolean => {
    if (candidate.level === 'field') {return true;}
    return CELL_ROLES.has(normalize(candidate.role));
};

const isInputLike = (candidate: PickCandidate): boolean => {
    if (candidate.level === 'control' && !candidate.actionIntent) {
        return INPUT_ROLES.has(normalize(candidate.role));
    }
    return false;
};

const isButtonLike = (candidate: PickCandidate): boolean => {
    if (candidate.actionIntent) {return true;}
    if (candidate.level === 'control') {
        return BUTTON_ROLES.has(normalize(candidate.role));
    }
    return false;
};

export const recommendAnnotationTypes = (
    candidate: PickCandidate,
    currentEntityKind?: EntityKind,
): RecommendedType[] => {
    if (candidate.level === 'region' || candidate.level === 'group' || candidate.entityRef) {
        return ['entity', 'group', 'ignore'];
    }

    if (looksLikePagination(candidate)) {
        return ['pagination', 'action', 'ignore'];
    }

    if (candidate.level === 'row') {
        return ['row_action', 'ignore'];
    }

    if (isCellLike(candidate) && currentEntityKind === 'table') {
        return ['column', 'ignore'];
    }

    if (isInputLike(candidate)) {
        return ['field', 'ignore'];
    }

    if (isButtonLike(candidate)) {
        return ['action', 'ignore'];
    }

    if (candidate.level === 'field') {
        return ['field', 'ignore'];
    }

    return ['entity', 'group', 'ignore'];
};

export const filterCandidatesForAnnotationType = (
    candidates: readonly PickCandidate[],
    currentEntityKind: EntityKind | undefined,
    requestedType: 'field' | 'action',
): PickCandidate[] => candidates.filter((candidate) =>
    recommendAnnotationTypes(candidate, currentEntityKind).includes(requestedType),
);
