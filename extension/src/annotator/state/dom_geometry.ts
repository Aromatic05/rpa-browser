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

const elementText = (element: Element): string => normalize([
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('placeholder'),
    element.getAttribute('name'),
    element.textContent,
]
    .filter(Boolean)
    .join(' '));

const semanticRole = (element: Element): string => {
    const explicit = normalize(element.getAttribute('role'));
    if (explicit) {return explicit;}
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
        const type = normalize(element.getAttribute('type')) || 'text';
        if (type === 'hidden') {return '';}
        if (type === 'checkbox') {return 'checkbox';}
        if (type === 'radio') {return 'radio';}
        if (type === 'range') {return 'slider';}
        if (type === 'number') {return 'spinbutton';}
        if (type === 'search') {return 'searchbox';}
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {return 'button';}
        return 'textbox';
    }
    if (tag === 'textarea') {return 'textbox';}
    if (tag === 'select') {
        const select = element as HTMLSelectElement;
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'button') {return 'button';}
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) {return 'link';}
    if (tag === 'table') {return 'table';}
    if (tag === 'tr') {return 'row';}
    if (tag === 'th') {return normalize(element.getAttribute('scope')) === 'row' ? 'rowheader' : 'columnheader';}
    if (tag === 'td') {return 'cell';}
    if (tag === 'form') {return 'form';}
    if (tag === 'nav') {return 'navigation';}
    if (tag === 'dialog') {return 'dialog';}
    if (tag === 'ul' || tag === 'ol') {return 'list';}
    if (tag === 'li') {return 'listitem';}
    return '';
};

const classCandidates = (root: ParentNode, classContains: string): Element[] => {
    const scope = root as Document | Element;
    const firstClass = classContains.split(/\s+/).find(Boolean);
    const candidates = new Set<Element>();
    if (firstClass && 'getElementsByClassName' in scope) {
        for (const element of Array.from(scope.getElementsByClassName(firstClass))) {
            candidates.add(element);
        }
    }
    const expected = normalize(classContains);
    for (const element of Array.from(root.querySelectorAll('[class]'))) {
        if (normalize(element.getAttribute('class')).includes(expected)) {
            candidates.add(element);
        }
    }
    return [...candidates];
};

const addQueryMatches = (target: Set<Element>, root: ParentNode, selector: string): void => {
    const rootElement = root.nodeType === 1 ? root as Element : null;
    if (rootElement?.matches(selector)) {target.add(rootElement);}
    for (const element of Array.from(root.querySelectorAll(selector))) {target.add(element);}
};

const structuralSelector = (kind: PersistentTargetDraft['kind']): string | null => {
    if (kind === 'table') {return 'table, [role="table"], [role="grid"]';}
    if (kind === 'form') {return 'form, [role="form"]';}
    if (kind === 'list') {return 'ul, ol, [role="list"]';}
    if (kind === 'dialog') {return 'dialog, [role="dialog"]';}
    if (kind === 'toolbar') {return '[role="toolbar"]';}
    if (kind === 'panel') {return 'section, main, article, [role="region"]';}
    return null;
};

const candidateElements = (
    root: ParentNode,
    target: PersistentTargetDraft,
): Element[] => {
    const candidates = new Set<Element>();
    const isDocument = root.nodeType === 9;
    const ownerDocument = isDocument ? root as Document : (root as Element).ownerDocument;
    if (target.idEquals && ownerDocument) {
        const element = ownerDocument.getElementById(target.idEquals);
        if (element && (isDocument || root.contains(element))) {candidates.add(element);}
    }
    if (target.classContains) {
        for (const element of classCandidates(root, target.classContains)) {candidates.add(element);}
    }
    if (target.placeholderEquals) {addQueryMatches(candidates, root, '[placeholder]');}
    if (target.ariaContains) {
        addQueryMatches(candidates, root, '[aria-label], [aria-labelledby], [aria-describedby], [title]');
    }
    if (target.nameEquals) {addQueryMatches(candidates, root, '[name]');}
    if (target.nameContains) {
        addQueryMatches(candidates, root, '[name], [aria-label], [title], [placeholder], label, button, a, th, td');
    }
    if (target.textContains) {
        addQueryMatches(candidates, root, 'section, main, article, form, table, nav, button, a, label, th, td, [role], [aria-label], [title]');
    }
    if (target.roleEquals) {
        addQueryMatches(candidates, root, '[role], input, select, textarea, button, a[href], table, tr, th, td, form, nav, dialog, ul, ol, li');
    }
    const structural = structuralSelector(target.kind);
    if (structural) {addQueryMatches(candidates, root, structural);}
    if (candidates.size === 0) {
        addQueryMatches(candidates, root, 'input, select, textarea, button, a, th, td, table, form, section, main, article, nav, [role], [aria-label], [title]');
    }
    return [...candidates];
};

