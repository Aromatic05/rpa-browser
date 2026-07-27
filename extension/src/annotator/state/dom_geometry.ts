import type {
    CanvasDraft,
    CanvasEntityDraft,
    PersistentTargetDraft,
    PickRect,
    VisualTargetRef,
} from '../types.js';

const normalize = (value: string | null | undefined): string =>
    (value || '').replace(/\s+/g, '').trim().toLowerCase();

const rectOf = (element: Element): PickRect | null => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {return null;}
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
};

const elementText = (element: Element): string =>
    normalize(element.getAttribute('aria-label') || element.textContent);

export const matchesDomTarget = (element: Element, target: PersistentTargetDraft): boolean => {
    if (target.idEquals && element.id !== target.idEquals) {return false;}
    if (target.classContains) {
        const expected = target.classContains.split(/\s+/).filter(Boolean);
        if (!expected.every((token) => element.classList.contains(token))) {return false;}
    }
    if (target.roleEquals && element.getAttribute('role') !== target.roleEquals) {return false;}
    const text = elementText(element);
    if (target.nameEquals && text !== normalize(target.nameEquals)) {return false;}
    if (target.nameContains && !text.includes(normalize(target.nameContains))) {return false;}
    if (target.textContains && !normalize(element.textContent).includes(normalize(target.textContains))) {return false;}
    if (target.ariaContains && !normalize(element.getAttribute('aria-label')).includes(normalize(target.ariaContains))) {
        return false;
    }
    return true;
};

export const resolveEntityElement = (
    entity: CanvasEntityDraft,
    documentRef: Document,
): Element | null => {
    const target = entity.target;
    const candidates: Element[] = [];
    if (target.idEquals) {
        const element = documentRef.getElementById(target.idEquals);
        if (element) {candidates.push(element);}
    } else if (target.classContains) {
        const firstClass = target.classContains.split(/\s+/).find(Boolean);
        if (firstClass) {candidates.push(...Array.from(documentRef.getElementsByClassName(firstClass)));}
    } else if (target.roleEquals) {
        candidates.push(...Array.from(documentRef.querySelectorAll(`[role="${target.roleEquals}"]`)));
    } else if (target.kind === 'table') {
        candidates.push(...Array.from(documentRef.querySelectorAll('[role="table"], [role="grid"]')));
        candidates.push(...Array.from(documentRef.querySelectorAll('table')));
    } else if (target.kind === 'form') {
        candidates.push(...Array.from(documentRef.querySelectorAll('form, [role="form"]')));
    } else if (target.kind === 'list') {
        candidates.push(...Array.from(documentRef.querySelectorAll('[role="list"], ul, ol')));
    } else if (target.kind === 'dialog') {
        candidates.push(...Array.from(documentRef.querySelectorAll('dialog, [role="dialog"]')));
    } else if (target.kind === 'toolbar') {
        candidates.push(...Array.from(documentRef.querySelectorAll('[role="toolbar"]')));
    } else if (target.kind === 'panel') {
        candidates.push(...Array.from(documentRef.querySelectorAll('section, main, article, [role="region"]')));
    }
    return candidates.find((element) => matchesDomTarget(element, target)) ?? null;
};

export const resolveColumnHeader = (
    entityElement: Element,
    name: string | undefined,
    fieldKey: string,
): Element | null => {
    const expected = new Set([normalize(name), normalize(fieldKey)].filter(Boolean));
    if (expected.size === 0) {return null;}
    return Array.from(entityElement.querySelectorAll('th, [role="columnheader"]'))
        .find((header) => expected.has(normalize(header.textContent))) ?? null;
};


export const resolveTargetElements = (
    target: PersistentTargetDraft,
    root: ParentNode,
): Element[] => {
    const candidates: Element[] = [];
    const isDocument = root.nodeType === 9;
    const ownerDocument = isDocument ? root as Document : (root as Element).ownerDocument;
    if (target.idEquals && ownerDocument) {
        const element = ownerDocument.getElementById(target.idEquals);
        if (element && (isDocument || root.contains(element))) {candidates.push(element);}
    } else if (target.classContains) {
        const firstClass = target.classContains.split(/\s+/).find(Boolean);
        if (firstClass) {
            const scope = root as Document | Element;
            candidates.push(...Array.from(scope.getElementsByClassName(firstClass)));
        }
    } else if (target.roleEquals) {
        candidates.push(...Array.from(root.querySelectorAll(`[role="${target.roleEquals}"]`)));
    } else {
        candidates.push(...Array.from(root.querySelectorAll('input, select, textarea, button, a, th, [role]')));
    }
    return candidates.filter((element) => matchesDomTarget(element, target));
};

export const enrichVisualBindingsFromDom = (
    draft: CanvasDraft,
    bindings: VisualTargetRef[],
    documentRef: Document,
): VisualTargetRef[] => {
    const replacedEntityIds = new Set<string>();
    const replacedColumnIds = new Set<string>();
    const additions: VisualTargetRef[] = [];

    for (const entity of draft.entities) {
        const entityElement = resolveEntityElement(entity, documentRef);
        if (!entityElement) {continue;}
        const entityRect = rectOf(entityElement);
        if (entityRect) {
            replacedEntityIds.add(entity.id);
            additions.push({
                entityId: entity.id,
                nodeId: `dom:entity:${entity.id}`,
                kind: entity.kind,
                role: 'entity',
                bbox: entityRect,
            });
        }

        for (const column of entity.columns) {
            const header = resolveColumnHeader(entityElement, column.name, column.fieldKey);
            if (!header) {continue;}
            const headerRect = rectOf(header);
            if (!headerRect) {continue;}
            replacedColumnIds.add(column.id);
            additions.push({
                entityId: entity.id,
                nodeId: `dom:column:${column.id}`,
                kind: entity.kind,
                role: 'column',
                fieldKey: column.fieldKey,
                canvasAnnotationId: column.id,
                bbox: headerRect,
            });
        }
    }

    const retained = bindings.filter((binding) => {
        if (binding.role === 'entity' && replacedEntityIds.has(binding.entityId)) {return false;}
        if (binding.role === 'column') {
            if (binding.canvasAnnotationId && replacedColumnIds.has(binding.canvasAnnotationId)) {return false;}
            if (draft.entities.some((entity) =>
                entity.id === binding.entityId &&
                entity.columns.some((column) =>
                    replacedColumnIds.has(column.id) && column.fieldKey === binding.fieldKey,
                ),
            )) {return false;}
        }
        return true;
    });
    return [...retained, ...additions];
};
