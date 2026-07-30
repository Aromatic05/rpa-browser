<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue';
import AnnotatorCanvas from './canvas/AnnotatorCanvas.vue';
import BusinessObjectPanel from './canvas/BusinessObjectPanel.vue';
import EditCard from './canvas/EditCard.vue';
import LabelLayer from './labels/LabelLayer.vue';
import PickOverlay from './picking/PickOverlay.vue';
import type {AnnotatorClient} from './protocol/annotator_client.js';
import {
    undo,
    redo,
    draftEdited,
    pickReceived,
    failed,
    openLoaded,
    type AnnotatorState,
} from './state/annotator_state.js';
import type {SessionStore} from './state/session_store.js';
import {
    runCheckLoop,
    runSaveLoop,
    runRecognizeLoop,
    restoreSessionDraft,
    persistSessionDraft,
    buildSessionKey,
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
import {placeFloatingPanel} from './layout/floating_panel.js';
import {createViewportScheduler} from './layout/viewport_tracker.js';
import {
    candidatesForPurpose,
    chooseCandidate,
    defaultCandidateIndex,
    isConfirmableEntityCandidate,
    selectInner,
    selectOuter,
} from './picking/candidate_navigation.js';
import {attachPickerListeners, type PickerDetach} from './picking/dom_adapter.js';
import {planAnnotationFromCandidate} from './recommend/candidate_to_annotation.js';
import {filterCandidatesForAnnotationType} from './recommend/recommend_types.js';
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
    businessObjectAddOptions,
    checkIssueMessage,
    deriveCanvasPresentation,
    deriveProductStage,
    listEntityBusinessObjects,
    recognitionGuideMessage,
    resolveCheckIssueRecovery,
    summarizeEntityDraft,
    type AnnotatorProductStage,
    type BusinessObjectAddOption,
    type BusinessObjectEditPatch,
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
    (e: 'debugState', detail: string): void;
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
const settingsNameValue = ref('');
const objectPanelOpen = ref(false);
const exitConfirmOpen = ref(false);
const entryChoiceOpen = ref(false);
const entryChoiceBusy = ref(false);
const recoverableSessionState = ref<AnnotatorState | null>(null);
const selectedProfileName = ref('');
const pickRequestedType = ref<BusinessObjectAddOption['type'] | null>(null);
const pickError = ref<string | null>(null);
const pickGuideVisible = ref(false);
let pickGuideTimer: ReturnType<typeof setTimeout> | null = null;
const reviewPending = ref(false);
const guideVisible = ref(false);
const guideMessage = ref('');
let guideTimer: ReturnType<typeof setTimeout> | null = null;
const pickTargetEntityId = ref<string | null>(null);
const pickTargetAnnotationId = ref<string | null>(null);
const pickCandidates = ref<PickCandidate[]>([]);
const pickCandidateIndex = ref(0);
const pickPointer = ref<{x: number; y: number} | null>(null);
type PendingAnnotationEdit = {
    entityId: string;
    annotation: CanvasAnnotationDraft;
    candidate: PickCandidate;
};
const pendingAnnotationEdit = ref<PendingAnnotationEdit | null>(null);
const pendingEditorOffset = ref({x: 0, y: 0});
const detailEditorDirty = ref(false);
const coordinateProbe = ref<HTMLElement | null>(null);
const overlaySpace = ref({x: 0, y: 0, scaleX: 1, scaleY: 1});
let pickerDetach: PickerDetach | null = null;
let mutationObserver: MutationObserver | null = null;

const win = () => (typeof window !== 'undefined' ? window : null);

const stableJson = (value: unknown): string => JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {return current;}
    return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right)),
    );
});

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
            objectPanelOpen.value ||
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

const settingsDirty = computed(() =>
    settingsOpen.value &&
    settingsNameValue.value.trim() !== (currentEntity.value?.name ?? ''),
);

const hasLocalPendingChanges = computed(() =>
    Boolean(pendingAnnotationEdit.value) || detailEditorDirty.value || settingsDirty.value,
);
const hasUnsavedWork = computed(() => props.state.dirty || hasLocalPendingChanges.value);
const dockCopy = computed(() =>
    hasLocalPendingChanges.value ? '请先应用当前修改' : (currentEntity.value?.name || '识别结果'),
);

const cancelSettings = (): void => {
    settingsOpen.value = false;
    settingsNameValue.value = currentEntity.value?.name ?? '';
};

const toggleSettings = (): void => {
    if (settingsOpen.value) {
        cancelSettings();
        return;
    }
    if (pendingAnnotationEdit.value || detailEditorDirty.value) {
        showActionGuide('请先应用或取消当前修改。');
        return;
    }
    settingsNameValue.value = currentEntity.value?.name ?? '';
    settingsOpen.value = true;
};

const applySettings = (): void => {
    if (!props.state.canvasDraft || !currentEntity.value) {return;}
    const name = settingsNameValue.value.trim() || '业务区域';
    const nextDraft = updateEntity(
        props.state.canvasDraft,
        currentEntity.value.id,
        {name},
    );
    applyState(draftEdited(props.state, nextDraft));
    settingsOpen.value = false;
};

const entryChoiceMessage = computed(() => {
    const hasDraft = Boolean(recoverableSessionState.value?.canvasDraft);
    const hasSaved = props.state.availableProfiles.length > 0;
    if (hasDraft && hasSaved) {return '发现未完成草稿和已有标注';}
    if (hasDraft) {return '发现未完成草稿';}
    return '发现已有标注';
});

const startFreshAnnotation = async (): Promise<void> => {
    if (entryChoiceBusy.value) {return;}
    entryChoiceBusy.value = true;
    try {
        const recoverable = recoverableSessionState.value;
        const recoverableKey = recoverable ? buildSessionKey(recoverable) : null;
        if (recoverableKey && props.sessionStore) {
            await props.sessionStore.clearDraft(recoverableKey);
        }
        const next: AnnotatorState = {
            ...props.state,
            canvasDraft: null,
            currentEntityId: null,
            currentAnnotationId: null,
            dirty: false,
            stale: false,
            artifactRevision: null,
            profileName: props.state.suggestedProfileName,
            history: {past: [], future: []},
            visualBindings: [],
            latestCheck: null,
            error: null,
        };
        recoverableSessionState.value = null;
        entryChoiceOpen.value = false;
        entryPreparedFor = entrySignatureForState(next);
        applyState(next);
        enterEntityPickMode();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applyState(failed(props.state, `无法新建标注：${message}`));
    } finally {
        entryChoiceBusy.value = false;
    }
};

