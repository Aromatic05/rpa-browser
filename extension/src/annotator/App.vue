<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue';
import AnnotatorCanvas from './canvas/AnnotatorCanvas.vue';
import LabelLayer from './labels/LabelLayer.vue';
import PickOverlay from './picking/PickOverlay.vue';
import EditCard from './canvas/EditCard.vue';
import type {AnnotatorClient} from './protocol/annotator_client.js';
import {
    undo,
    redo,
    draftEdited,
    pickReceived,
    failed,
    type AnnotatorState,
} from './state/annotator_state.js';
import type {SessionStore} from './state/session_store.js';
import {
    runCheckLoop,
    runSaveLoop,
    runRecognizeLoop,
    restoreSessionDraft,
    persistSessionDraft,
    decideSelectAction,
} from './state/annotator_loop.js';
import {resolveKeyboardAction} from './keyboard.js';
import {
    addAnnotation,
    createEntityScopeDraft,
    deleteVisualItem,
    ignoreVisualItem,
    replaceVisualItemSelection,
    updateAnnotation,
    updateColumn,
    updateColumnAction,
    updateEntity,
    updatePagination,
} from './state/draft_ops.js';
import {
    annotationLabelTarget,
    deriveAnnotationBoxes,
    type AnnotationBox,
} from './layout/annotation_boxes.js';
import {computeLabelPlacements} from './layout/label_layout.js';
import {createViewportScheduler} from './layout/viewport_tracker.js';
import {
    chooseCandidate,
    selectInner,
    selectOuter,
} from './picking/candidate_navigation.js';
import {attachPickerListeners, type PickerDetach} from './picking/dom_adapter.js';
import {planAnnotationFromCandidate} from './recommend/candidate_to_annotation.js';
import type {RecommendedType} from './recommend/recommend_types.js';
import type {
    AnnotatorPickResult,
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    EntityKind,
    PickCandidate,
    PickFingerprint,
    PickPurpose,
    PickRect,
} from './types.js';
import {entityVisualId, paginationPageVisualId} from './visual_ids.js';
import {
    checkIssueMessage,
    deriveProductStage,
    groupAnnotationBoxes,
    summarizeEntityDraft,
    type AnnotatorProductStage,
} from './state/product_ui.js';
import {enrichInferredFieldNamesFromDom} from './state/dom_labels.js';

const props = defineProps<{
    state: AnnotatorState;
    client: AnnotatorClient | null;
    sessionStore?: SessionStore | null;
}>();

const emit = defineEmits<{
    (e: 'exit'): void;
    (e: 'pickModeChange', picking: boolean): void;
}>();

const viewport = ref({
    width: 1280,
    height: 720,
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
});
const hoverBox = ref<PickRect | null>(null);
const pointer = ref<{x: number; y: number} | null>(null);
const pickMode = ref(false);
const pickPurpose = ref<PickPurpose>('annotation');
const operation = ref<'recognize' | 'check' | 'save' | 'pick' | null>(null);
const panelCollapsed = ref(false);
const reviewPending = ref(false);
const pickTargetEntityId = ref<string | null>(null);
const pickTargetAnnotationId = ref<string | null>(null);
const pickCandidates = ref<PickCandidate[]>([]);
const pickCandidateIndex = ref(0);
const pickPointer = ref<{x: number; y: number} | null>(null);
let pickerDetach: PickerDetach | null = null;
let mutationObserver: MutationObserver | null = null;

const win = () => (typeof window !== 'undefined' ? window : null);

let visualBindingRequest = 0;
const refreshVisualBindings = async (): Promise<void> => {
    const page = props.state.pageIdentity;
    if (!props.client || !page || !props.state.canvasDraft || props.state.mode !== 'editing' || props.state.dirty) {return;}
    const request = ++visualBindingRequest;
    try {
        const result = await props.client.open(page);
        if (request !== visualBindingRequest || props.state.mode !== 'editing' || props.state.dirty) {return;}
        applyState({...props.state, visualBindings: result.visualTargetRefs});
    } catch {
        // Rendering should remain responsive when a fresh snapshot is temporarily unavailable.
    }
};

const refreshViewport = (): void => {
    const w = win();
    if (!w) {return;}
    viewport.value = {
        width: w.innerWidth,
        height: w.innerHeight,
        scrollX: w.scrollX,
        scrollY: w.scrollY,
        zoom: 1,
    };
    void refreshVisualBindings();
};

const scheduler = createViewportScheduler(refreshViewport);

const applyState = (next: AnnotatorState): void => {
    Object.assign(props.state, next);
};

const applyUndo = (): void => applyState(undo(props.state));
const applyRedo = (): void => applyState(redo(props.state));

const annotationBoxes = computed<AnnotationBox[]>(() =>
    deriveAnnotationBoxes(
        props.state.canvasDraft,
        props.state.visualBindings,
        props.state.currentEntityId,
        props.state.latestCheck,
    ),
);

const labelTargets = computed(() =>
    annotationBoxes.value
        .map((box) => annotationLabelTarget(box))
        .filter((target): target is NonNullable<typeof target> => target !== null),
);

const placements = computed(() =>
    computeLabelPlacements(
        labelTargets.value,
        {
            width: !panelCollapsed.value && !pickMode.value
                ? Math.max(320, viewport.value.width - 372)
                : viewport.value.width,
            height: viewport.value.height,
        },
        {},
    ),
);

const entities = computed<CanvasEntityDraft[]>(() =>
    props.state.canvasDraft ? props.state.canvasDraft.entities : [],
);

const visualItemCount = computed(() => entities.value.reduce(
    (count, entity) => count + entity.annotations.length + entity.columns.length +
        entity.columns.reduce((sum, column) => sum + column.actions.length, 0) +
        (entity.pagination ? 1 : 0),
    entities.value.length,
));

const currentEntity = computed<CanvasEntityDraft | null>(() => {
    if (!props.state.currentEntityId) {return null;}
    return entities.value.find((entity) => entity.id === props.state.currentEntityId) ?? null;
});

const hasInternalObjects = computed(() => {
    const entity = currentEntity.value;
    if (!entity) {return false;}
    return entity.annotations.length > 0 || entity.columns.length > 0 || Boolean(entity.pagination);
});

const productStage = computed<AnnotatorProductStage>(() => deriveProductStage({
    hasDraft: Boolean(props.state.canvasDraft),
    hasObjects: hasInternalObjects.value,
    hasArtifact: Boolean(props.state.artifactRevision),
    reviewPending: reviewPending.value,
}));

const productStep = computed(() => {
    if (productStage.value === 'scope') {return 1;}
    if (productStage.value === 'recognize' || productStage.value === 'review') {return 2;}
    return 3;
});

const objectSummary = computed(() => summarizeEntityDraft(currentEntity.value));

const isBusy = computed(() => operation.value !== null || props.state.mode === 'checking' || props.state.mode === 'saving');
const busyLabel = computed(() => {
    if (operation.value === 'recognize') {return '正在分析当前页面…';}
    if (operation.value === 'check' || props.state.mode === 'checking') {return '正在检查标注…';}
    if (operation.value === 'save' || props.state.mode === 'saving') {return '正在保存规则…';}
    if (operation.value === 'pick') {return '正在识别所选对象…';}
    return '';
});

const selectedBox = computed<AnnotationBox | null>(() => {
    if (!props.state.currentAnnotationId) {return null;}
    return annotationBoxes.value.find((box) => box.annotationId === props.state.currentAnnotationId) ?? null;
});

const selectedEntity = computed<CanvasEntityDraft | null>(() => {
    if (!selectedBox.value) {return currentEntity.value;}
    return entities.value.find((entity) => entity.id === selectedBox.value!.entityId) ?? null;
});

