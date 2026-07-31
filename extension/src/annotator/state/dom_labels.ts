import type {CanvasDraft, PersistentTargetDraft} from '../types.js';

const resolveElement = (
    documentRef: Document,
    target: PersistentTargetDraft,
): HTMLElement | null => {
    if (target.idEquals) {
        return documentRef.getElementById(target.idEquals);
    }
    if (target.nameEquals) {
        for (const element of Array.from(documentRef.querySelectorAll<HTMLElement>('[name]'))) {
            if (element.getAttribute('name') === target.nameEquals) {return element;}
        }
    }
    return null;
};

const textOf = (value: string | null | undefined): string | null => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || null;
};

const labelText = (label: HTMLLabelElement): string | null => {
    const clone = label.cloneNode(true) as HTMLLabelElement;
    clone.querySelectorAll('input, select, textarea, button').forEach((node) => node.remove());
    return textOf(clone.textContent);
};

const readAssociatedLabel = (element: HTMLElement): string | null => {
    if ('labels' in element) {
        const labels = (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).labels;
        for (const label of Array.from(labels || [])) {
            const text = labelText(label);
            if (text) {return text;}
        }
    }
    const wrapping = element.closest('label');
    return wrapping ? labelText(wrapping) : null;
};

const readProductName = (element: HTMLElement): string | null =>
    readAssociatedLabel(element) ||
    textOf(element.getAttribute('aria-label')) ||
    textOf(element.getAttribute('title')) ||
    textOf(element.getAttribute('placeholder'));

export const enrichInferredFieldNamesFromDom = (
    draft: CanvasDraft,
    documentRef: Document,
): CanvasDraft => ({
    ...draft,
    page: {...draft.page},
    entities: draft.entities.map((entity) => ({
        ...entity,
        target: {...entity.target},
        annotations: entity.annotations.map((annotation) => {
            if (annotation.type !== 'field' || annotation.origin !== 'inferred') {
                return {...annotation, target: {...annotation.target}};
            }
            const element = resolveElement(documentRef, annotation.target);
            const productName = element ? readProductName(element) : null;
            return {
                ...annotation,
                ...(productName ? {name: productName} : {}),
                target: {...annotation.target},
            };
        }),
        columns: entity.columns.map((column) => ({
            ...column,
            actions: column.actions.map((action) => ({...action, target: {...action.target}})),
        })),
        ...(entity.pagination
            ? {pagination: {...entity.pagination, pageTarget: {...entity.pagination.pageTarget}}}
            : {}),
    })),
});