const continueSessionDraft = (): void => {
    const recovered = recoverableSessionState.value;
    if (!recovered?.canvasDraft) {return;}
    entryChoiceOpen.value = false;
    recoverableSessionState.value = null;
    entryPreparedFor = entrySignatureForState(recovered);
    applyState(recovered);
};

const editSelectedProfile = async (): Promise<void> => {
    const page = props.state.pageIdentity;
    const profileName = selectedProfileName.value;
    if (!page || !profileName || !props.client || entryChoiceBusy.value) {return;}
    entryChoiceBusy.value = true;
    try {
        const result = await props.client.open({
            tabName: page.tabName,
            url: page.url,
            profileName,
        });
        const next = openLoaded(props.state, result);
        entryChoiceOpen.value = false;
        recoverableSessionState.value = null;
        entryPreparedFor = entrySignatureForState(next);
        applyState(next);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applyState(failed(props.state, `无法打开已有标注：${message}`));
    } finally {
        entryChoiceBusy.value = false;
    }
};

const requestExit = (): void => {
    if (hasLocalPendingChanges.value) {
        showActionGuide('请先应用或取消当前修改。');
        return;
    }
    if (hasUnsavedWork.value) {
        exitConfirmOpen.value = true;
        showActionGuide('未保存修改会保留为草稿。');
        return;
    }
    emit('exit');
};

const confirmExit = async (): Promise<void> => {
    exitConfirmOpen.value = false;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    try {
        await persistQueue;
        if (props.state.dirty) {
            const snapshot = sessionStateSnapshot();
            const key = buildSessionKey(snapshot);
            if (!key || !snapshot.canvasDraft || !snapshot.pageIdentity || !props.sessionStore) {
                throw new Error('草稿存储不可用');
            }
            await props.sessionStore.saveDraft(key, snapshot.canvasDraft, snapshot.pageIdentity);
            const verified = await props.sessionStore.loadDraft(key, snapshot.pageIdentity);
            if (!verified || stableJson(verified) !== stableJson(snapshot.canvasDraft)) {
                throw new Error('草稿写入校验失败');
            }
        }
        emit('exit');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applyState(failed(props.state, `无法保留草稿：${message}`));
    }
};

const currentEntitySummary = computed(() => summarizeEntityDraft(currentEntity.value));
const currentBusinessObjects = computed(() =>
    listEntityBusinessObjects(currentEntity.value, props.state.latestCheck)
        .slice()
        .sort((a, b) => {
            const rank = (item: typeof a): number => {
                if (item.validation === 'missing' || item.validation === 'multiple' || item.validation === 'invalid') {return 0;}
                if (item.disposition === 'ignored') {return 3;}
                return item.origin === 'inferred' ? 1 : 2;
            };
            return rank(a) - rank(b);
        }));
const currentAddOptions = computed(() => businessObjectAddOptions(currentEntity.value));
const annotatorDebugJson = computed(() => JSON.stringify({
    mode: props.state.mode,
    profileName: props.state.profileName,
    canvasDraft: props.state.canvasDraft,
    currentEntityId: props.state.currentEntityId,
    currentAnnotationId: props.state.currentAnnotationId,
    artifactRevision: props.state.artifactRevision,
    dirty: props.state.dirty,
    stale: props.state.stale,
    latestCheck: props.state.latestCheck,
    visualBindings: props.state.visualBindings,
    pickPurpose: pickPurpose.value,
    pickCandidates: pickCandidates.value,
    pickCandidateIndex: pickCandidateIndex.value,
    pendingAnnotationEdit: pendingAnnotationEdit.value,
    detailEditorDirty: detailEditorDirty.value,
    settingsDirty: settingsDirty.value,
    entryChoiceOpen: entryChoiceOpen.value,
    availableProfiles: props.state.availableProfiles,
    recoverableSessionDraft: Boolean(recoverableSessionState.value?.canvasDraft),
    exitConfirmOpen: exitConfirmOpen.value,
    pickGuideVisible: pickGuideVisible.value,
}));
const pickIntentLabel = computed(() =>
    currentAddOptions.value.find((option) => option.type === pickRequestedType.value)?.label.replace(/^添加/u, '') ?? null);

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
    if (operation.value === 'save' || props.state.mode === 'saving') {return '正在保存…';}
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

const blockingCheckIssue = computed(() => firstBlockingCheckIssue(props.state) ?? null);

const blockingIssueRecovery = computed(() =>
    resolveCheckIssueRecovery(entities.value, blockingCheckIssue.value));

const errorActionLabel = computed(() => {
    if (productStage.value === 'scope') {return '重新选择范围';}
    if (blockingIssueRecovery.value) {return '重新选择位置';}
    if (blockingCheckIssue.value || productStage.value === 'recognize') {return '重新识别';}
    return '重试';
});

const selectEntity = (entityId: string): void => {
    applyState(pickReceived(props.state, {
        entityId,
        annotationId: entityVisualId(entityId),
    }));
};

const dismissGuide = (): void => {
    guideVisible.value = false;
    reviewPending.value = false;
    if (guideTimer) {
        clearTimeout(guideTimer);
        guideTimer = null;
    }
};

const showGuide = (message: string, durationMs: number, review = false): void => {
    if (guideTimer) {clearTimeout(guideTimer);}
    guideMessage.value = message;
    guideVisible.value = true;
    reviewPending.value = review;
    guideTimer = setTimeout(() => {
        guideTimer = null;
        guideVisible.value = false;
        reviewPending.value = false;
    }, durationMs);
};

const showRecognitionGuide = (entity: CanvasEntityDraft): void => {
    showGuide(recognitionGuideMessage(entity), 6000, true);
};

const showActionGuide = (message: string): void => showGuide(message, 2600);

const selectedCandidate = computed<PickCandidate | null>(() =>
    chooseCandidate(pickCandidates.value, pickCandidateIndex.value),
);