const selectedAnnotation = computed<CanvasAnnotationDraft | null>(() => {
    const annotationId = props.state.currentAnnotationId;
    const entity = selectedEntity.value;
    if (!annotationId || !entity) {return null;}
    const annotation = entity.annotations.find((item) => item.id === annotationId);
    if (annotation) {return annotation;}
    if (annotationId === entityVisualId(entity.id)) {
        return {
            id: annotationId,
            type: 'field',
            name: entity.name,
            businessKey: entity.businessTag,
            target: entity.target,
            origin: entity.origin,
            disposition: 'active',
        };
    }
    const column = entity.columns.find((item) => item.id === annotationId);
    if (column) {
        return {
            id: column.id,
            type: 'field',
            name: column.name,
            businessKey: column.fieldKey,
            target: {},
            origin: column.origin,
            disposition: column.disposition,
        };
    }
    for (const action of entity.columns.flatMap((item) => item.actions)) {
        if (action.id === annotationId) {
            return {
                id: action.id,
                type: 'action',
                name: action.text,
                businessKey: action.actionIntent,
                target: action.target,
                origin: action.origin,
                disposition: action.disposition,
            };
        }
    }
    if (annotationId === paginationPageVisualId(entity.id) && entity.pagination) {
        return {
            id: annotationId,
            type: 'pagination',
            name: '下一页',
            businessKey: entity.pagination.actionIntent,
            target: entity.pagination.pageTarget,
            origin: entity.origin,
            disposition: 'active',
        };
    }
    return null;
});

const selectedIsNativeAnnotation = computed(() => {
    if (!selectedAnnotation.value || !selectedEntity.value) {return false;}
    return selectedEntity.value.annotations.some((item) => item.id === selectedAnnotation.value!.id);
});

const currentVisualItems = computed(() => annotationBoxes.value.filter((box) =>
    box.kind !== 'entity' && (!currentEntity.value || box.entityId === currentEntity.value.id),
));

const groupedVisualItems = computed(() => groupAnnotationBoxes(currentVisualItems.value));

const directActionIds = computed(() => new Set(
    currentEntity.value?.annotations
        .filter((item) => item.type === 'action')
        .map((item) => item.id) ?? [],
));

const rowActionIds = computed(() => new Set(
    currentEntity.value?.columns.flatMap((column) => column.actions.map((action) => action.id)) ?? [],
));

const objectSections = computed(() => [
    {
        key: 'fields',
        title: '查询条件',
        description: '用于筛选或输入查询内容',
        icon: '⌕',
        items: groupedVisualItems.value.fields,
    },
    {
        key: 'page-actions',
        title: '查询操作',
        description: '查询、重置等页面操作',
        icon: '↗',
        items: groupedVisualItems.value.actions.filter((item) => directActionIds.value.has(item.annotationId)),
    },
    {
        key: 'columns',
        title: '表格列',
        description: '结果列表中可引用的数据列',
        icon: '▦',
        items: groupedVisualItems.value.columns,
    },
    {
        key: 'row-actions',
        title: '行操作',
        description: '编辑、删除等单条数据操作',
        icon: '⋯',
        items: groupedVisualItems.value.actions.filter((item) => rowActionIds.value.has(item.annotationId)),
    },
    {
        key: 'pagination',
        title: '翻页',
        description: '用于切换结果页',
        icon: '→',
        items: groupedVisualItems.value.pagination,
    },
].filter((section) => section.items.length > 0));

const kindLabel = (kind: AnnotationBox['kind']): string => ({
    entity: '实体',
    field: '字段',
    action: '操作',
    column: '表格列',
    pagination: '分页',
}[kind]);

const itemStatus = (box: AnnotationBox): string => {
    const result = props.state.latestCheck?.find((item) => item.canvasAnnotationId === box.annotationId);
    if (!result) {return box.origin === 'inferred' ? '待确认' : '已确认';}
    if (result.status === 'unique') {return '已通过';}
    if (result.status === 'multiple') {return `匹配 ${result.matchCount} 个`;}
    if (result.status === 'missing') {return '未找到';}
    return '有问题';
};

const itemStatusTone = (box: AnnotationBox): 'success' | 'warning' | 'danger' | 'neutral' => {
    const result = props.state.latestCheck?.find((item) => item.canvasAnnotationId === box.annotationId);
    if (!result) {return box.origin === 'inferred' ? 'warning' : 'neutral';}
    if (result.status === 'unique' || (result.expected === 'one_or_more' && result.status === 'multiple')) {
        return 'success';
    }
    return result.status === 'missing' || result.status === 'invalid' ? 'danger' : 'warning';
};

const statusText = computed(() => {
    if (isBusy.value) {return busyLabel.value;}
    if (props.state.stale) {return '页面内容已变化';}
    if (props.state.dirty) {return '有未保存修改';}
    if (props.state.artifactRevision) {return '已保存';}
    if (props.state.canvasDraft) {return '尚未保存';}
    return '等待识别';
});

const hasBlockingCheckIssue = (state: AnnotatorState): boolean => Boolean(
    state.stale || state.latestCheck?.some((item) =>
        item.status === 'missing' ||
        item.status === 'invalid' ||
        (item.expected === 'unique' && item.status === 'multiple'),
    ),
);

const firstBlockingCheckIssue = (state: AnnotatorState) => state.latestCheck?.find((item) =>
    item.status === 'missing' ||
    item.status === 'invalid' ||
    (item.expected === 'unique' && item.status === 'multiple'),
);

const selectEntity = (entityId: string): void => {
    applyState(pickReceived(props.state, {
        entityId,
        annotationId: entityVisualId(entityId),
    }));
};

const updateSelectedAnnotation = (patch: Partial<CanvasAnnotationDraft>): void => {
    if (!selectedEntity.value || !selectedAnnotation.value) {return;}
    onUpdateAnnotation(selectedEntity.value.id, selectedAnnotation.value.id, patch);
};

const profileNameModel = computed({
    get: () => props.state.profileName ?? '',
    set: (value: string) => {
        if (!props.state.canvasDraft) {return;}
        const profileName = value.trim();
        const nextDraft = {...props.state.canvasDraft, profileName};
        applyState({...draftEdited(props.state, nextDraft), profileName});
    },
});

const entityNameModel = computed({
    get: () => currentEntity.value?.name ?? '',
    set: (value: string) => {
        if (!props.state.canvasDraft || !currentEntity.value) {return;}
        const nextDraft = updateEntity(
            props.state.canvasDraft,
            currentEntity.value.id,
            {name: value.trim() || '业务区域'},
        );
        applyState(draftEdited(props.state, nextDraft));
    },
});

const selectedCandidate = computed<PickCandidate | null>(() =>
    chooseCandidate(pickCandidates.value, pickCandidateIndex.value),
);

const selectedAnnotationEntityId = computed<string | null>(() => {
    if (!props.state.currentAnnotationId) {return null;}
    return entityIdForAnnotation(props.state.currentAnnotationId);
});

const onSelectAnnotation = (annotationId: string): void => {
    const entityId = entityIdForAnnotation(annotationId);
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickTargetAnnotationId.value = null;
    applyState(pickReceived(props.state, {annotationId, entityId}));
    if (decideSelectAction(annotationId, props.state.latestCheck).reselect) {
        enterPickMode(annotationId);
    }
};

const runCheck = async (): Promise<void> => {
    if (!props.state.canvasDraft || pickMode.value || isBusy.value) {return;}
    operation.value = 'check';
    applyState({...props.state, mode: 'checking', error: null});
    try {
        const next = await runCheckLoop(props.state, props.client);
        applyState(next);
    } finally {
        operation.value = null;
    }
};