export const matchesDomTarget = (element: Element, target: PersistentTargetDraft): boolean => {
    if (target.idEquals && element.id !== target.idEquals) {return false;}
    if (target.classContains) {
        if (!normalize(element.getAttribute('class')).includes(normalize(target.classContains))) {return false;}
    }
    if (target.roleEquals && semanticRole(element) !== normalize(target.roleEquals)) {return false;}
    if (target.placeholderEquals
        && normalize(element.getAttribute('placeholder')) !== normalize(target.placeholderEquals)) {return false;}
    if (target.nameEquals && normalize(element.getAttribute('name')) !== normalize(target.nameEquals)) {return false;}
    const text = elementText(element);
    if (target.nameContains && !text.includes(normalize(target.nameContains))) {return false;}
    if (target.textContains && !normalize(element.textContent).includes(normalize(target.textContains))) {return false;}
    if (target.ariaContains && !normalize([
        element.getAttribute('aria-label'),
        element.getAttribute('aria-labelledby'),
        element.getAttribute('aria-describedby'),
        element.getAttribute('title'),
    ].filter(Boolean).join(' ')).includes(normalize(target.ariaContains))) {
        return false;
    }
    return true;
};

export const resolveEntityElement = (
    entity: CanvasEntityDraft,
    documentRef: Document,
): Element | null => candidateElements(documentRef, entity.target)
    .find((element) => matchesDomTarget(element, entity.target)) ?? null;

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
): Element[] => candidateElements(root, target)
    .filter((element) => matchesDomTarget(element, target));

export const enrichVisualBindingsFromDom = (
    draft: CanvasDraft,
    bindings: VisualTargetRef[],
    documentRef: Document,
): VisualTargetRef[] => {
    const replacedEntityIds = new Set<string>();
    const replacedColumnIds = new Set<string>();
    const replacedAnnotationIds = new Set<string>();
    const additions: VisualTargetRef[] = [];

    const addResolvedBinding = (
        entity: CanvasEntityDraft,
        annotationId: string,
        role: VisualTargetRef['role'],
        elements: Element[],
        extras: Pick<VisualTargetRef, 'fieldKey' | 'actionIntent'> = {},
    ): void => {
        const boxes = elements
            .map(rectOf)
            .filter((box): box is PickRect => box !== null);
        if (boxes.length === 0) {return;}
        replacedAnnotationIds.add(annotationId);
        additions.push({
            entityId: entity.id,
            nodeId: `dom:${role}:${annotationId}`,
            kind: entity.kind,
            role,
            ...extras,
            canvasAnnotationId: annotationId,
            bbox: boxes[0],
            ...(boxes.length > 1 ? {matchedNodeBoxes: boxes} : {}),
        });
    };

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

        for (const annotation of entity.annotations) {
            addResolvedBinding(
                entity,
                annotation.id,
                annotation.type,
                resolveTargetElements(annotation.target, entityElement),
                annotation.type === 'action'
                    ? {actionIntent: annotation.businessKey}
                    : {fieldKey: annotation.businessKey},
            );
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
            for (const action of column.actions) {
                addResolvedBinding(
                    entity,
                    action.id,
                    'action',
                    resolveTargetElements(action.target, entityElement),
                    {actionIntent: action.actionIntent},
                );
            }
        }

        if (entity.pagination) {
            const itemElements = entity.pagination.itemTarget
                ? resolveTargetElements(entity.pagination.itemTarget, entityElement)
                : [entityElement];
            const pageElements = itemElements.flatMap((item) =>
                resolveTargetElements(entity.pagination!.pageTarget, item),
            );
            addResolvedBinding(
                entity,
                `${entity.id}_pgpage`,
                'pagination',
                pageElements,
                {actionIntent: entity.pagination.actionIntent},
            );
        }
    }

    const retained = bindings.filter((binding) => {
        if (binding.role === 'entity' && replacedEntityIds.has(binding.entityId)) {return false;}
        if (binding.canvasAnnotationId && replacedAnnotationIds.has(binding.canvasAnnotationId)) {return false;}
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
