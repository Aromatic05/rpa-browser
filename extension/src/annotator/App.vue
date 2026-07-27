<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue';
import AnnotatorCanvas from './canvas/AnnotatorCanvas.vue';
import LabelLayer from './labels/LabelLayer.vue';
import PickOverlay from './picking/PickOverlay.vue';
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
    setColumnPrimaryKey,
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
import {computeLabelPlacements, type LabelPlacement} from './layout/label_layout.js';
import {projectViewportRect} from './layout/box_geometry.js';
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
    VisualTargetRef,
} from './types.js';
import {entityVisualId, paginationPageVisualId} from './visual_ids.js';
import {
    checkIssueMessage,
    deriveCanvasPresentation,
    deriveProductStage,
    type AnnotatorProductStage,
} from './state/product_ui.js';
import {enrichInferredFieldNamesFromDom} from './state/dom_labels.js';
import {enrichVisualBindingsFromDom} from './state/dom_geometry.js';
import {annotationIdFromDomTarget, applyDomMarkers, clearDomMarkers} from './state/dom_markers.js';

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
const settingsOpen = ref(false);
const reviewPending = ref(false);
const pickTargetEntityId = ref<string | null>(null);
const pickTargetAnnotationId = ref<string | null>(null);
const pickCandidates = ref<PickCandidate[]>([]);
const pickCandidateIndex = ref(0);
const pickPointer = ref<{x: number; y: number} | null>(null);
const coordinateProbe = ref<HTMLElement | null>(null);
const overlaySpace = ref({x: 0, y: 0, scaleX: 1, scaleY: 1});
let pickerDetach: PickerDetach | null = null;
let mutationObserver: MutationObserver | null = null;

const win = () => (typeof window !== 'undefined' ? window : null);

let visualBindingRequest = 0;
let visualBindingTimer: ReturnType<typeof setTimeout> | null = null;
let visualBindingCaptureReady = false;
const visualBindingCapturedScroll = ref({x: 0, y: 0});

const markVisualBindingCapture = (): void => {
    const w = win();
    visualBindingCapturedScroll.value = {
        x: w?.scrollX ?? viewport.value.scrollX,
        y: w?.scrollY ?? viewport.value.scrollY,
    };
    visualBindingCaptureReady = true;
};

const refreshOverlaySpace = (): void => {
    const probe = coordinateProbe.value;
    if (!probe) {return;}
    const rect = probe.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {return;}
    overlaySpace.value = {
        x: rect.left,
        y: rect.top,
        scaleX: rect.width / 100,
        scaleY: rect.height / 100,
    };
};

const refreshVisualBindings = async (): Promise<void> => {
    if (!props.client || !props.state.canvasDraft || props.state.mode !== 'editing') {return;}
    const request = ++visualBindingRequest;
    try {
        const result = await props.client.visualize({canvasDraft: props.state.canvasDraft});
        if (request !== visualBindingRequest || props.state.mode !== 'editing') {return;}
        markVisualBindingCapture();
        const documentRef = win()?.document;
        const visualBindings = documentRef
            ? enrichVisualBindingsFromDom(props.state.canvasDraft, result.visualTargetRefs, documentRef)
            : result.visualTargetRefs;
        applyState({...props.state, visualBindings});
    } catch {
        // Keep the last projected geometry while the current page snapshot is unavailable.
    }
};

const scheduleVisualBindingRefresh = (): void => {
    if (visualBindingTimer) {clearTimeout(visualBindingTimer);}
    visualBindingTimer = setTimeout(() => {
        visualBindingTimer = null;
        void refreshVisualBindings();
    }, 120);
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
    refreshOverlaySpace();
    if (!visualBindingCaptureReady && props.state.visualBindings.length > 0) {
        markVisualBindingCapture();
    }
    scheduleVisualBindingRefresh();
};

const scheduler = createViewportScheduler(refreshViewport);

const applyState = (next: AnnotatorState): void => {
    Object.assign(props.state, next);
};

const applyUndo = (): void => applyState(undo(props.state));
const applyRedo = (): void => applyState(redo(props.state));

const toOverlayRect = (rect: PickRect): PickRect => {
    const space = overlaySpace.value;
    const scaleX = space.scaleX || 1;
    const scaleY = space.scaleY || 1;
    return {
        x: (rect.x - space.x) / scaleX,
        y: (rect.y - space.y) / scaleY,
        width: rect.width / scaleX,
        height: rect.height / scaleY,
    };
};

