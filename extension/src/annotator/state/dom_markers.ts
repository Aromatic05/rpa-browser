import type {
    CanvasDraft,
    CheckResultByAnnotation,
    EntityKind,
} from '../types.js';
import {
    resolveColumnHeader,
    resolveEntityElement,
    resolveTargetElements,
} from './dom_geometry.js';

const STYLE_ID = 'rpa-annotator-dom-marker-style';
const MARKER_ATTR = 'data-rpa-annotation-id';
const KIND_ATTR = 'data-rpa-annotation-kind';
const STATE_ATTR = 'data-rpa-annotation-state';
const COLUMN_POSITION_ATTR = 'data-rpa-column-position';
const PRIMARY_KEY_ATTR = 'data-rpa-primary-key';
const COLUMN_GROUP_ATTR = 'data-rpa-column-group';
const RECORD_SEMANTIC_ATTR = 'data-rpa-record-semantic';

const STYLE_TEXT = `
[${MARKER_ATTR}] {
    --rpa-marker-color: #16a34a;
    outline: 2px dashed var(--rpa-marker-color) !important;
    outline-offset: -2px !important;
    transition: outline-color 120ms ease, box-shadow 120ms ease, opacity 120ms ease !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="action"] { --rpa-marker-color: #ea580c; }
[${COLUMN_GROUP_ATTR}] {
    outline: 2px dashed #7c3aed !important;
    outline-offset: -2px !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="column"] {
    --rpa-marker-color: #7c3aed;
    outline: none !important;
    box-shadow: inset -1px 0 0 var(--rpa-marker-color) !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="column"][${COLUMN_POSITION_ATTR}="middle"] {
    box-shadow: inset -1px 0 0 var(--rpa-marker-color) !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="column"][${COLUMN_POSITION_ATTR}="last"] {
    box-shadow: none !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="column"][${PRIMARY_KEY_ATTR}="true"] {
    color: #5b21b6 !important;
    font-weight: 800 !important;
    background: rgba(124, 58, 237, .12) !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="pagination"] { --rpa-marker-color: #0f766e; }
[${MARKER_ATTR}][${STATE_ATTR}="confirmed"] { outline-style: solid !important; }
[${MARKER_ATTR}][${STATE_ATTR}="error"] {
    --rpa-marker-color: #dc2626;
    outline-style: solid !important;
    box-shadow: 0 0 0 4px rgba(220, 38, 38, .16) !important;
}
[${MARKER_ATTR}][${STATE_ATTR}="selected"] {
    outline-width: 3px !important;
    outline-offset: -3px !important;
    outline-style: solid !important;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--rpa-marker-color) 18%, transparent) !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="column"][${STATE_ATTR}] {
    outline: none !important;
}
[${MARKER_ATTR}][${KIND_ATTR}="column"][${STATE_ATTR}="selected"] {
    background: rgba(124, 58, 237, .16) !important;
}
`;

type MarkerKind = 'field' | 'action' | 'column' | 'pagination';
type MarkerState = 'inferred' | 'confirmed' | 'error' | 'selected';

type MarkerTarget = {
    annotationId: string;
    kind: MarkerKind;
    state: MarkerState;
    elements: Element[];
    columnPosition?: 'first' | 'middle' | 'last';
    primaryKey?: boolean;
    columnGroup?: Element;
    recordSemantic: {
        profileName: string;
        businessTag: string;
        entityKind: EntityKind;
        fieldKey?: string;
        actionIntent?: string;
        actionRole?: 'row';
        rowPrimaryKey?: {fieldKey: string; value: string};
    };
};