const runCheckAndSave = async (): Promise<void> => {
    if (!props.state.canvasDraft || !props.state.dirty || pickMode.value || isBusy.value) {return;}
    operation.value = 'check';
    applyState({...props.state, mode: 'checking', error: null});
    try {
        const checked = await runCheckLoop(props.state, props.client);
        if (checked.error) {
            applyState(checked);
            return;
        }
        if (hasBlockingCheckIssue(checked)) {
            const issue = firstBlockingCheckIssue(checked) ?? null;
            const label = issue
                ? annotationBoxes.value.find((item) => item.annotationId === issue.canvasAnnotationId)?.labelName ?? null
                : null;
            const entityId = issue ? entityIdForAnnotation(issue.canvasAnnotationId) : null;
            const focused = issue
                ? pickReceived(checked, {annotationId: issue.canvasAnnotationId, entityId})
                : checked;
            const message = checkIssueMessage(checked.stale, issue, label);
            applyState(message ? failed(focused, message) : focused);
            return;
        }
        applyState(checked);
        operation.value = 'save';
        applyState({...checked, mode: 'saving', error: null});
        const saved = await runSaveLoop(checked, props.client, props.sessionStore);
        applyState(saved);
    } finally {
        operation.value = null;
    }
};

const runRecognize = async (): Promise<void> => {
    if (pickMode.value || isBusy.value) {return;}
    operation.value = 'recognize';
    applyState({...props.state, error: null});
    try {
        const wasFirstRecognition = !hasInternalObjects.value && !props.state.artifactRevision;
        const next = await runRecognizeLoop(props.state, props.client);
        const documentRef = win()?.document;
        const enriched = next.canvasDraft && documentRef
            ? {...next, canvasDraft: enrichInferredFieldNamesFromDom(next.canvasDraft, documentRef)}
            : next;
        applyState(enriched);
        if (!enriched.error && wasFirstRecognition && enriched.canvasDraft?.entities[0]) {
            reviewPending.value = true;
            applyState(pickReceived(enriched, {
                entityId: enriched.canvasDraft.entities[0].id,
                annotationId: null,
            }));
        }
    } finally {
        operation.value = null;
    }
};

const entityIdForAnnotation = (annotationId: string): string | null => {
    for (const entity of entities.value) {
        if (entity.annotations.some((a) => a.id === annotationId)) {
            return entity.id;
        }
        if (entity.columns.some((column) =>
            column.id === annotationId || column.actions.some((action) => action.id === annotationId),
        )) {
            return entity.id;
        }
        if (annotationId === paginationPageVisualId(entity.id)) {
            return entity.id;
        }
        if (annotationId === entityVisualId(entity.id)) {
            return entity.id;
        }
    }
    return null;
};

const ensurePickTargetEntity = (): string | null => {
    if (pickTargetEntityId.value) {return pickTargetEntityId.value;}
    if (selectedAnnotationEntityId.value) {return selectedAnnotationEntityId.value;}
    if (props.state.currentEntityId) {return props.state.currentEntityId;}
    const first = entities.value[0];
    return first ? first.id : null;
};

const enterPickMode = (annotationId: string | null): void => {
    if (!props.state.canvasDraft || !ensurePickTargetEntity()) {
        applyState(failed(props.state, '请先选择并确认实体区域。'));
        return;
    }
    pickPurpose.value = 'annotation';
    pickTargetAnnotationId.value = annotationId;
    pickTargetEntityId.value = ensurePickTargetEntity();
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickPointer.value = null;
    pickMode.value = true;
    applyState({...props.state, error: null});
};

const enterEntityPickMode = (): void => {
    pickPurpose.value = 'entity';
    pickTargetAnnotationId.value = null;
    pickTargetEntityId.value = null;
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickPointer.value = null;
    pickMode.value = true;
    reviewPending.value = false;
    applyState({...props.state, error: null});
};

const exitPickMode = (options: {keepChain?: boolean} = {}): void => {
    pickMode.value = false;
    if (!options.keepChain) {
        pickCandidates.value = [];
        pickCandidateIndex.value = 0;
        pickTargetAnnotationId.value = null;
    }
    pickPointer.value = null;
    hoverBox.value = null;
    pointer.value = null;
    if (!options.keepChain) {pickPurpose.value = 'annotation';}
};

const onHoverUpdate = (rect: PickRect | null, p: {x: number; y: number}): void => {
    hoverBox.value = rect;
    pointer.value = p;
};

const onPickEvent = async (event: {fingerprint: PickFingerprint; pointer: {x: number; y: number}}): Promise<void> => {
    if (operation.value === 'pick') {return;}
    if (!props.client) {
        applyState(failed(props.state, 'picker unavailable: no dispatch client'));
        return;
    }
    pickPointer.value = event.pointer;
    operation.value = 'pick';
    let result: AnnotatorPickResult;
    try {
        result = await props.client.pick({fingerprint: event.fingerprint, purpose: pickPurpose.value});
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applyState(failed(props.state, `pick failed: ${message}`));
        return;
    } finally {
        operation.value = null;
    }
    pickCandidates.value = result.candidateChain;
    pickCandidateIndex.value = result.candidateChain.length > 0
        ? (pickPurpose.value === 'entity' ? result.candidateChain.length - 1 : 0)
        : -1;
};

const onPickConfirm = (): void => {
    const candidate = selectedCandidate.value;
    if (!candidate) {return;}
    if (pickPurpose.value === 'entity') {
        try {
            const nextDraft = createEntityScopeDraft(candidate);
            applyState(draftEdited(props.state, nextDraft));
            applyState(pickReceived(props.state, {
                entityId: nextDraft.entities[0].id,
                annotationId: null,
            }));
            reviewPending.value = false;
            exitPickMode();
        } catch (error) {
            applyState(failed(props.state, error instanceof Error ? error.message : String(error)));
        }
        return;
    }
    const entityId = ensurePickTargetEntity();
    if (!entityId) {
        applyState(failed(props.state, 'cannot confirm pick without an active entity'));
        return;
    }
    const entity = entities.value.find((e) => e.id === entityId);
    if (!entity) {
        applyState(failed(props.state, `entity not found: ${entityId}`));
        return;
    }
    const plan = planAnnotationFromCandidate(candidate, entity);
    if (!props.state.canvasDraft) {return;}
    let nextDraft: CanvasDraft;
    if (pickTargetAnnotationId.value) {
        nextDraft = replaceVisualItemSelection(
            props.state.canvasDraft,
            entityId,
            pickTargetAnnotationId.value,
            {target: plan.annotation.target, name: candidate.text},
        );
    } else {
        nextDraft = addAnnotation(props.state.canvasDraft, entityId, plan.annotation);
    }
    applyState(draftEdited(props.state, nextDraft));
    const newAnnotationId = pickTargetAnnotationId.value ?? plan.annotation.id;
    applyState(pickReceived(props.state, {annotationId: newAnnotationId, entityId}));
    pickTargetAnnotationId.value = newAnnotationId;
    exitPickMode({keepChain: true});
};

const onPickCancel = (): void => {
    exitPickMode();
};

