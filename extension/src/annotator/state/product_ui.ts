import type {AnnotationBox} from '../layout/annotation_boxes.js';
import type {
    CanvasEntityDraft,
    CheckResultByAnnotation,
    PickCandidate,
    PickPurpose,
} from '../types.js';

export type AnnotatorProductStage = 'scope' | 'recognize' | 'review' | 'edit';

export type CanvasPresentation = {
    dimOutsideEntity: boolean;
    showEntity: boolean;
    showObjects: boolean;
    showLabels: boolean;
    showEditor: boolean;
};

export const deriveCanvasPresentation = (
    stage: AnnotatorProductStage,
    pickMode: boolean,
    hasEntity: boolean,
): CanvasPresentation => {
    if (!hasEntity || stage === 'scope') {
        return {
            dimOutsideEntity: false,
            showEntity: false,
            showObjects: false,
            showLabels: false,
            showEditor: false,
        };
    }
    const inspectable = !pickMode && (stage === 'review' || stage === 'edit');
    return {
        dimOutsideEntity: true,
        showEntity: true,
        showObjects: inspectable,
        showLabels: inspectable,
        showEditor: inspectable,
    };
};

const KIND_COLOR: Record<AnnotationBox['kind'], string> = {
    entity: '#2563eb',
    field: '#16a34a',
    action: '#ea580c',
    column: '#7c3aed',
    pagination: '#0f766e',
};

export type AnnotationVisualState = {
    status: 'inferred' | 'confirmed' | 'error' | 'ignored';
    dashed: boolean;
    color: string;
};

export const annotationVisualState = (
    box: AnnotationBox,
    check: CheckResultByAnnotation | null,
): AnnotationVisualState => {
    if (box.disposition === 'ignored') {
        return {status: 'ignored', dashed: true, color: '#94a3b8'};
    }
    const broken = check && (
        check.status === 'missing' ||
        check.status === 'invalid' ||
        (check.status === 'multiple' && check.expected === 'unique')
    );
    if (broken) {
        return {status: 'error', dashed: false, color: '#dc2626'};
    }
    if (box.origin === 'inferred') {
        return {status: 'inferred', dashed: true, color: KIND_COLOR[box.kind]};
    }
    return {status: 'confirmed', dashed: false, color: KIND_COLOR[box.kind]};
};

export const deriveProductStage = (input: {
    hasDraft: boolean;
    hasObjects: boolean;
    hasArtifact: boolean;
    reviewPending: boolean;
}): AnnotatorProductStage => {
    if (!input.hasDraft) {return 'scope';}
    if (!input.hasObjects) {return 'recognize';}
    if (!input.hasArtifact && input.reviewPending) {return 'review';}
    return 'edit';
};

export type EntityObjectSummary = {
    fields: number;
    queryActions: number;
    columns: number;
    rowActions: number;
    pagination: number;
    total: number;
};

export const summarizeEntityDraft = (entity: CanvasEntityDraft | null): EntityObjectSummary => {
    if (!entity) {
        return {fields: 0, queryActions: 0, columns: 0, rowActions: 0, pagination: 0, total: 0};
    }
    const fields = entity.annotations.filter((item) => item.type === 'field').length;
    const queryActions = entity.annotations.filter((item) => item.type === 'action').length;
    const rowActions = entity.columns.reduce((sum, column) => sum + column.actions.length, 0);
    const columns = entity.columns.length;
    const pagination = entity.pagination ? 1 : 0;
    return {
        fields,
        queryActions,
        columns,
        rowActions,
        pagination,
        total: fields + queryActions + columns + rowActions + pagination,
    };
};

export type AnnotationBoxGroups = {
    fields: AnnotationBox[];
    actions: AnnotationBox[];
    columns: AnnotationBox[];
    pagination: AnnotationBox[];
};

export const groupAnnotationBoxes = (boxes: AnnotationBox[]): AnnotationBoxGroups => ({
    fields: boxes.filter((item) => item.kind === 'field'),
    actions: boxes.filter((item) => item.kind === 'action'),
    columns: boxes.filter((item) => item.kind === 'column'),
    pagination: boxes.filter((item) => item.kind === 'pagination'),
});

const fallbackByLevel: Record<PickCandidate['level'], string> = {
    control: '操作',
    field: '字段',
    row: '数据行',
    group: '业务区域',
    region: '业务区域',
    unknown: '页面对象',
};

export const candidateDisplayName = (
    candidate: PickCandidate | null,
    purpose: PickPurpose,
): string => {
    if (!candidate) {return purpose === 'entity' ? '业务区域' : '页面对象';}
    const text = candidate.text?.replace(/\s+/g, ' ').trim();
    if (text) {return text.length > 28 ? `${text.slice(0, 28)}…` : text;}
    if (purpose === 'entity') {return '业务区域';}
    return fallbackByLevel[candidate.level];
};

export const checkIssueMessage = (
    stale: boolean,
    issue: CheckResultByAnnotation | null,
    label: string | null,
): string | null => {
    if (stale) {
        return '页面内容已经变化。请重新识别后再保存。';
    }
    if (!issue) {return null;}
    const name = label || '这个对象';
    if (issue.status === 'missing') {
        return `“${name}”未能在页面中找到，请重新选择它的位置。`;
    }
    if (issue.status === 'multiple' && issue.expected === 'unique') {
        return `“${name}”匹配到多个对象，请缩小选择范围。`;
    }
    if (issue.status === 'invalid') {
        return `“${name}”的标注无效，请重新选择或检查高级设置。`;
    }
    return null;
};