const pickHighlightBox = computed<PickRect | null>(() => {
    const candidateBox = selectedCandidate.value?.bbox;
    if (candidateBox) {return toOverlayRect(candidateBox);}
    return hoverBox.value;
});

const pendingEditorStyle = computed<Record<string, string>>(() => {
    const pending = pendingAnnotationEdit.value;
    const target = pending?.candidate.bbox ? toOverlayRect(pending.candidate.bbox) : null;
    if (!pending || !target) {return {display: 'none'};}
    const width = Math.min(320, Math.max(280, viewport.value.width - 24));
    const height = 310;
    const base = placeFloatingPanel({
        target,
        viewport: {width: viewport.value.width, height: viewport.value.height},
        panel: {width, height},
    });
    const left = Math.max(12, Math.min(
        base.left + pendingEditorOffset.value.x,
        viewport.value.width - width - 12,
    ));
    const top = Math.max(12, Math.min(
        base.top + pendingEditorOffset.value.y,
        Math.max(12, viewport.value.height - height - 12),
    ));
    return {left: `${left}px`, top: `${top}px`, width: `${width}px`};
});

const movePendingEditor = (dx: number, dy: number): void => {
    pendingEditorOffset.value = {
        x: pendingEditorOffset.value.x + dx,
        y: pendingEditorOffset.value.y + dy,
    };
};

const selectedAnnotationEntityId = computed<string | null>(() => {
    if (!props.state.currentAnnotationId) {return null;}
    return entityIdForAnnotation(props.state.currentAnnotationId);
});

const onSelectAnnotation = (annotationId: string): void => {
    if (annotationId.startsWith('entity:')) {return;}
    detailEditorDirty.value = false;
    const entityId = entityIdForAnnotation(annotationId);
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickRequestedType.value = null;
    pickError.value = null;
    pickTargetAnnotationId.value = null;
    applyState(pickReceived(props.state, {annotationId, entityId}));
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
    if (
        !props.state.canvasDraft ||
        !props.state.dirty ||
        pickMode.value ||
        isBusy.value ||
        pendingAnnotationEdit.value ||
        detailEditorDirty.value ||
        settingsDirty.value
    ) {return;}
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
        await persistQueue;
        operation.value = 'save';
        applyState({...checked, mode: 'saving', error: null});
        const saved = await runSaveLoop(checked, props.client, props.sessionStore);
        applyState(saved);
    } finally {
        operation.value = null;
    }
};

const requestSave = async (): Promise<void> => {
    if (hasLocalPendingChanges.value) {
        showActionGuide('请先应用或取消当前修改。');
        return;
    }
    await runCheckAndSave();
};

const stateHasInternalObjects = (state: AnnotatorState): boolean => {
    const entity = state.canvasDraft?.entities[0];
    return Boolean(
        entity && (
            entity.annotations.length > 0 ||
            entity.columns.length > 0 ||
            entity.pagination
        ),
    );
};

const runRecognizeFromState = async (sourceState: AnnotatorState): Promise<void> => {
    if (pickMode.value || isBusy.value) {return;}
    operation.value = 'recognize';
    applyState({...sourceState, error: null});
    try {
        const wasFirstRecognition = !stateHasInternalObjects(sourceState) && !sourceState.artifactRevision;
        const next = await runRecognizeLoop(sourceState, props.client);
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
        if (!withGeometry.error && withGeometry.canvasDraft?.entities[0]) {
            const recognizedEntity = withGeometry.canvasDraft.entities[0];
            if (wasFirstRecognition) {
                applyState(pickReceived(withGeometry, {
                    entityId: recognizedEntity.id,
                    annotationId: null,
                }));
                showRecognitionGuide(recognizedEntity);
            } else {
                showActionGuide('已重新识别，可使用撤销恢复。');
            }
        }
    } finally {
        operation.value = null;
    }
};