const onNavigate = (direction: 'outer' | 'inner'): void => {
    if (pickCandidates.value.length === 0) {return;}
    const next = direction === 'outer'
        ? selectOuter(pickCandidates.value, pickCandidateIndex.value)
        : selectInner(pickCandidates.value, pickCandidateIndex.value);
    if (next === pickCandidateIndex.value) {return;}
    pickCandidateIndex.value = next;
    if (!pickMode.value && pickTargetAnnotationId.value) {
        const candidate = chooseCandidate(pickCandidates.value, next);
        const entityId = ensurePickTargetEntity();
        if (candidate && entityId && props.state.canvasDraft) {
            const plan = planAnnotationFromCandidate(
                candidate,
                entities.value.find((e) => e.id === entityId)!,
            );
            const nextDraft = replaceVisualItemSelection(
                props.state.canvasDraft,
                entityId,
                pickTargetAnnotationId.value,
                {target: plan.annotation.target, name: candidate.text},
            );
            applyState(draftEdited(props.state, nextDraft));
        }
    }
};

const onUpdateAnnotation = (
    entityId: string,
    annotationId: string,
    patch: Partial<CanvasAnnotationDraft>,
): void => {
    if (!props.state.canvasDraft) {return;}
    const entity = entities.value.find((item) => item.id === entityId);
    if (!entity) {return;}
    let nextDraft: CanvasDraft;
    if (annotationId === entityVisualId(entityId)) {
        nextDraft = updateEntity(props.state.canvasDraft, entityId, {name: patch.name, businessTag: patch.businessKey});
    } else if (entity.columns.some((column) => column.id === annotationId)) {
        nextDraft = updateColumn(props.state.canvasDraft, entityId, annotationId, {name: patch.name, fieldKey: patch.businessKey});
    } else if (entity.columns.some((column) => column.actions.some((action) => action.id === annotationId))) {
        nextDraft = updateColumnAction(props.state.canvasDraft, entityId, annotationId, {text: patch.name, actionIntent: patch.businessKey});
    } else if (annotationId === paginationPageVisualId(entityId)) {
        nextDraft = updatePagination(props.state.canvasDraft, entityId, {actionIntent: patch.businessKey || patch.name || ''});
    } else {
        nextDraft = updateAnnotation(props.state.canvasDraft, entityId, annotationId, patch);
    }
    applyState(draftEdited(props.state, nextDraft));
};

const onDeleteAnnotation = (annotationId: string): void => {
    if (!props.state.canvasDraft) {return;}
    const entityId = entityIdForAnnotation(annotationId);
    if (!entityId) {return;}
    const nextDraft = deleteVisualItem(props.state.canvasDraft, entityId, annotationId);
    applyState(draftEdited(props.state, nextDraft));
    applyState(pickReceived(props.state, {annotationId: null, entityId}));
};

const onIgnoreAnnotation = (annotationId: string): void => {
    if (!props.state.canvasDraft) {return;}
    const entityId = entityIdForAnnotation(annotationId);
    if (!entityId) {return;}
    const nextDraft = ignoreVisualItem(props.state.canvasDraft, entityId, annotationId);
    applyState(draftEdited(props.state, nextDraft));
};

const onChooseType = (recommended: RecommendedType): void => {
    const candidate = selectedCandidate.value;
    if (!candidate) {return;}
    const entityId = ensurePickTargetEntity();
    const entity = entities.value.find((e) => e.id === entityId);
    if (!entity) {return;}
    const plan = planAnnotationFromCandidate(candidate, entity, recommended);
    if (pickTargetAnnotationId.value) {
        onUpdateAnnotation(entity.id, pickTargetAnnotationId.value, {
            type: plan.annotation.type,
            target: plan.annotation.target,
        });
    }
};

const onKeyDown = (event: KeyboardEvent): void => {
    const action = resolveKeyboardAction(event, {
        annotatorActive: props.state.mode !== 'idle',
        inPickMode: pickMode.value,
        hasSelection: props.state.currentAnnotationId !== null,
        canUndo: props.state.history.past.length > 0,
        canRedo: props.state.history.future.length > 0,
    });
    switch (action.type) {
        case 'cancel':
            if (pickMode.value) {
                onPickCancel();
            } else if (props.state.currentAnnotationId) {
                applyState(pickReceived(props.state, {annotationId: null}));
            }
            break;
        case 'confirm':
            if (pickMode.value) {
                onPickConfirm();
            }
            break;
        case 'delete':
            if (props.state.currentAnnotationId) {
                onDeleteAnnotation(props.state.currentAnnotationId);
            }
            break;
        case 'save':
            event.preventDefault();
            void runCheckAndSave();
            break;
        case 'undo':
            event.preventDefault();
            applyUndo();
            break;
        case 'redo':
            event.preventDefault();
            applyRedo();
            break;
        case 'none':
            break;
    }
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const schedulePersist = (): void => {
    if (!props.state.dirty || !props.state.canvasDraft) {
        return;
    }
    if (persistTimer) {
        clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistSessionDraft(props.state, props.sessionStore);
    }, 400);
};

let sessionRestoredFor: string | null = null;

onMounted(() => {
    refreshViewport();
    pickerDetach = attachPickerListeners(document, {
        isActive: () => pickMode.value,
        onHover: onHoverUpdate,
        onPick: (event) => {
            void onPickEvent(event);
        },
    });
    document.addEventListener('keydown', onKeyDown, true);
    const w = win();
    if (w) {
        w.addEventListener('scroll', scheduler.schedule, {capture: true, passive: true});
        w.addEventListener('resize', scheduler.schedule, {passive: true});
        mutationObserver = new MutationObserver(scheduler.schedule);
        mutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
        });
    }
});

onUnmounted(() => {
    scheduler.dispose();
    if (pickerDetach) {
        pickerDetach();
        pickerDetach = null;
    }
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    document.removeEventListener('keydown', onKeyDown, true);
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    const w = win();
    if (w) {
        w.removeEventListener('scroll', scheduler.schedule, {capture: true} as EventListenerOptions);
        w.removeEventListener('resize', scheduler.schedule);
    }
});

watch(
    () => props.state.canvasDraft,
    () => {
        scheduler.schedule();
        schedulePersist();
    },
);

watch(
    pickMode,
    (picking) => {
        emit('pickModeChange', picking);
    },
);

watch(
    () => props.state.mode,
    (mode) => {
        if (mode === 'idle') {
            exitPickMode();
        }
    },
);

watch(
    () => props.state.pageIdentity,
    (pageIdentity) => {
        if (!pageIdentity) {
            return;
        }
        const sig = `${pageIdentity.workspaceName}|${pageIdentity.tabName}|${pageIdentity.url}|${props.state.profileName ?? ''}`;
        if (sessionRestoredFor === sig) {
            return;
        }
        sessionRestoredFor = sig;
        void (async () => {
            const next = await restoreSessionDraft(props.state, props.sessionStore);
            applyState(next);
        })();
    },
    {immediate: true},
);
</script>