const projectRect = (rect: PickRect): PickRect => toOverlayRect(projectViewportRect(
    rect,
    visualBindingCapturedScroll.value,
    {x: viewport.value.scrollX, y: viewport.value.scrollY},
));

const projectBinding = (binding: VisualTargetRef): VisualTargetRef => ({
    ...binding,
    ...(binding.bbox ? {
        bbox: projectRect(binding.bbox),
    } : {}),
    ...(binding.matchedNodeBoxes ? {
        matchedNodeBoxes: binding.matchedNodeBoxes.map(projectRect),
    } : {}),
});

const projectedVisualBindings = computed(() => props.state.visualBindings.map(projectBinding));

const annotationBoxes = computed<AnnotationBox[]>(() =>
    deriveAnnotationBoxes(
        props.state.canvasDraft,
        projectedVisualBindings.value,
        props.state.currentEntityId,
        props.state.latestCheck,
    ),
);

const labelBoxes = computed<AnnotationBox[]>(() => {
    const failures = new Set(
        (props.state.latestCheck ?? [])
            .filter((check) => check.status !== 'unique')
            .map((check) => check.canvasAnnotationId),
    );
    return annotationBoxes.value.filter((box) =>
        box.kind !== 'entity' && (
            box.annotationId === props.state.currentAnnotationId ||
            failures.has(box.annotationId)
        ),
    );
});

const canvasBoxes = computed<AnnotationBox[]>(() => {
    const visibleIds = new Set(labelBoxes.value.map((box) => box.annotationId));
    return annotationBoxes.value.filter((box) => box.kind === 'entity' || visibleIds.has(box.annotationId));
});

const labelTargets = computed(() =>
    labelBoxes.value
        .map((box) => annotationLabelTarget(box))
        .filter((target): target is NonNullable<typeof target> => target !== null),
);

const labelOffsets = ref<Record<string, {dx: number; dy: number}>>({});
const basePlacements = computed(() =>
    computeLabelPlacements(
        labelTargets.value,
        {
            width: viewport.value.width,
            height: viewport.value.height,
        },
        {},
    ),
);
const placements = computed<Record<string, LabelPlacement>>(() => {
    const next: Record<string, LabelPlacement> = {};
    for (const [annotationId, placement] of Object.entries(basePlacements.value)) {
        const offset = labelOffsets.value[annotationId] ?? {dx: 0, dy: 0};
        next[annotationId] = {
            ...placement,
            box: {
                ...placement.box,
                x: placement.box.x + offset.dx,
                y: placement.box.y + offset.dy,
            },
            polyline: placement.polyline.map((point, index) =>
                index === placement.polyline.length - 1
                    ? {x: point.x + offset.dx, y: point.y + offset.dy}
                    : {...point},
            ),
        };
    }
    return next;
});

const onMoveLabel = (annotationId: string, dx: number, dy: number): void => {
    const current = labelOffsets.value[annotationId] ?? {dx: 0, dy: 0};
    labelOffsets.value = {
        ...labelOffsets.value,
        [annotationId]: {dx: current.dx + dx, dy: current.dy + dy},
    };
};

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

const canvasPresentation = computed(() => deriveCanvasPresentation(
    productStage.value,
    pickMode.value,
    Boolean(currentEntity.value),
));

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

const pickHighlightBox = computed<PickRect | null>(() => {
    const candidateBox = selectedCandidate.value?.bbox;
    if (candidateBox) {return toOverlayRect(candidateBox);}
    return hoverBox.value;
});

const selectedAnnotationEntityId = computed<string | null>(() => {
    if (!props.state.currentAnnotationId) {return null;}
    return entityIdForAnnotation(props.state.currentAnnotationId);
});