const paginationElements = (nextElements: Element[], entityElement: Element): Element[] => {
    const result = [...nextElements];
    const seen = new Set(result);
    for (const next of nextElements) {
        const container = next.closest('nav, [role="navigation"], [class*="pagination"], [aria-label*="分页"]') || entityElement;
        for (const control of Array.from(container.querySelectorAll('button, a, [role="button"]'))) {
            const text = (control.textContent || control.getAttribute('aria-label') || '')
                .replace(/\s+/g, '')
                .toLowerCase();
            if (
                !text.includes('上一页') &&
                text !== 'previous' &&
                text !== 'prev' &&
                !text.includes('previouspage')
            ) {
                continue;
            }
            if (!seen.has(control)) {
                seen.add(control);
                result.unshift(control);
            }
        }
    }
    return result;
};

const checkIsError = (
    checks: CheckResultByAnnotation[] | null,
    annotationId: string,
): boolean => checks?.some((check) =>
    check.canvasAnnotationId === annotationId && check.status !== 'unique',
) ?? false;

const markerState = (
    origin: 'inferred' | 'confirmed' | 'manual',
    annotationId: string,
    selectedAnnotationId: string | null,
    checks: CheckResultByAnnotation[] | null,
): MarkerState => {
    if (annotationId === selectedAnnotationId) {return 'selected';}
    if (checkIsError(checks, annotationId)) {return 'error';}
    return origin === 'inferred' ? 'inferred' : 'confirmed';
};

const collectMarkerTargets = (
    draft: CanvasDraft,
    documentRef: Document,
    selectedAnnotationId: string | null,
    checks: CheckResultByAnnotation[] | null,
): MarkerTarget[] => {
    const targets: MarkerTarget[] = [];
    for (const entity of draft.entities) {
        const entityElement = resolveEntityElement(entity, documentRef);
        if (!entityElement) {continue;}
        for (const annotation of entity.annotations) {
            const elements = resolveTargetElements(annotation.target, entityElement);
            if (elements.length === 0) {continue;}
            targets.push({
                annotationId: annotation.id,
                kind: annotation.type === 'pagination' ? 'pagination' : annotation.type,
                state: markerState(annotation.origin, annotation.id, selectedAnnotationId, checks),
                elements: annotation.type === 'action' ? elements.slice(0, 1) : elements,
                recordSemantic: {
                    profileName: draft.profileName,
                    businessTag: entity.businessTag,
                    entityKind: entity.kind,
                    ...(annotation.type === 'field' ? {fieldKey: annotation.businessKey} : {}),
                    ...(annotation.type === 'action' ? {actionIntent: annotation.businessKey} : {}),
                },
            });
        }
        for (const [columnIndex, column] of entity.columns.entries()) {
            const header = resolveColumnHeader(entityElement, column.name, column.fieldKey);
            if (header) {
                targets.push({
                    annotationId: column.id,
                    kind: 'column',
                    state: markerState(column.origin, column.id, selectedAnnotationId, checks),
                    elements: [header],
                    columnPosition: columnIndex === 0
                        ? 'first'
                        : columnIndex === entity.columns.length - 1 ? 'last' : 'middle',
                    primaryKey: entity.primaryKey?.fieldKey === column.fieldKey,
                    columnGroup: header.closest('tr') ?? header.parentElement ?? undefined,
                    recordSemantic: {
                        profileName: draft.profileName,
                        businessTag: entity.businessTag,
                        entityKind: entity.kind,
                        fieldKey: column.fieldKey,
                    },
                });
            }
            for (const action of column.actions) {
                const elements = resolveTargetElements(action.target, entityElement);
                if (elements.length === 0) {continue;}
                for (const element of elements) {
                    const rowPrimaryKey = resolveRowPrimaryKey(element, entityElement, entity);
                    targets.push({
                        annotationId: action.id,
                        kind: 'action',
                        state: markerState(action.origin, action.id, selectedAnnotationId, checks),
                        elements: [element],
                        recordSemantic: {
                            profileName: draft.profileName,
                            businessTag: entity.businessTag,
                            entityKind: entity.kind,
                            actionIntent: action.actionIntent,
                            actionRole: 'row',
                            ...(rowPrimaryKey ? {rowPrimaryKey} : {}),
                        },
                    });
                }
            }
        }
        if (entity.pagination) {
            const annotationId = `${entity.id}_pgpage`;
            const elements = paginationElements(
                resolveTargetElements(entity.pagination.pageTarget, entityElement),
                entityElement,
            );
            if (elements.length > 0) {
                targets.push({
                    annotationId,
                    kind: 'pagination',
                    state: markerState(entity.origin, annotationId, selectedAnnotationId, checks),
                    elements,
                    recordSemantic: {
                        profileName: draft.profileName,
                        businessTag: entity.businessTag,
                        entityKind: entity.kind,
                    },
                });
            }
        }
    }
    return targets;
};