<template>
    <div
        class="annotator-shell annotator-root"
        data-rpa-snapshot-ignore="true"
        data-rpa-annotator-host="true"
        :data-annotator-mode="state.mode"
        :data-annotator-draft="state.canvasDraft ? 'present' : 'empty'"
        :data-annotator-profile="state.profileName || ''"
        :data-product-stage="productStage"
        :data-pick-mode="pickMode ? 'active' : 'inactive'"
        :class="{picking: pickMode}"
    >
        <button
            v-if="panelCollapsed && !pickMode"
            type="button"
            class="annotator-restore"
            aria-label="展开页面标注"
            @click="panelCollapsed = false"
        >
            <span class="annotator-restore-icon">✦</span>
            <span>页面标注</span>
            <span v-if="state.dirty" class="annotator-restore-badge"></span>
        </button>

        <aside v-if="!panelCollapsed && !pickMode" class="product-panel">
            <header class="product-header">
                <div class="product-brand">
                    <span class="product-logo">✦</span>
                    <div>
                        <strong>页面标注</strong>
                        <span class="annotator-status" :class="{error: state.error}">{{ statusText }}</span>
                    </div>
                </div>
                <div class="product-window-actions">
                    <button type="button" aria-label="收起标注面板" title="收起" @click="panelCollapsed = true">−</button>
                    <button type="button" aria-label="退出页面标注" title="退出" @click="emit('exit')">×</button>
                </div>
            </header>

            <nav class="product-stepper" aria-label="标注进度">
                <div :class="{active: productStep === 1, complete: productStep > 1}">
                    <span>{{ productStep > 1 ? '✓' : '1' }}</span>
                    <small>选择区域</small>
                </div>
                <i :class="{complete: productStep > 1}"></i>
                <div :class="{active: productStep === 2, complete: productStep > 2}">
                    <span>{{ productStep > 2 ? '✓' : '2' }}</span>
                    <small>确认内容</small>
                </div>
                <i :class="{complete: productStep > 2}"></i>
                <div :class="{active: productStep === 3}">
                    <span>3</span>
                    <small>完成标注</small>
                </div>
            </nav>

            <div v-if="state.error" class="product-error annotator-error-banner" role="alert">
                <span class="product-error-icon">!</span>
                <div>
                    <strong>没有完成这一步</strong>
                    <p>{{ state.error }}</p>
                </div>
                <button
                    type="button"
                    :disabled="isBusy"
                    @click="productStage === 'scope' ? enterEntityPickMode() : (productStage === 'recognize' ? runRecognize() : runCheck())"
                >重试</button>
            </div>

            <div v-if="isBusy" class="product-progress" role="status" aria-live="polite">
                <span class="product-progress-bar"></span>
                <span>{{ busyLabel }}</span>
            </div>

            <main class="product-body">
                <section v-if="productStage === 'scope'" class="stage-screen scope-stage">
                    <div class="scope-illustration" aria-hidden="true">
                        <div class="scope-window">
                            <span class="scope-query"></span>
                            <span class="scope-table"></span>
                            <span class="scope-pagination"></span>
                        </div>
                        <span class="scope-cursor">↖</span>
                    </div>
                    <span class="stage-kicker">第一步</span>
                    <h1>选择要标注的业务区域</h1>
                    <p class="stage-description">
                        点击订单、客户或其他业务模块中的任意位置，再确认完整区域。
                    </p>
                    <div class="scope-criteria">
                        <div><span>⌕</span><strong>查询条件</strong><small>输入和筛选控件</small></div>
                        <div><span>▦</span><strong>结果列表</strong><small>表格或卡片数据</small></div>
                        <div><span>→</span><strong>翻页控件</strong><small>上一页和下一页</small></div>
                    </div>
                    <button
                        type="button"
                        class="primary-action"
                        data-annotator-action="select-entity"
                        :disabled="isBusy"
                        @click="enterEntityPickMode"
                    >
                        <span>在页面中选择区域</span>
                        <span aria-hidden="true">→</span>
                    </button>
                    <small class="stage-footnote">不会点击页面按钮，也不会修改页面数据。</small>
                </section>

                <section v-else-if="productStage === 'recognize'" class="stage-screen recognize-stage">
                    <div class="selected-scope-card annotator-entity-item">
                        <span class="selected-scope-icon">▣</span>
                        <div>
                            <small>已选择区域</small>
                            <strong>{{ currentEntity?.name || '业务区域' }}</strong>
                        </div>
                        <button type="button" @click="enterEntityPickMode">重新选择</button>
                    </div>
                    <span class="stage-kicker">第二步</span>
                    <h1>识别区域内的页面对象</h1>
                    <p class="stage-description">
                        系统只分析刚才确认的区域，并整理成可直接用于自动化的对象。
                    </p>
                    <div class="recognize-preview">
                        <div><span>01</span><p><strong>查询条件</strong><small>输入框、下拉框和筛选项</small></p></div>
                        <div><span>02</span><p><strong>结果与操作</strong><small>表格列、编辑和删除等操作</small></p></div>
                        <div><span>03</span><p><strong>翻页</strong><small>下一页和分页导航</small></p></div>
                    </div>
                    <button
                        type="button"
                        class="primary-action"
                        data-annotator-action="recognize"
                        :disabled="isBusy"
                        @click="runRecognize"
                    >
                        <span>{{ operation === 'recognize' ? '正在识别…' : '开始识别' }}</span>
                        <span aria-hidden="true">→</span>
                    </button>
                </section>

                <section v-else-if="productStage === 'review'" class="stage-screen review-stage">
                    <div class="review-success">✓</div>
                    <span class="stage-kicker">识别完成</span>
                    <h1>确认识别结果</h1>
                    <p class="stage-description">
                        已从“{{ currentEntity?.name || '当前区域' }}”中整理出以下对象。
                    </p>
                    <div class="review-summary">
                        <div><span>⌕</span><strong>{{ objectSummary.fields }}</strong><small>查询条件</small></div>
                        <div><span>↗</span><strong>{{ objectSummary.queryActions }}</strong><small>查询操作</small></div>
                        <div><span>▦</span><strong>{{ objectSummary.columns }}</strong><small>表格列</small></div>
                        <div><span>⋯</span><strong>{{ objectSummary.rowActions }}</strong><small>行操作</small></div>
                        <div><span>→</span><strong>{{ objectSummary.pagination }}</strong><small>翻页</small></div>
                    </div>
                    <div class="review-note">
                        <span>i</span>
                        <p>识别结果尚未保存。进入编辑后可以改名、重新选择或删除对象。</p>
                    </div>
                    <button type="button" class="primary-action" @click="reviewPending = false">
                        <span>查看并调整对象</span>
                        <span aria-hidden="true">→</span>
                    </button>
                    <div class="review-secondary-actions">
                        <button type="button" :disabled="isBusy" @click="runRecognize">重新识别</button>
                        <button type="button" :disabled="isBusy" @click="enterEntityPickMode">重新选择区域</button>
                    </div>
                </section>

                <section v-else class="editor-stage">
                    <template v-if="selectedAnnotation && selectedBox?.kind !== 'entity'">
                        <div class="editor-toolbar">
                            <button
                                type="button"
                                class="back-action"
                                @click="applyState(pickReceived(state, {annotationId: null, entityId: currentEntity?.id || null}))"
                            >
                                <span aria-hidden="true">←</span>
                                返回对象列表
                            </button>
                        </div>
                        <div class="inspector-container">
                            <EditCard
                                :annotation="selectedAnnotation"
                                :entity="selectedEntity"
                                :candidate="selectedCandidate"
                                :candidate-index="pickCandidateIndex"
                                :candidate-chain-length="pickCandidates.length"
                                :can-change-type="selectedIsNativeAnnotation"
                                :can-delete="true"
                                :can-ignore="selectedBox?.kind !== 'pagination'"
                                @update="updateSelectedAnnotation"
                                @reselect="enterPickMode(selectedAnnotation.id)"
                                @outer="onNavigate('outer')"
                                @inner="onNavigate('inner')"
                                @delete="onDeleteAnnotation(selectedAnnotation.id)"
                                @ignore="onIgnoreAnnotation(selectedAnnotation.id)"
                                @choose-type="onChooseType"
                            />
                        </div>
                    </template>

                    <template v-else>
                        <div class="entity-overview annotator-entity-item">
                            <div class="entity-overview-copy">
                                <span>当前业务区域</span>
                                <strong>{{ currentEntity?.name || '业务区域' }}</strong>
                                <small>共 {{ objectSummary.total }} 个可用对象</small>
                            </div>
                            <button type="button" @click="enterEntityPickMode">调整范围</button>
                        </div>

                        <div class="object-section-list annotator-object-list">
                            <section v-for="section in objectSections" :key="section.key" class="object-group">
                                <header>
                                    <span class="object-group-icon">{{ section.icon }}</span>
                                    <div>
                                        <strong>{{ section.title }}</strong>
                                        <small>{{ section.description }}</small>
                                    </div>
                                    <span class="object-group-count">{{ section.items.length }}</span>
                                </header>
                                <div class="object-group-items">
                                    <button
                                        v-for="item in section.items"
                                        :key="item.annotationId"
                                        type="button"
                                        class="product-object-row annotator-object-item"
                                        :class="{active: item.annotationId === state.currentAnnotationId}"
                                        @click="onSelectAnnotation(item.annotationId)"
                                    >
                                        <span class="object-row-dot" :data-tone="itemStatusTone(item)"></span>
                                        <span class="object-row-copy">
                                            <strong>{{ item.labelName }}</strong>
                                            <small>{{ itemStatus(item) }}</small>
                                        </span>
                                        <span class="object-row-arrow" aria-hidden="true">›</span>
                                    </button>
                                </div>
                            </section>
                        </div>

                        <button type="button" class="add-object-action" :disabled="isBusy" @click="enterPickMode(null)">
                            <span>＋</span>
                            添加页面对象
                        </button>

                        <details class="rule-settings">
                            <summary>
                                <span>标注设置</span>
                                <small>名称与保存标识</small>
                            </summary>
                            <div class="rule-settings-content">
                                <label>
                                    <span>业务区域名称</span>
                                    <input v-model="entityNameModel" type="text" placeholder="例如：订单查询列表" />
                                </label>
                                <label>
                                    <span>规则名称</span>
                                    <input v-model="profileNameModel" type="text" placeholder="自动生成" />
                                </label>
                            </div>
                        </details>
                    </template>
                </section>
            </main>

            <footer v-if="productStage === 'edit'" class="product-footer">
                <div class="history-actions">
                    <button type="button" aria-label="撤销" title="撤销" :disabled="state.history.past.length === 0 || isBusy" @click="applyUndo">↶</button>
                    <button type="button" aria-label="重做" title="重做" :disabled="state.history.future.length === 0 || isBusy" @click="applyRedo">↷</button>
                    <button type="button" :disabled="isBusy" @click="runRecognize">重新识别</button>
                </div>
                <button
                    type="button"
                    class="save-product-action annotator-save-action"
                    :class="{saved: !state.dirty && Boolean(state.artifactRevision)}"
                    :disabled="!state.dirty || isBusy || !state.profileName"
                    @click="runCheckAndSave"
                >
                    <span v-if="operation === 'check'">正在检查…</span>
                    <span v-else-if="operation === 'save'">正在保存…</span>
                    <span v-else-if="!state.dirty && state.artifactRevision">✓ 已保存</span>
                    <span v-else>检查并保存</span>
                </button>
            </footer>
        </aside>

        <div v-if="pickMode" class="pick-guide">
            <span class="pick-guide-icon">⌖</span>
            <div>
                <strong>{{ pickPurpose === 'entity' ? '点击业务区域内任意位置' : '点击要标注的页面对象' }}</strong>
                <small>{{ pickPurpose === 'entity' ? '随后可以扩大或缩小范围，再确认整个区域。' : '随后确认字段、按钮或表格对象的范围。' }}</small>
            </div>
            <button type="button" @click="onPickCancel">退出选择</button>
        </div>
    </div>

    <AnnotatorCanvas
        :boxes="annotationBoxes"
        :placements="placements"
        :selected-annotation-id="state.currentAnnotationId"
        :check-results="state.latestCheck"
        :hover-box="pickMode ? hoverBox : null"
        :viewport-width="viewport.width"
        :viewport-height="viewport.height"
        :pick-mode="pickMode"
        @select="onSelectAnnotation"
    />
    <LabelLayer
        v-if="productStage === 'edit' && !pickMode"
        :boxes="annotationBoxes"
        :placements="placements"
        :selected-annotation-id="state.currentAnnotationId"
        :canvas-draft="entities"
        :candidate="selectedCandidate"
        :candidate-index="pickCandidateIndex"
        :candidate-chain-length="pickCandidates.length"
        :show-editor="false"
        @select="onSelectAnnotation"
    />
    <PickOverlay
        v-if="pickMode"
        :candidate="selectedCandidate"
        :candidate-index="pickCandidateIndex"
        :candidate-chain-length="pickCandidates.length"
        :current-entity-kind="currentEntity?.kind as EntityKind | undefined"
        :pointer="pickPointer"
        :purpose="pickPurpose"
        @navigate="onNavigate"
        @confirm="onPickConfirm"
        @cancel="onPickCancel"
    />