const runRecognize = async (): Promise<void> => {
    await runRecognizeFromState(props.state);
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

const showPickGuide = (durationMs = 4000): void => {
    if (pickGuideTimer) {clearTimeout(pickGuideTimer);}
    pickGuideVisible.value = true;
    pickGuideTimer = setTimeout(() => {
        pickGuideTimer = null;
        pickGuideVisible.value = false;
    }, durationMs);
};

const hidePickGuide = (): void => {
    pickGuideVisible.value = false;
    if (pickGuideTimer) {
        clearTimeout(pickGuideTimer);
        pickGuideTimer = null;
    }
};

const enterPickMode = (
    annotationId: string | null,
    requestedType: BusinessObjectAddOption['type'] | null = null,
): void => {
    if (hasLocalPendingChanges.value) {
        showActionGuide('请先应用或取消当前修改。');
        return;
    }
    if (!props.state.canvasDraft || !ensurePickTargetEntity()) {
        applyState(failed(props.state, '请先选择并确认实体区域。'));
        return;
    }
    detailEditorDirty.value = false;
    pickPurpose.value = 'annotation';
    pickRequestedType.value = annotationId ? null : requestedType;
    pickError.value = null;
    pickTargetAnnotationId.value = annotationId;
    pickTargetEntityId.value = ensurePickTargetEntity();
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickPointer.value = null;
    pickMode.value = true;
    showPickGuide();
    applyState({...props.state, error: null});
};

const enterEntityPickMode = (): void => {
    if (hasLocalPendingChanges.value) {
        showActionGuide('请先应用或取消当前修改。');
        return;
    }
    pickPurpose.value = 'entity';
    pickRequestedType.value = null;
    pickError.value = null;
    pickTargetAnnotationId.value = null;
    pickTargetEntityId.value = null;
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickPointer.value = null;
    pickMode.value = true;
    showPickGuide();
    reviewPending.value = false;
    applyState({...props.state, error: null});
};

const toggleObjectPanel = (): void => {
    if (!objectPanelOpen.value && hasLocalPendingChanges.value) {
        showActionGuide('请先应用或取消当前修改。');
        return;
    }
    objectPanelOpen.value = !objectPanelOpen.value;
};

const selectBusinessObject = (annotationId: string): void => {
    objectPanelOpen.value = false;
    onSelectAnnotation(annotationId);
};

const startAddBusinessObject = (type: BusinessObjectAddOption['type']): void => {
    objectPanelOpen.value = false;
    enterPickMode(null, type);
};

const reselectBusinessObject = (annotationId: string): void => {
    objectPanelOpen.value = false;
    applyState(pickReceived(props.state, {
        annotationId,
        entityId: entityIdForAnnotation(annotationId),
    }));
    enterPickMode(annotationId);
};

const recoverFromError = (): void => {
    if (productStage.value === 'scope') {
        enterEntityPickMode();
        return;
    }
    const issue = blockingCheckIssue.value;
    const recovery = blockingIssueRecovery.value;
    if (recovery?.kind === 'entity') {
        enterEntityPickMode();
        return;
    }
    if (recovery?.kind === 'item') {
        applyState(pickReceived(props.state, {
            annotationId: recovery.annotationId,
            entityId: recovery.entityId,
        }));
        enterPickMode(recovery.annotationId);
        return;
    }
    if (issue || productStage.value === 'recognize') {
        void runRecognize();
        return;
    }
    void runCheck();
};

const exitPickMode = (options: {keepChain?: boolean} = {}): void => {
    pickMode.value = false;
    if (!options.keepChain) {
        pickCandidates.value = [];
        pickCandidateIndex.value = 0;
        pickTargetAnnotationId.value = null;
    }
    pickPointer.value = null;
    pickRequestedType.value = null;
    pickError.value = null;
    hidePickGuide();
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
    let candidates = candidatesForPurpose(result.candidateChain, pickPurpose.value);
    if (pickPurpose.value === 'annotation' && pickRequestedType.value) {
        candidates = filterCandidatesForAnnotationType(
            candidates,
            currentEntity.value?.kind,
            pickRequestedType.value,
        );
        if (candidates.length === 0) {
            pickCandidates.value = [];
            pickError.value = `所选对象不能作为${pickIntentLabel.value || '当前业务对象'}，请重新点击。`;
            showPickGuide(6000);
            return;
        }
    }
    if (pickPurpose.value === 'entity' && candidates.length === 0) {
        exitPickMode();
        applyState(failed(props.state, '没有识别到完整区域，请点击区域内的字段或表格后重试。'));
        return;
    }
    pickError.value = null;
    pickCandidates.value = candidates;
    pickCandidateIndex.value = defaultCandidateIndex(candidates, pickPurpose.value);
};

const onPickConfirm = async (): Promise<void> => {
    const candidate = selectedCandidate.value;
    if (!candidate) {return;}
    if (pickPurpose.value === 'entity') {
        if (!isConfirmableEntityCandidate(candidate)) {
            exitPickMode();
            applyState(failed(props.state, '没有找到可保存的区域，请重新选择。'));
            return;
        }
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
            const scopedState = pickReceived(withEntityBinding, {
                entityId,
                annotationId: null,
            });
            applyState(scopedState);
            reviewPending.value = false;
            exitPickMode();
            await nextTick();
            await runRecognizeFromState(scopedState);
        } catch (error) {
            exitPickMode();
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
    const plan = planAnnotationFromCandidate(
        candidate,
        entity,
        pickTargetAnnotationId.value ? undefined : pickRequestedType.value ?? undefined,
    );
    if (!props.state.canvasDraft) {return;}
    if (pickTargetAnnotationId.value) {
        const nextDraft = replaceVisualItemSelection(
            props.state.canvasDraft,
            entityId,
            pickTargetAnnotationId.value,
            {target: plan.annotation.target},
        );
        applyState(draftEdited(props.state, nextDraft));
        applyState(pickReceived(props.state, {
            annotationId: pickTargetAnnotationId.value,
            entityId,
        }));
        exitPickMode();
        return;
    }
    pendingAnnotationEdit.value = {
        entityId,
        annotation: plan.annotation,
        candidate,
    };
    pendingEditorOffset.value = {x: 0, y: 0};
    applyState(pickReceived(props.state, {annotationId: null, entityId}));
    exitPickMode({keepChain: true});
};

const onPickCancel = (): void => {
    const shouldExitAnnotator = pickPurpose.value === 'entity' && !props.state.canvasDraft;
    exitPickMode();
    if (shouldExitAnnotator) {
        emit('exit');
    }
};

const onNavigate = (direction: 'outer' | 'inner'): void => {
    if (pickCandidates.value.length === 0) {return;}
    const next = direction === 'outer'
        ? selectOuter(pickCandidates.value, pickCandidateIndex.value)
        : selectInner(pickCandidates.value, pickCandidateIndex.value);
    if (next === pickCandidateIndex.value) {return;}
    pickCandidateIndex.value = next;
    if (!pickMode.value) {
        const candidate = chooseCandidate(pickCandidates.value, next);
        const entityId = ensurePickTargetEntity();
        const entity = entityId ? entities.value.find((item) => item.id === entityId) : null;
        if (!candidate || !entity) {return;}
        if (pendingAnnotationEdit.value) {
            const plan = planAnnotationFromCandidate(
                candidate,
                entity,
                pendingAnnotationEdit.value.annotation.type,
            );
            pendingAnnotationEdit.value = {
                ...pendingAnnotationEdit.value,
                candidate,
                annotation: {
                    ...pendingAnnotationEdit.value.annotation,
                    target: plan.annotation.target,
                },
            };
            return;
        }
        if (pickTargetAnnotationId.value && props.state.canvasDraft) {
            const plan = planAnnotationFromCandidate(candidate, entity);
            const nextDraft = replaceVisualItemSelection(
                props.state.canvasDraft,
                entityId!,
                pickTargetAnnotationId.value,
                {target: plan.annotation.target},
            );
            applyState(draftEdited(props.state, nextDraft));
        }
    }
};

const applyDraftUpdate = (nextDraft: CanvasDraft): void => {
    applyState(draftEdited(props.state, nextDraft));
};

const onApplyBusinessEdit = (
    entityId: string,
    annotationId: string,
    patch: BusinessObjectEditPatch,
): void => {
    if (!props.state.canvasDraft) {return;}
    const entity = entities.value.find((item) => item.id === entityId);
    if (!entity) {return;}
    let nextDraft = props.state.canvasDraft;
    if (patch.name !== undefined) {
        if (annotationId === entityVisualId(entityId)) {
            nextDraft = updateEntity(nextDraft, entityId, {name: patch.name});
        } else if (entity.columns.some((column) => column.id === annotationId)) {
            nextDraft = updateColumn(nextDraft, entityId, annotationId, {name: patch.name});
        } else if (entity.columns.some((column) => column.actions.some((action) => action.id === annotationId))) {
            nextDraft = updateColumnAction(nextDraft, entityId, annotationId, {text: patch.name});
        } else if (annotationId !== paginationPageVisualId(entityId)) {
            nextDraft = updateAnnotation(nextDraft, entityId, annotationId, {name: patch.name});
        }
    }
    if (patch.fieldKey !== undefined) {
        nextDraft = updateAnnotation(nextDraft, entityId, annotationId, {businessKey: patch.fieldKey});
    }
    if (patch.actionIntent !== undefined) {
        if (entity.columns.some((column) => column.actions.some((action) => action.id === annotationId))) {
            nextDraft = updateColumnAction(nextDraft, entityId, annotationId, {
                actionIntent: patch.actionIntent,
            });
        } else if (annotationId === paginationPageVisualId(entityId)) {
            nextDraft = updatePagination(nextDraft, entityId, {actionIntent: patch.actionIntent});
        } else {
            nextDraft = updateAnnotation(nextDraft, entityId, annotationId, {
                businessKey: patch.actionIntent,
            });
        }
    }
    if (patch.columnKind !== undefined) {
        nextDraft = updateColumn(nextDraft, entityId, annotationId, {kind: patch.columnKind});
    }
    if (patch.primaryKey !== undefined) {
        nextDraft = setColumnPrimaryKey(nextDraft, entityId, annotationId, patch.primaryKey);
    }
    applyDraftUpdate(nextDraft);
    detailEditorDirty.value = false;
    applyState(pickReceived(props.state, {annotationId: null, entityId}));
};

const onApplyPendingEdit = (patch: BusinessObjectEditPatch): void => {
    const pending = pendingAnnotationEdit.value;
    if (!pending || !props.state.canvasDraft) {return;}
    const annotation: CanvasAnnotationDraft = {
        ...pending.annotation,
        ...(patch.name !== undefined ? {name: patch.name} : {}),
        ...(patch.fieldKey !== undefined ? {businessKey: patch.fieldKey} : {}),
        ...(patch.actionIntent !== undefined ? {businessKey: patch.actionIntent} : {}),
        target: {...pending.annotation.target},
    };
    const nextDraft = addAnnotation(
        props.state.canvasDraft,
        pending.entityId,
        annotation,
    );
    applyDraftUpdate(nextDraft);
    pendingAnnotationEdit.value = null;
    pendingEditorOffset.value = {x: 0, y: 0};
    detailEditorDirty.value = false;
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickTargetEntityId.value = null;
    pickTargetAnnotationId.value = null;
    applyState(pickReceived(props.state, {
        annotationId: null,
        entityId: pending.entityId,
    }));
};

const cancelPendingEdit = (): void => {
    pendingAnnotationEdit.value = null;
    pendingEditorOffset.value = {x: 0, y: 0};
    detailEditorDirty.value = false;
    pickCandidates.value = [];
    pickCandidateIndex.value = 0;
    pickTargetEntityId.value = null;
    pickTargetAnnotationId.value = null;
};

const onDeleteAnnotation = (annotationId: string): void => {
    if (!props.state.canvasDraft) {return;}
    const entityId = entityIdForAnnotation(annotationId);
    if (!entityId) {return;}
    const nextDraft = deleteVisualItem(props.state.canvasDraft, entityId, annotationId);
    applyState(draftEdited(props.state, nextDraft));
    detailEditorDirty.value = false;
    applyState(pickReceived(props.state, {annotationId: null, entityId}));
    showActionGuide('已删除，可使用撤销恢复。');
};

const onIgnoreAnnotation = (annotationId: string): void => {
    if (!props.state.canvasDraft) {return;}
    const entityId = entityIdForAnnotation(annotationId);
    if (!entityId) {return;}
    const nextDraft = ignoreVisualItem(props.state.canvasDraft, entityId, annotationId);
    applyState(draftEdited(props.state, nextDraft));
    detailEditorDirty.value = false;
    applyState(pickReceived(props.state, {annotationId: null, entityId}));
    showActionGuide('已设为不使用，可使用撤销恢复。');
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
        case 'cancel': {
            let handled = true;
            if (exitConfirmOpen.value) {
                exitConfirmOpen.value = false;
            } else if (entryChoiceOpen.value) {
                emit('exit');
            } else if (pickMode.value) {
                onPickCancel();
            } else if (pendingAnnotationEdit.value) {
                cancelPendingEdit();
            } else if (settingsOpen.value) {
                cancelSettings();
            } else if (objectPanelOpen.value) {
                objectPanelOpen.value = false;
            } else if (props.state.currentAnnotationId) {
                detailEditorDirty.value = false;
                applyState(pickReceived(props.state, {annotationId: null}));
            } else if (guideVisible.value) {
                dismissGuide();
            } else {
                handled = false;
            }
            if (handled) {event.preventDefault();}
            break;
        }
        case 'confirm':
            if (pickMode.value) {
                onPickConfirm();
            }
            break;
        case 'delete':
            if (props.state.currentAnnotationId) {
                event.preventDefault();
                showActionGuide('请在详情中确认删除。');
            }
            break;
        case 'save':
            event.preventDefault();
            void requestSave();
            break;
        case 'undo':
            event.preventDefault();
            if (hasLocalPendingChanges.value) {
                showActionGuide('请先应用或取消当前修改。');
            } else {
                applyUndo();
            }
            break;
        case 'redo':
            event.preventDefault();
            if (hasLocalPendingChanges.value) {
                showActionGuide('请先应用或取消当前修改。');
            } else {
                applyRedo();
            }
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

const eventPathHasClass = (event: Event, className: string): boolean =>
    event.composedPath().some((node) => node instanceof Element && node.classList.contains(className));

const eventPathHasAction = (event: Event, action: string): boolean =>
    event.composedPath().some((node) =>
        node instanceof Element && node.getAttribute('data-annotator-action') === action,
    );

const onGlobalPointerDown = (event: PointerEvent): void => {
    if (pickMode.value) {return;}
    const insideEditor = eventPathHasClass(event, 'annotator-edit-anchor') ||
        eventPathHasClass(event, 'pending-edit-anchor');
    const insideDock = eventPathHasClass(event, 'floating-dock');
    if (!insideEditor && !(insideDock && hasLocalPendingChanges.value)) {
        if (pendingAnnotationEdit.value) {cancelPendingEdit();}
        if (props.state.currentAnnotationId) {
            detailEditorDirty.value = false;
            applyState(pickReceived(props.state, {
                annotationId: null,
                entityId: props.state.currentEntityId,
            }));
        }
    }
    if (exitConfirmOpen.value && !eventPathHasClass(event, 'exit-confirm')) {
        exitConfirmOpen.value = false;
    }
    if (
        objectPanelOpen.value &&
        !eventPathHasClass(event, 'business-object-panel') &&
        !eventPathHasAction(event, 'business-objects')
    ) {
        objectPanelOpen.value = false;
    }
    if (
        settingsOpen.value &&
        !(insideDock && hasLocalPendingChanges.value) &&
        !eventPathHasClass(event, 'settings-popover') &&
        !event.composedPath().some((node) =>
            node instanceof Element && node.getAttribute('aria-label') === '设置',
        )
    ) {
        cancelSettings();
    }
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistQueue: Promise<void> = Promise.resolve();

const sessionStateSnapshot = (): AnnotatorState => ({
    ...props.state,
    canvasDraft: props.state.canvasDraft
        ? JSON.parse(JSON.stringify(props.state.canvasDraft)) as CanvasDraft
        : null,
    pageIdentity: props.state.pageIdentity ? {...props.state.pageIdentity} : null,
    history: {
        past: props.state.history.past.map((draft) => JSON.parse(JSON.stringify(draft)) as CanvasDraft),
        future: props.state.history.future.map((draft) => JSON.parse(JSON.stringify(draft)) as CanvasDraft),
    },
    visualBindings: props.state.visualBindings.map((binding) => ({...binding})),
    latestCheck: props.state.latestCheck?.map((result) => ({...result, nodeIds: [...result.nodeIds]})) ?? null,
});

const enqueueSessionPersist = (state = sessionStateSnapshot()): Promise<void> => {
    persistQueue = persistQueue.then(async () => {
        await persistSessionDraft(state, props.sessionStore);
    });
    return persistQueue;
};

const schedulePersist = (): void => {
    if (!props.state.dirty || !props.state.canvasDraft) {
        return;
    }
    if (persistTimer) {
        clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void enqueueSessionPersist();
    }, 400);
};

const entrySignatureForState = (state: AnnotatorState): string | null => {
    const page = state.pageIdentity;
    if (!page) {return null;}
    return [
        page.workspaceName,
        page.tabName,
        page.url,
        state.profileName ?? '__new__',
        state.artifactRevision ?? '__none__',
    ].join('|');
};

let entryPreparedFor: string | null = null;
let entryPrepareRequest = 0;

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
    document.addEventListener('pointerdown', onGlobalPointerDown, true);
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
    if (guideTimer) {
        clearTimeout(guideTimer);
        guideTimer = null;
    }
    if (pickGuideTimer) {
        clearTimeout(pickGuideTimer);
        pickGuideTimer = null;
    }
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('pointerdown', onGlobalPointerDown, true);
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
        if (mode !== 'idle') {return;}
        entryPreparedFor = null;
        entryPrepareRequest += 1;
        entryChoiceOpen.value = false;
        entryChoiceBusy.value = false;
        recoverableSessionState.value = null;
        selectedProfileName.value = '';
        exitPickMode();
    },
);

watch(
    annotatorDebugJson,
    (detail) => emit('debugState', detail),
    {immediate: true},
);

watch(
    () => [
        props.state.pageIdentity,
        props.state.availableProfiles,
        props.state.canvasDraft,
        props.state.profileName,
        props.state.artifactRevision,
    ],
    () => {
        if (props.state.mode !== 'editing' || !props.state.pageIdentity) {return;}
        const sig = entrySignatureForState(props.state);
        if (!sig || entryPreparedFor === sig) {return;}
        if (props.state.canvasDraft) {
            entryPreparedFor = sig;
            entryChoiceOpen.value = false;
            recoverableSessionState.value = null;
            return;
        }
        const request = ++entryPrepareRequest;
        void (async () => {
            const recovered = await restoreSessionDraft(props.state, props.sessionStore);
            if (request !== entryPrepareRequest || entrySignatureForState(props.state) !== sig) {return;}
            entryPreparedFor = sig;
            recoverableSessionState.value = recovered.canvasDraft ? recovered : null;
            const firstProfile = props.state.availableProfiles[0]?.profileName ?? '';
            if (!selectedProfileName.value || !props.state.availableProfiles.some(
                (profile) => profile.profileName === selectedProfileName.value,
            )) {
                selectedProfileName.value = firstProfile;
            }
            if (recoverableSessionState.value || props.state.availableProfiles.length > 0) {
                entryChoiceOpen.value = true;
                exitPickMode();
                return;
            }
            entryChoiceOpen.value = false;
            enterEntityPickMode();
        })();
    },
    {deep: true, immediate: true},
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
        :data-entry-choice="entryChoiceOpen ? 'active' : 'inactive'"
        :class="{picking: pickMode}"
    >
        <div ref="coordinateProbe" class="coordinate-probe" aria-hidden="true"></div>

        <div v-if="state.error && !pickMode" class="annotator-toast error annotator-error-banner" role="alert">
            <span>!</span>
            <p>{{ state.error }}</p>
            <button
                type="button"
                :disabled="isBusy"
                data-annotator-action="recover-error"
                @click="recoverFromError"
            >{{ errorActionLabel }}</button>
        </div>

        <div v-if="isBusy && !pickMode" class="annotator-toast busy" role="status" aria-live="polite">
            <span class="busy-spinner"></span>
            <p>{{ busyLabel }}</p>
        </div>

        <div
            v-if="entryChoiceOpen && !pickMode"
            class="floating-dock entry-choice-dock dock-bottom"
            data-annotator-action="entry-choice"
        >
            <strong>{{ entryChoiceMessage }}</strong>
            <button
                v-if="recoverableSessionState?.canvasDraft"
                type="button"
                data-annotator-action="continue-draft"
                :disabled="entryChoiceBusy"
                @click="continueSessionDraft"
            >继续草稿</button>
            <template v-if="state.availableProfiles.length">
                <select v-model="selectedProfileName" aria-label="选择已有标注" :disabled="entryChoiceBusy">
                    <option
                        v-for="profile in state.availableProfiles"
                        :key="profile.profileName"
                        :value="profile.profileName"
                    >{{ profile.label }}</option>
                </select>
                <button
                    type="button"
                    data-annotator-action="edit-existing"
                    :disabled="entryChoiceBusy || !selectedProfileName"
                    @click="editSelectedProfile"
                >编辑已有</button>
            </template>
            <button
                type="button"
                class="dock-primary"
                data-annotator-action="start-fresh"
                :disabled="entryChoiceBusy"
                @click="startFreshAnnotation"
            >新建标注</button>
            <button type="button" aria-label="退出标注" :disabled="entryChoiceBusy" @click="emit('exit')">×</button>
        </div>

        <BusinessObjectPanel
            v-if="objectPanelOpen && currentEntity && !pickMode"
            :entity="currentEntity"
            :items="currentBusinessObjects"
            :summary="currentEntitySummary"
            :add-options="currentAddOptions"
            :selected-annotation-id="state.currentAnnotationId"
            :busy="isBusy"
            @select="selectBusinessObject"
            @reselect="reselectBusinessObject"
            @add="startAddBusinessObject"
            @close="objectPanelOpen = false"
        />

        <div
            v-if="(productStage === 'review' || productStage === 'edit') && !pickMode"
            class="floating-dock edit-dock dock-bottom"
        >
            <div v-if="exitConfirmOpen" class="exit-confirm">
                <span>有未保存修改，退出后仍保留为草稿。</span>
                <button type="button" @click="exitConfirmOpen = false">继续编辑</button>
                <button type="button" class="exit-confirm-action" @click="confirmExit">退出</button>
            </div>
            <template v-else>
                <span v-if="guideVisible" class="dock-guide">
                    <span class="dock-guide-copy">{{ guideMessage }}</span>
                    <button type="button" aria-label="关闭提示" @click="dismissGuide">×</button>
                </span>
                <strong v-else class="dock-copy">{{ dockCopy }}</strong>
                <button
                    type="button"
                    aria-label="撤销"
                    title="撤销"
                    :disabled="state.history.past.length === 0 || isBusy || hasLocalPendingChanges"
                    @click="applyUndo"
                >↶</button>
                <button
                    type="button"
                    aria-label="重做"
                    title="重做"
                    :disabled="state.history.future.length === 0 || isBusy || hasLocalPendingChanges"
                    @click="applyRedo"
                >↷</button>
                <i></i>
                <button
                    type="button"
                    data-annotator-action="business-objects"
                    :class="{active: objectPanelOpen}"
                    :disabled="isBusy"
                    @click="toggleObjectPanel"
                >识别结果 {{ currentEntitySummary.total }}</button>
                <button
                    type="button"
                    data-annotator-action="adjust-range"
                    :disabled="isBusy"
                    @click="enterEntityPickMode"
                >调整范围</button>
                <button
                    type="button"
                    class="dock-primary annotator-save-action"
                    data-annotator-action="save-rules"
                    :class="{saved: !state.dirty && Boolean(state.artifactRevision)}"
                    :disabled="isBusy || !state.profileName || (!state.dirty && !hasLocalPendingChanges)"
                    :title="hasLocalPendingChanges ? '请先应用或取消当前修改' : '保存规则'"
                    @click="requestSave"
                >
                    <span v-if="operation === 'check'">检查中…</span>
                    <span v-else-if="operation === 'save'">保存中…</span>
                    <span v-else-if="hasLocalPendingChanges">先应用当前修改</span>
                    <span v-else-if="!state.dirty && state.artifactRevision">✓ 已保存</span>
                    <span v-else>保存规则</span>
                </button>
                <button
                    type="button"
                    data-annotator-action="settings"
                    aria-label="设置"
                    title="设置"
                    :class="{active: settingsOpen}"
                    @click="toggleSettings"
                >⚙</button>
                <button
                    type="button"
                    data-annotator-action="exit"
                    aria-label="退出"
                    title="退出"
                    @click="requestExit"
                >×</button>
            </template>
        </div>

        <div
            v-if="settingsOpen && productStage === 'edit' && !pickMode"
            class="settings-popover dock-bottom"
        >
            <header>
                <strong>区域设置</strong>
                <button type="button" aria-label="关闭设置" @click="cancelSettings">×</button>
            </header>
            <label>
                <span>业务区域名称</span>
                <input v-model="settingsNameValue" type="text" placeholder="例如：订单查询列表" />
            </label>
            <div class="settings-actions">
                <button type="button" class="quiet-action" @click="cancelSettings">取消</button>
                <button type="button" class="dock-primary" :disabled="!settingsDirty || isBusy" @click="applySettings">应用</button>
            </div>
            <button
                type="button"
                class="quiet-action"
                :disabled="isBusy || settingsDirty"
                :title="settingsDirty ? '请先应用或取消名称修改' : '重新分析当前区域'"
                @click="runRecognize"
            >重新识别</button>
        </div>

        <div
            v-if="pickMode && !selectedCandidate"
            class="pick-guide"
            :class="{compact: !pickGuideVisible}"
        >
            <template v-if="pickGuideVisible">
                <span class="pick-guide-icon">⌖</span>
                <div>
                    <strong>{{ pickError || (pickPurpose === 'entity' ? '点击要自动化的区域' : `点击要添加的${pickIntentLabel || '页面对象'}`) }}</strong>
                    <small>{{ pickPurpose === 'entity' ? '点击区域内任意内容后确认。' : '选择后可确认或调整范围。' }}</small>
                </div>
                <button type="button" data-annotator-action="hide-pick-guide" @click="hidePickGuide">隐藏</button>
            </template>
            <button type="button" data-annotator-action="cancel-pick" @click="onPickCancel">退出选择</button>
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
        @apply-edit="onApplyBusinessEdit"
        @edit-dirty-change="detailEditorDirty = $event"
        @reselect="(annotationId) => annotationId === entityVisualId(currentEntity?.id || '') ? enterEntityPickMode() : enterPickMode(annotationId)"
        @navigate="onNavigate"
        @delete="onDeleteAnnotation"
        @ignore="onIgnoreAnnotation"
        @close="applyState(pickReceived(state, {annotationId: null, entityId: currentEntity?.id || null}))"
    />
    <div
        v-if="pendingAnnotationEdit && !pickMode"
        class="pending-edit-anchor"
        :style="pendingEditorStyle"
    >
        <EditCard
            :annotation="pendingAnnotationEdit.annotation"
            :annotation-kind="pendingAnnotationEdit.annotation.type"
            :entity="entities.find((item) => item.id === pendingAnnotationEdit?.entityId) || null"
            :candidate="pendingAnnotationEdit.candidate"
            :candidate-index="pickCandidateIndex"
            :candidate-chain-length="pickCandidates.length"
            :can-delete="false"
            :can-reselect="false"
            :can-ignore="false"
            :can-set-primary-key="false"
            :is-primary-key="false"
            :is-new="true"
            @apply="onApplyPendingEdit"
            @move="movePendingEditor"
            @dirty-change="detailEditorDirty = $event"
            @outer="onNavigate('outer')"
            @inner="onNavigate('inner')"
            @close="cancelPendingEdit"
        />
    </div>

    <PickOverlay
        v-if="pickMode"
        :candidate="selectedCandidate"
        :candidate-index="pickCandidateIndex"
        :candidate-chain-length="pickCandidates.length"
        :current-entity-kind="currentEntity?.kind as EntityKind | undefined"
        :pointer="pickPointer"
        :purpose="pickPurpose"
        :intent-label="pickIntentLabel"
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
.floating-dock,
.settings-popover,
.annotator-toast { pointer-events: auto; }
.pick-guide { pointer-events: none; }
.pick-guide button { pointer-events: auto; }
.exit-confirm {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #7c2d12;
    font-size: 10px;
    font-weight: 700;
    pointer-events: auto;
}
.exit-confirm span { padding: 0 6px; white-space: nowrap; }
.exit-confirm button {
    min-height: 32px;
    border: 1px solid #fed7aa;
    border-radius: 8px;
    padding: 0 10px;
    background: #fff;
    color: #9a3412;
    font-size: 9px;
    font-weight: 700;
    cursor: pointer;
}
.exit-confirm .exit-confirm-action { background: #9a3412; border-color: #9a3412; color: #fff; }
.dock-guide {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 260px;
    color: #334155;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
}
.dock-guide-copy {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.dock-guide button {
    width: 24px;
    min-width: 24px;
    height: 24px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #64748b;
}
.dock-guide button:hover { background: #f1f5f9; }
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
.dock-primary:hover:not(:disabled) { background: #1d4ed8; }
.dock-primary:disabled { opacity: .45; cursor: default; box-shadow: none; }
.quiet-action {
    min-height: 34px;
    border: 1px solid #dbe3ee;
    border-radius: 9px;
    padding: 0 11px;
    background: #fff;
    color: #475569;
    font-size: 11px;
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
.entry-choice-dock { gap: 7px; }
.entry-choice-dock strong {
    max-width: 220px;
    overflow: hidden;
    padding: 0 6px;
    color: #334155;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.entry-choice-dock select {
    max-width: 190px;
    height: 34px;
    border: 1px solid #cbd5e1;
    border-radius: 9px;
    padding: 0 9px;
    background: #fff;
    color: #0f172a;
    font-size: 11px;
    pointer-events: auto;
}
.entry-choice-dock select:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
}
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
.pending-edit-anchor {
    position: fixed;
    z-index: 2147483646;
    padding: 12px;
    border: 1px solid #cbd5e1;
    border-radius: 14px;
    background: rgba(255, 255, 255, .98);
    box-shadow: 0 18px 48px rgba(15, 23, 42, .26);
    backdrop-filter: blur(16px);
    pointer-events: auto;
    max-height: calc(100vh - 24px);
    overflow: auto;
}
.settings-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px;
}
.settings-popover .dock-primary { min-height: 34px; }
.settings-popover header { display: flex; align-items: center; justify-content: space-between; }
.settings-popover header strong { font-size: 11px; }
.settings-popover header button { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; }
.settings-popover header button:hover { background: #f1f5f9; }
.settings-popover label { display: grid; gap: 5px; }
.settings-popover label span { color: #475569; font-size: 11px; font-weight: 700; }
.settings-popover input { height: 36px; border: 1px solid #cbd5e1; border-radius: 9px; padding: 0 9px; outline: none; font-size: 12px; }
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
.annotator-toast p { flex: 1; margin: 0; font-size: 11px; line-height: 1.4; }
.annotator-toast button { border: 0; background: transparent; color: #2563eb; font-size: 11px; font-weight: 750; cursor: pointer; }
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
.pick-guide.compact {
    min-height: 0;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
}
.pick-guide.compact button {
    box-shadow: 0 5px 16px rgba(15, 23, 42, .14);
}
.pick-guide-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 9px; background: #eff6ff; color: #2563eb; font-size: 13px; }
.pick-guide > div { min-width: 0; flex: 1; }
.pick-guide strong { display: block; font-size: 12px; }
.pick-guide small { display: block; overflow: hidden; margin-top: 1px; color: #64748b; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.pick-guide button { height: 32px; border: 0; border-radius: 8px; padding: 0 10px; background: #f1f5f9; color: #475569; font-size: 11px; font-weight: 700; cursor: pointer; }
.pick-guide button:hover { background: #e2e8f0; }
@media (max-width: 680px) {
    .floating-dock { overflow-x: auto; justify-content: flex-start; }
}
@media (max-height: 520px) {
    .floating-dock.dock-top { top: 54px; }
}

button:focus-visible,
input:focus-visible,
select:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
}
</style>