const resolveRowPrimaryKey = (
    actionElement: Element,
    entityElement: Element,
    entity: CanvasDraft['entities'][number],
): {fieldKey: string; value: string} | undefined => {
    const fieldKey = entity.primaryKey?.fieldKey;
    if (!fieldKey) {return undefined;}
    const column = entity.columns.find((candidate) => candidate.fieldKey === fieldKey);
    if (!column) {return undefined;}
    const header = resolveColumnHeader(entityElement, column.name, column.fieldKey);
    const headerRow = header?.closest('tr, [role="row"]');
    const row = actionElement.closest('tr, [role="row"]');
    if (!header || !headerRow || !row) {return undefined;}
    const headerCells = Array.from(headerRow.children)
        .filter((element) => element.matches('th, td, [role="columnheader"], [role="cell"], [role="gridcell"]'));
    const columnIndex = headerCells.indexOf(header);
    if (columnIndex < 0) {return undefined;}
    const cells = Array.from(row.children)
        .filter((element) => element.matches('th, td, [role="cell"], [role="gridcell"]'));
    const value = cells[columnIndex]?.textContent?.replace(/\s+/gu, ' ').trim();
    return value ? {fieldKey, value} : undefined;
};

export const clearDomMarkers = (documentRef: Document): void => {
    for (const element of Array.from(documentRef.querySelectorAll(`[${MARKER_ATTR}]`))) {
        element.removeAttribute(MARKER_ATTR);
        element.removeAttribute(KIND_ATTR);
        element.removeAttribute(STATE_ATTR);
        element.removeAttribute(COLUMN_POSITION_ATTR);
        element.removeAttribute(PRIMARY_KEY_ATTR);
        element.removeAttribute(RECORD_SEMANTIC_ATTR);
    }
    for (const element of Array.from(documentRef.querySelectorAll(`[${COLUMN_GROUP_ATTR}]`))) {
        element.removeAttribute(COLUMN_GROUP_ATTR);
    }
    documentRef.getElementById(STYLE_ID)?.remove();
};

export const applyDomMarkers = (
    draft: CanvasDraft,
    documentRef: Document,
    selectedAnnotationId: string | null,
    checks: CheckResultByAnnotation[] | null,
): void => {
    clearDomMarkers(documentRef);
    const style = documentRef.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    documentRef.documentElement.appendChild(style);
    for (const target of collectMarkerTargets(draft, documentRef, selectedAnnotationId, checks)) {
        target.columnGroup?.setAttribute(COLUMN_GROUP_ATTR, 'true');
        for (const element of target.elements) {
            element.setAttribute(MARKER_ATTR, target.annotationId);
            element.setAttribute(KIND_ATTR, target.kind);
            element.setAttribute(STATE_ATTR, target.state);
            element.setAttribute(RECORD_SEMANTIC_ATTR, JSON.stringify(target.recordSemantic));
            if (target.columnPosition) {
                element.setAttribute(COLUMN_POSITION_ATTR, target.columnPosition);
            }
            if (target.primaryKey) {
                element.setAttribute(PRIMARY_KEY_ATTR, 'true');
            }
        }
    }
};

export const annotationIdFromDomTarget = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) {return null;}
    return target.closest(`[${MARKER_ATTR}]`)?.getAttribute(MARKER_ATTR) ?? null;
};