</template>

<style scoped>
:global(*) { box-sizing: border-box; }
.annotator-shell {
    position: fixed;
    inset: 0;
    z-index: 2147483644;
    pointer-events: none;
    color: #0f172a;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
}
.annotator-shell button,
.annotator-shell input,
.annotator-shell select,
.annotator-shell summary { font: inherit; }
.product-panel {
    position: fixed;
    top: 16px;
    right: 16px;
    width: 420px;
    height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(148, 163, 184, .34);
    border-radius: 20px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 30px 80px rgba(15, 23, 42, .22), 0 4px 18px rgba(15, 23, 42, .08);
    backdrop-filter: blur(22px);
    pointer-events: auto;
}
.product-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 68px;
    padding: 13px 15px 12px 16px;
    border-bottom: 1px solid #edf1f6;
}
.product-brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
.product-logo {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 11px;
    background: linear-gradient(145deg, #2563eb, #4f46e5);
    box-shadow: 0 9px 20px rgba(37, 99, 235, .25);
    color: #fff;
    font-size: 17px;
}
.product-brand > div { min-width: 0; }
.product-brand strong { display: block; font-size: 14px; line-height: 1.35; }
.product-brand span:not(.product-logo) { display: block; margin-top: 2px; color: #64748b; font-size: 10px; }
.product-brand span.error { color: #dc2626; }
.product-window-actions { display: flex; gap: 5px; }
.product-window-actions button {
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #64748b;
    font-size: 16px;
    cursor: pointer;
}
.product-window-actions button:hover { background: #f1f5f9; color: #0f172a; }
.product-stepper {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: auto 1fr auto 1fr auto;
    align-items: start;
    gap: 8px;
    padding: 13px 20px 12px;
    border-bottom: 1px solid #edf1f6;
    background: #fbfcfe;
}
.product-stepper > div { display: grid; justify-items: center; gap: 5px; min-width: 64px; color: #94a3b8; }
.product-stepper > div > span {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 1px solid #dbe3ee;
    border-radius: 50%;
    background: #fff;
    font-size: 10px;
    font-weight: 750;
}
.product-stepper small { font-size: 10px; font-weight: 650; white-space: nowrap; }
.product-stepper i { height: 1px; margin-top: 12px; background: #dbe3ee; }
.product-stepper > div.active { color: #2563eb; }
.product-stepper > div.active > span { border-color: #2563eb; background: #2563eb; color: #fff; box-shadow: 0 0 0 4px rgba(37, 99, 235, .10); }
.product-stepper > div.complete { color: #059669; }
.product-stepper > div.complete > span { border-color: #a7f3d0; background: #ecfdf5; color: #059669; }
.product-stepper i.complete { background: #6ee7b7; }
.product-error {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    margin: 12px 14px 0;
    padding: 11px 12px;
    border: 1px solid #fecaca;
    border-radius: 12px;
    background: #fff7f7;
}
.product-error-icon { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: #fee2e2; color: #dc2626; font-size: 12px; font-weight: 800; }
.product-error strong { display: block; color: #991b1b; font-size: 11px; }
.product-error p { margin: 2px 0 0; color: #b91c1c; font-size: 10px; line-height: 1.45; }
.product-error button { border: 0; background: transparent; color: #dc2626; font-size: 10px; font-weight: 700; cursor: pointer; }
.product-progress { flex: 0 0 auto; position: relative; padding: 9px 16px 8px; overflow: hidden; color: #475569; font-size: 10px; text-align: center; }
.product-progress-bar { position: absolute; top: 0; left: 0; width: 38%; height: 2px; background: #2563eb; animation: progress-slide 1.25s ease-in-out infinite; }
@keyframes progress-slide { from { transform: translateX(-100%); } to { transform: translateX(365%); } }
.product-body { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: #cbd5e1 transparent; }
.stage-screen { min-height: 100%; display: flex; flex-direction: column; align-items: center; padding: 32px 30px 26px; text-align: center; }
.stage-kicker { margin-bottom: 8px; color: #2563eb; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.stage-screen h1 { margin: 0; color: #0f172a; font-size: 21px; line-height: 1.32; letter-spacing: -.02em; }
.stage-description { max-width: 330px; margin: 10px auto 22px; color: #64748b; font-size: 12px; line-height: 1.65; }
.scope-illustration { position: relative; width: 188px; height: 126px; margin: 5px auto 24px; }
.scope-window { position: absolute; inset: 0 8px 10px 0; display: grid; grid-template-rows: 28px 1fr 20px; gap: 8px; padding: 13px; border: 1px solid #cbd5e1; border-radius: 15px; background: #fff; box-shadow: 0 16px 34px rgba(15, 23, 42, .10); }
.scope-window::before { content: ''; position: absolute; inset: 5px; border: 2px solid #3b82f6; border-radius: 11px; box-shadow: 0 0 0 4px rgba(59, 130, 246, .08); }
.scope-query, .scope-table, .scope-pagination { position: relative; z-index: 1; display: block; border-radius: 6px; background: #eff6ff; }
.scope-query { width: 72%; }
.scope-table { background: repeating-linear-gradient(to bottom, #e2e8f0 0, #e2e8f0 1px, #f8fafc 1px, #f8fafc 15px); }
.scope-pagination { width: 42%; justify-self: end; }
.scope-cursor { position: absolute; right: 0; bottom: 0; color: #1d4ed8; font-size: 28px; filter: drop-shadow(0 4px 8px rgba(37, 99, 235, .3)); }
.scope-criteria { width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 22px; }
.scope-criteria > div { display: grid; justify-items: center; gap: 4px; padding: 12px 7px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; }
.scope-criteria > div > span { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: #eff6ff; color: #2563eb; font-size: 14px; }
.scope-criteria strong { font-size: 10px; }
.scope-criteria small { color: #94a3b8; font-size: 8px; }
.primary-action { width: 100%; min-height: 46px; display: flex; align-items: center; justify-content: space-between; border: 1px solid #2563eb; border-radius: 12px; padding: 0 16px; background: linear-gradient(135deg, #2563eb, #4f46e5); box-shadow: 0 12px 24px rgba(37, 99, 235, .22); color: #fff; font-size: 12px; font-weight: 750; cursor: pointer; }
.primary-action:hover:not(:disabled) { filter: brightness(.96); transform: translateY(-1px); }
.primary-action:disabled { opacity: .55; cursor: default; box-shadow: none; }
.stage-footnote { margin-top: 12px; color: #94a3b8; font-size: 9px; }
.selected-scope-card { width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 11px; align-items: center; margin-bottom: 28px; padding: 13px; border: 1px solid #dbeafe; border-radius: 14px; background: #f7fbff; text-align: left; }
.selected-scope-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; background: #dbeafe; color: #2563eb; }
.selected-scope-card small { display: block; color: #64748b; font-size: 9px; }
.selected-scope-card strong { display: block; overflow: hidden; margin-top: 2px; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.selected-scope-card button { border: 0; background: transparent; color: #2563eb; font-size: 10px; font-weight: 700; cursor: pointer; }
.recognize-preview { width: 100%; display: grid; gap: 8px; margin-bottom: 22px; text-align: left; }
.recognize-preview > div { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 12px; }
.recognize-preview > div > span { color: #cbd5e1; font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
.recognize-preview p { margin: 0; }
.recognize-preview strong { display: block; font-size: 11px; }
.recognize-preview small { display: block; margin-top: 2px; color: #94a3b8; font-size: 9px; }
.review-success { width: 58px; height: 58px; display: grid; place-items: center; margin: 8px auto 18px; border-radius: 50%; background: #ecfdf5; box-shadow: 0 0 0 8px rgba(16, 185, 129, .08); color: #059669; font-size: 24px; font-weight: 800; }
.review-summary { width: 100%; display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-bottom: 16px; }
.review-summary > div { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; gap: 0 10px; align-items: center; padding: 13px; border: 1px solid #e2e8f0; border-radius: 12px; text-align: left; }
.review-summary > div:last-child:nth-child(odd) { grid-column: 1 / -1; }
.review-summary > div > span { grid-row: 1 / 3; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; background: #f1f5f9; color: #475569; }
.review-summary strong { font-size: 18px; line-height: 1; }
.review-summary small { margin-top: 3px; color: #64748b; font-size: 9px; }
.review-note { width: 100%; display: flex; gap: 9px; align-items: flex-start; margin-bottom: 20px; padding: 11px; border-radius: 11px; background: #f8fafc; text-align: left; }
.review-note > span { flex: 0 0 auto; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: #e2e8f0; color: #64748b; font-size: 10px; font-weight: 800; }
.review-note p { margin: 1px 0 0; color: #64748b; font-size: 10px; line-height: 1.5; }
.review-secondary-actions { display: flex; gap: 14px; margin-top: 13px; }
.review-secondary-actions button { border: 0; background: transparent; color: #64748b; font-size: 10px; cursor: pointer; }
.editor-stage { min-height: 100%; padding: 16px 14px 22px; }
.editor-toolbar { margin-bottom: 12px; }
.back-action { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; color: #475569; font-size: 11px; font-weight: 650; cursor: pointer; }
.back-action:hover { color: #2563eb; }
.inspector-container { padding: 4px 2px; }
.entity-overview { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding: 14px; border: 1px solid #dbeafe; border-radius: 14px; background: linear-gradient(135deg, #f8fbff, #f5f7ff); }
.entity-overview-copy { min-width: 0; }
.entity-overview-copy > span { display: block; color: #2563eb; font-size: 9px; font-weight: 750; letter-spacing: .06em; }
.entity-overview-copy strong { display: block; overflow: hidden; margin-top: 3px; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.entity-overview-copy small { display: block; margin-top: 3px; color: #64748b; font-size: 9px; }
.entity-overview button { flex: 0 0 auto; min-height: 30px; border: 1px solid #bfdbfe; border-radius: 9px; padding: 0 9px; background: #fff; color: #2563eb; font-size: 9px; font-weight: 700; cursor: pointer; }
.object-section-list { display: grid; gap: 11px; }
.object-group { overflow: hidden; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; }
.object-group > header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 12px 12px 9px; }
.object-group-icon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; background: #f1f5f9; color: #475569; font-size: 13px; }
.object-group header strong { display: block; font-size: 11px; }
.object-group header small { display: block; margin-top: 2px; color: #94a3b8; font-size: 8px; }
.object-group-count { min-width: 22px; height: 22px; display: grid; place-items: center; border-radius: 999px; background: #f1f5f9; color: #64748b; font-size: 9px; font-weight: 700; }
.object-group-items { padding: 0 7px 7px; }
.product-object-row { width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; align-items: center; min-height: 48px; border: 0; border-radius: 9px; padding: 7px 8px; background: transparent; text-align: left; cursor: pointer; }
.product-object-row:hover { background: #f8fafc; }
.product-object-row.active { background: #eff6ff; }
.object-row-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; box-shadow: 0 0 0 4px rgba(148, 163, 184, .10); }
.object-row-dot[data-tone="success"] { background: #10b981; box-shadow: 0 0 0 4px rgba(16, 185, 129, .10); }
.object-row-dot[data-tone="warning"] { background: #f59e0b; box-shadow: 0 0 0 4px rgba(245, 158, 11, .10); }
.object-row-dot[data-tone="danger"] { background: #ef4444; box-shadow: 0 0 0 4px rgba(239, 68, 68, .10); }
.object-row-copy { min-width: 0; }
.object-row-copy strong { display: block; overflow: hidden; color: #1e293b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.object-row-copy small { display: block; margin-top: 2px; color: #94a3b8; font-size: 8px; }
.object-row-arrow { color: #cbd5e1; font-size: 18px; }
.add-object-action { width: 100%; min-height: 40px; display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 12px; border: 1px dashed #cbd5e1; border-radius: 11px; background: #fbfcfe; color: #475569; font-size: 10px; font-weight: 700; cursor: pointer; }
.add-object-action:hover { border-color: #93c5fd; background: #f5f9ff; color: #2563eb; }
.rule-settings { margin-top: 12px; overflow: hidden; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff; }
.rule-settings summary { display: flex; align-items: center; gap: 8px; padding: 12px; color: #475569; font-size: 10px; font-weight: 700; cursor: pointer; list-style: none; }
.rule-settings summary::-webkit-details-marker { display: none; }
.rule-settings summary small { margin-left: auto; color: #94a3b8; font-size: 8px; font-weight: 500; }
.rule-settings summary::after { content: '⌄'; color: #94a3b8; }
.rule-settings[open] summary::after { transform: rotate(180deg); }
.rule-settings-content { display: grid; gap: 12px; padding: 0 12px 12px; }
.rule-settings-content label { display: grid; gap: 6px; }
.rule-settings-content label span { color: #475569; font-size: 9px; font-weight: 700; }
.rule-settings-content input { width: 100%; min-height: 38px; border: 1px solid #cbd5e1; border-radius: 9px; padding: 0 10px; outline: none; color: #0f172a; font-size: 10px; }
.rule-settings-content input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, .1); }
.product-footer { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 64px; padding: 10px 14px; border-top: 1px solid #e2e8f0; background: rgba(255, 255, 255, .98); }
.history-actions { display: flex; align-items: center; gap: 5px; }
.history-actions button { min-width: 30px; height: 32px; border: 1px solid #e2e8f0; border-radius: 9px; padding: 0 8px; background: #fff; color: #64748b; font-size: 10px; cursor: pointer; }
.history-actions button:disabled { opacity: .35; cursor: default; }
.history-actions button:hover:not(:disabled) { background: #f8fafc; color: #0f172a; }
.save-product-action { min-width: 126px; height: 40px; border: 1px solid #2563eb; border-radius: 11px; padding: 0 15px; background: #2563eb; box-shadow: 0 8px 18px rgba(37, 99, 235, .20); color: #fff; font-size: 10px; font-weight: 750; cursor: pointer; }
.save-product-action:hover:not(:disabled) { background: #1d4ed8; }
.save-product-action:disabled { opacity: .45; cursor: default; box-shadow: none; }
.save-product-action.saved { border-color: #a7f3d0; background: #ecfdf5; color: #059669; opacity: 1; }
.annotator-restore { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 8px; min-height: 42px; border: 1px solid rgba(148, 163, 184, .38); border-radius: 999px; padding: 0 15px 0 8px; background: rgba(255, 255, 255, .96); box-shadow: 0 15px 36px rgba(15, 23, 42, .18); color: #0f172a; font-size: 11px; font-weight: 700; cursor: pointer; pointer-events: auto; }
.annotator-restore-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: #2563eb; color: #fff; }
.annotator-restore-badge { width: 7px; height: 7px; border-radius: 50%; background: #f59e0b; }
.pick-guide { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 11px; width: min(520px, calc(100vw - 40px)); padding: 11px 12px; border: 1px solid rgba(148, 163, 184, .42); border-radius: 14px; background: rgba(255, 255, 255, .96); box-shadow: 0 14px 38px rgba(15, 23, 42, .18); backdrop-filter: blur(16px); pointer-events: auto; }
.pick-guide-icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 10px; background: #eff6ff; color: #2563eb; font-size: 15px; }
.pick-guide > div { flex: 1; min-width: 0; }
.pick-guide strong { display: block; font-size: 11px; }
.pick-guide small { display: block; margin-top: 2px; color: #64748b; font-size: 9px; }
.pick-guide button { border: 0; background: transparent; color: #64748b; font-size: 9px; font-weight: 700; cursor: pointer; }
@media (max-width: 720px) {
    .product-panel { top: 8px; right: 8px; width: min(420px, calc(100vw - 16px)); height: calc(100vh - 16px); }
}
@media (max-height: 640px) {
    .product-panel { top: 8px; height: calc(100vh - 16px); }
    .product-header { min-height: 54px; padding: 9px 12px; }
    .product-logo { width: 32px; height: 32px; border-radius: 9px; }
    .product-stepper { padding: 8px 16px 7px; }
    .product-stepper > div { gap: 2px; }
    .product-stepper > div > span { width: 20px; height: 20px; }
    .product-stepper i { margin-top: 10px; }
    .stage-screen { padding: 12px 24px 13px; }
    .scope-illustration { width: 132px; height: 76px; margin: 0 auto 8px; }
    .scope-window { inset: 0 6px 7px 0; grid-template-rows: 17px 1fr 12px; gap: 5px; padding: 8px; border-radius: 11px; }
    .scope-window::before { inset: 3px; border-radius: 8px; }
    .scope-cursor { font-size: 20px; }
    .stage-kicker { margin-bottom: 3px; font-size: 8px; }
    .stage-screen h1 { font-size: 17px; }
    .stage-description { margin: 5px auto 9px; font-size: 10px; line-height: 1.42; }
    .scope-criteria { gap: 5px; margin-bottom: 9px; }
    .scope-criteria > div { gap: 2px; padding: 6px 3px; border-radius: 9px; }
    .scope-criteria > div > span { width: 22px; height: 22px; border-radius: 6px; font-size: 11px; }
    .scope-criteria strong { font-size: 8px; }
    .scope-criteria small, .stage-footnote { display: none; }
    .primary-action { min-height: 40px; border-radius: 10px; font-size: 10px; }
    .selected-scope-card { margin-bottom: 10px; padding: 9px; }
    .selected-scope-icon { width: 28px; height: 28px; }
    .recognize-preview { gap: 5px; margin-bottom: 9px; }
    .recognize-preview > div { gap: 9px; padding: 7px 9px; border-radius: 9px; }
    .recognize-preview > div > span { font-size: 11px; }
    .recognize-preview small { display: none; }
    .review-success { width: 40px; height: 40px; margin: 0 auto 8px; box-shadow: 0 0 0 5px rgba(16, 185, 129, .08); font-size: 17px; }
    .review-summary { gap: 5px; margin-bottom: 8px; }
    .review-summary > div { gap: 0 7px; padding: 8px; border-radius: 9px; }
    .review-summary > div > span { width: 25px; height: 25px; border-radius: 7px; }
    .review-summary strong { font-size: 14px; }
    .review-note { margin-bottom: 9px; padding: 7px 9px; }
    .review-secondary-actions { margin-top: 6px; }
}
</style>