const onSelectAnnotation = (annotationId: string): void => {
    if (annotationId.startsWith('entity:')) {return;}
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
        const withGeometry = enriched.canvasDraft && documentRef
            ? {
                ...enriched,
                visualBindings: enrichVisualBindingsFromDom(
                    enriched.canvasDraft,
                    enriched.visualBindings,
                    documentRef,
                ),
            }
            : enriched;
        markVisualBindingCapture();
        applyState(withGeometry);
        if (!withGeometry.error && wasFirstRecognition && withGeometry.canvasDraft?.entities[0]) {
            reviewPending.value = false;
            applyState(pickReceived(withGeometry, {
                entityId: withGeometry.canvasDraft.entities[0].id,
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
    hoverBox.value = rect ? toOverlayRect(rect) : null;
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

const onPickConfirm = async (): Promise<void> => {
    const candidate = selectedCandidate.value;
    if (!candidate) {return;}
    if (pickPurpose.value === 'entity') {
        try {
            const nextDraft = createEntityScopeDraft(candidate);
            const entityId = nextDraft.entities[0].id;
            const edited = draftEdited(props.state, nextDraft);
            const withEntityBinding: AnnotatorState = {
                ...edited,
                visualBindings: candidate.bbox
                    ? [{
                        entityId,
                        nodeId: candidate.nodeId,
                        kind: candidate.kind,
                        role: 'entity',
                        bbox: candidate.bbox,
                    }]
                    : edited.visualBindings,
            };
            markVisualBindingCapture();
            applyState(pickReceived(withEntityBinding, {
                entityId,
                annotationId: null,
            }));
            reviewPending.value = false;
            exitPickMode();
            await nextTick();
            await runRecognize();
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

const onSetColumnPrimaryKey = (
    entityId: string,
    columnId: string,
    selected: boolean,
): void => {
    if (!props.state.canvasDraft) {return;}
    applyState(draftEdited(
        props.state,
        setColumnPrimaryKey(props.state.canvasDraft, entityId, columnId, selected),
    ));
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

const syncDomMarkers = (): void => {
    const documentRef = win()?.document;
    if (!documentRef) {return;}
    if (
        pickMode.value ||
        props.state.mode !== 'editing' ||
        !props.state.canvasDraft ||
        !canvasPresentation.value.showObjects
    ) {
        clearDomMarkers(documentRef);
        return;
    }
    applyDomMarkers(
        props.state.canvasDraft,
        documentRef,
        props.state.currentAnnotationId,
        props.state.latestCheck,
    );
};

const onDomMarkerClick = (event: MouseEvent): void => {
    if (pickMode.value || props.state.mode !== 'editing') {return;}
    const annotationId = annotationIdFromDomTarget(event.target);
    if (!annotationId) {return;}
    event.preventDefault();
    event.stopImmediatePropagation();
    onSelectAnnotation(annotationId);
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
    void nextTick().then(() => {
        refreshOverlaySpace();
        refreshViewport();
    });
    pickerDetach = attachPickerListeners(document, {
        isActive: () => pickMode.value,
        onHover: onHoverUpdate,
        onPick: (event) => {
            void onPickEvent(event);
        },
    });
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onDomMarkerClick, true);
    document.addEventListener('scroll', scheduler.schedule, true);
    const w = win();
    if (w) {
        w.addEventListener('scroll', scheduler.schedule, {capture: true, passive: true});
        w.addEventListener('resize', scheduler.schedule, {passive: true});
        w.visualViewport?.addEventListener('scroll', scheduler.schedule, {passive: true});
        w.visualViewport?.addEventListener('resize', scheduler.schedule, {passive: true});
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
    if (visualBindingTimer) {
        clearTimeout(visualBindingTimer);
        visualBindingTimer = null;
    }
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onDomMarkerClick, true);
    clearDomMarkers(document);
    document.removeEventListener('scroll', scheduler.schedule, true);
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    const w = win();
    if (w) {
        w.removeEventListener('scroll', scheduler.schedule, {capture: true} as EventListenerOptions);
        w.removeEventListener('resize', scheduler.schedule);
        w.visualViewport?.removeEventListener('scroll', scheduler.schedule);
        w.visualViewport?.removeEventListener('resize', scheduler.schedule);
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
    () => props.state.visualBindings,
    () => markVisualBindingCapture(),
);

watch(
    () => [
        props.state.canvasDraft,
        props.state.currentAnnotationId,
        props.state.latestCheck,
        props.state.mode,
        pickMode.value,
        canvasPresentation.value.showObjects,
    ],
    () => {void nextTick(syncDomMarkers);},
    {deep: true, immediate: true},
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
        <div ref="coordinateProbe" class="coordinate-probe" aria-hidden="true"></div>

        <div v-if="state.error && !pickMode" class="annotator-toast error annotator-error-banner" role="alert">
            <span>!</span>
            <p>{{ state.error }}</p>
            <button
                type="button"
                :disabled="isBusy"
                @click="productStage === 'scope' ? enterEntityPickMode() : (productStage === 'recognize' ? runRecognize() : runCheck())"
            >重试</button>
        </div>

        <div v-if="isBusy && !pickMode" class="annotator-toast busy" role="status" aria-live="polite">
            <span class="busy-spinner"></span>
            <p>{{ busyLabel }}</p>
        </div>

        <section
            v-if="productStage === 'scope' && !pickMode"
            class="floating-guide scope-guide dock-bottom"
        >
            <div class="guide-copy">
                <strong>选择页面范围</strong>
            </div>
            <button
                type="button"
                class="guide-primary"
                data-annotator-action="select-entity"
                :disabled="isBusy"
                @click="enterEntityPickMode"
            >开始选择</button>
        </section>

        <div
            v-if="(productStage === 'review' || productStage === 'edit') && !pickMode"
            class="floating-dock edit-dock dock-bottom"
        >
            <strong class="dock-copy">检查标注</strong>
            <button type="button" aria-label="撤销" title="撤销" :disabled="state.history.past.length === 0 || isBusy" @click="applyUndo">↶</button>
            <button type="button" aria-label="重做" title="重做" :disabled="state.history.future.length === 0 || isBusy" @click="applyRedo">↷</button>
            <i></i>
            <button type="button" :disabled="isBusy" @click="enterPickMode(null)">添加</button>
            <button type="button" :disabled="isBusy" @click="enterEntityPickMode">调整</button>
            <button
                type="button"
                class="dock-primary annotator-save-action"
                :class="{saved: !state.dirty && Boolean(state.artifactRevision)}"
                :disabled="!state.dirty || isBusy || !state.profileName"
                @click="runCheckAndSave"
            >
                <span v-if="operation === 'check'">检查中…</span>
                <span v-else-if="operation === 'save'">保存中…</span>
                <span v-else-if="!state.dirty && state.artifactRevision">✓ 已保存</span>
                <span v-else>保存</span>
            </button>
            <button type="button" aria-label="设置" title="设置" :class="{active: settingsOpen}" @click="settingsOpen = !settingsOpen">⚙</button>
            <button type="button" aria-label="退出" title="退出" @click="emit('exit')">×</button>
        </div>

        <div
            v-if="settingsOpen && productStage === 'edit' && !pickMode"
            class="settings-popover dock-bottom"
        >
            <header>
                <strong>区域与保存设置</strong>
                <button type="button" aria-label="关闭设置" @click="settingsOpen = false">×</button>
            </header>
            <label>
                <span>业务区域名称</span>
                <input v-model="entityNameModel" type="text" placeholder="例如：订单查询列表" />
            </label>
            <label>
                <span>规则名称</span>
                <input v-model="profileNameModel" type="text" placeholder="自动生成" />
            </label>
            <button type="button" class="quiet-action" :disabled="isBusy" @click="runRecognize">重新识别</button>
        </div>

        <div v-if="pickMode && !selectedCandidate" class="pick-guide">
            <span class="pick-guide-icon">⌖</span>
            <div>
                <strong>{{ pickPurpose === 'entity' ? '点击业务区域内任意位置' : '点击要标注的页面对象' }}</strong>
                <small>{{ pickPurpose === 'entity' ? '随后可以扩大或缩小范围，再确认整个区域。' : '随后确认字段、按钮或表格对象的范围。' }}</small>
            </div>
            <button type="button" @click="onPickCancel">退出选择</button>
        </div>
    </div>

    <AnnotatorCanvas
        :boxes="canvasBoxes"
        :placements="placements"
        :selected-annotation-id="state.currentAnnotationId"
        :check-results="state.latestCheck"
        :hover-box="pickMode ? pickHighlightBox : null"
        :viewport-width="viewport.width"
        :viewport-height="viewport.height"
        :pick-mode="pickMode"
        :dim-outside-entity="canvasPresentation.dimOutsideEntity"
        :show-entity="canvasPresentation.showEntity"
        :show-objects="canvasPresentation.showObjects"
        :show-object-boxes="false"
        @select="onSelectAnnotation"
    />
    <LabelLayer
        v-if="canvasPresentation.showLabels"
        :boxes="labelBoxes"
        :placements="placements"
        :selected-annotation-id="state.currentAnnotationId"
        :canvas-draft="entities"
        :candidate="selectedCandidate"
        :candidate-index="pickCandidateIndex"
        :candidate-chain-length="pickCandidates.length"
        :show-editor="canvasPresentation.showEditor"
        :check-results="state.latestCheck"
        :viewport-width="viewport.width"
        :viewport-height="viewport.height"
        @select="onSelectAnnotation"
        @move="onMoveLabel"
        @update-annotation="onUpdateAnnotation"
        @reselect="(annotationId) => annotationId === entityVisualId(currentEntity?.id || '') ? enterEntityPickMode() : enterPickMode(annotationId)"
        @navigate="onNavigate"
        @delete="onDeleteAnnotation"
        @ignore="onIgnoreAnnotation"
        @choose-type="onChooseType"
        @set-primary-key="onSetColumnPrimaryKey"
        @close="applyState(pickReceived(state, {annotationId: null, entityId: currentEntity?.id || null}))"
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
.annotator-shell select { font: inherit; }
.coordinate-probe {
    position: fixed;
    top: 0;
    left: 0;
    width: 100px;
    height: 100px;
    visibility: hidden;
    pointer-events: none;
}
.floating-guide,
.floating-dock,
.settings-popover,
.annotator-toast,
.pick-guide { pointer-events: auto; }
.floating-guide {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    width: min(620px, calc(100vw - 28px));
    min-height: 58px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 11px 10px 14px;
    border: 1px solid rgba(100, 116, 139, .26);
    border-radius: 14px;
    background: rgba(255, 255, 255, .94);
    box-shadow: 0 14px 36px rgba(15, 23, 42, .18);
    backdrop-filter: blur(14px) saturate(1.2);
    z-index: 7;
}
.floating-guide.dock-top { top: 14px; }
.floating-guide.dock-bottom { bottom: 14px; }
.guide-copy { min-width: 0; flex: 1; }
.guide-copy small { display: block; color: #2563eb; font-size: 8px; font-weight: 800; letter-spacing: .08em; }
.guide-copy strong { display: block; margin-top: 2px; font-size: 12px; line-height: 1.3; }
.guide-copy span { display: block; margin-top: 2px; color: #64748b; font-size: 9px; line-height: 1.35; }
.guide-actions { display: flex; align-items: center; gap: 6px; }
.guide-primary,
.dock-primary {
    min-height: 36px;
    border: 1px solid #2563eb;
    border-radius: 10px;
    padding: 0 14px;
    background: #2563eb;
    box-shadow: 0 6px 14px rgba(37, 99, 235, .20);
    color: #fff;
    font-size: 10px;
    font-weight: 750;
    cursor: pointer;
    white-space: nowrap;
}
.guide-primary:hover:not(:disabled),
.dock-primary:hover:not(:disabled) { background: #1d4ed8; }
.guide-primary:disabled,
.dock-primary:disabled { opacity: .45; cursor: default; box-shadow: none; }
.quiet-action {
    min-height: 34px;
    border: 1px solid #dbe3ee;
    border-radius: 9px;
    padding: 0 11px;
    background: #fff;
    color: #475569;
    font-size: 9px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
}
.quiet-action:hover:not(:disabled) { border-color: #bfdbfe; background: #eff6ff; color: #1d4ed8; }
.floating-dock {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 5px;
    max-width: calc(100vw - 28px);
    padding: 6px;
    border: 1px solid rgba(100, 116, 139, .26);
    border-radius: 13px;
    background: rgba(255, 255, 255, .94);
    box-shadow: 0 12px 30px rgba(15, 23, 42, .17);
    backdrop-filter: blur(14px) saturate(1.2);
    z-index: 7;
    pointer-events: none;
}
.floating-dock.dock-top { top: 62px; }
.floating-dock.dock-bottom { bottom: 14px; }
.dock-copy {
    padding: 0 7px;
    color: #334155;
    font-size: 10px;
    white-space: nowrap;
}
.floating-dock > button:not(.dock-primary) {
    min-height: 34px;
    border: 0;
    border-radius: 9px;
    padding: 0 10px;
    background: transparent;
    color: #475569;
    font-size: 9px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
    pointer-events: auto;
}
.floating-dock > .dock-primary { pointer-events: auto; }
.floating-dock > button:not(.dock-primary):hover:not(:disabled) { background: #f1f5f9; color: #0f172a; }
.floating-dock > button:disabled { opacity: .35; cursor: default; }
.floating-dock > i { width: 1px; height: 22px; background: #e2e8f0; }
.dock-primary.saved { border-color: #a7f3d0; background: #ecfdf5; box-shadow: none; color: #047857; }
.settings-popover {
    position: fixed;
    right: 14px;
    bottom: 66px;
    width: min(300px, calc(100vw - 24px));
    display: grid;
    gap: 10px;
    padding: 12px;
    border: 1px solid rgba(100, 116, 139, .25);
    border-radius: 13px;
    background: rgba(255, 255, 255, .97);
    box-shadow: 0 16px 40px rgba(15, 23, 42, .18);
    z-index: 9;
}
.settings-popover header { display: flex; align-items: center; justify-content: space-between; }
.settings-popover header strong { font-size: 11px; }
.settings-popover header button { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; }
.settings-popover header button:hover { background: #f1f5f9; }
.settings-popover label { display: grid; gap: 5px; }
.settings-popover label span { color: #475569; font-size: 9px; font-weight: 700; }
.settings-popover input { height: 36px; border: 1px solid #cbd5e1; border-radius: 9px; padding: 0 9px; outline: none; font-size: 10px; }
.settings-popover input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, .10); }
.annotator-toast {
    position: fixed;
    top: 62px;
    left: 50%;
    transform: translateX(-50%);
    width: min(430px, calc(100vw - 28px));
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 9px 10px;
    border: 1px solid #dbe3ee;
    border-radius: 11px;
    background: rgba(255, 255, 255, .96);
    box-shadow: 0 10px 28px rgba(15, 23, 42, .14);
    z-index: 10;
}
.annotator-toast p { flex: 1; margin: 0; font-size: 9px; line-height: 1.4; }
.annotator-toast button { border: 0; background: transparent; color: #2563eb; font-size: 9px; font-weight: 750; cursor: pointer; }
.annotator-toast.error { border-color: #fecaca; background: rgba(255, 247, 247, .97); color: #991b1b; }
.annotator-toast.error > span { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; background: #fee2e2; font-size: 10px; font-weight: 800; }
.busy-spinner { width: 15px; height: 15px; border: 2px solid #bfdbfe; border-top-color: #2563eb; border-radius: 50%; animation: rpa-spin .8s linear infinite; }
@keyframes rpa-spin { to { transform: rotate(360deg); } }
.pick-guide {
    position: fixed;
    top: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(430px, calc(100vw - 24px));
    min-height: 42px;
    padding: 7px 8px;
    border: 1px solid rgba(100, 116, 139, .25);
    border-radius: 12px;
    background: rgba(255, 255, 255, .92);
    box-shadow: 0 9px 24px rgba(15, 23, 42, .15);
    backdrop-filter: blur(12px);
    z-index: 8;
}
.pick-guide-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 9px; background: #eff6ff; color: #2563eb; font-size: 13px; }
.pick-guide > div { min-width: 0; flex: 1; }
.pick-guide strong { display: block; font-size: 10px; }
.pick-guide small { display: block; overflow: hidden; margin-top: 1px; color: #64748b; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.pick-guide button { height: 30px; border: 0; border-radius: 8px; padding: 0 9px; background: #f1f5f9; color: #475569; font-size: 9px; font-weight: 700; cursor: pointer; }
.pick-guide button:hover { background: #e2e8f0; }
@media (max-width: 680px) {
    .floating-guide { align-items: flex-start; gap: 8px; }
    .guide-copy span { display: none; }
    .guide-actions { flex-wrap: wrap; justify-content: flex-end; }
    .floating-dock { overflow-x: auto; justify-content: flex-start; }
}
@media (max-height: 520px) {
    .guide-copy span { display: none; }
    .floating-guide { min-height: 48px; padding-top: 7px; padding-bottom: 7px; }
    .floating-dock.dock-top { top: 54px; }
}
</style>
