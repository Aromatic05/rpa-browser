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
    !currentEntity.value || box.entityId === currentEntity.value.id,
));

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

const statusText = computed(() => {
    if (isBusy.value) {return busyLabel.value;}
    if (props.state.stale) {return '页面内容已变化';}
    if (props.state.dirty) {return '有未保存修改';}
    if (props.state.artifactRevision) {return '已保存';}
    if (props.state.canvasDraft) {return '尚未保存';}
    return '等待识别';
});

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

const runSave = async (): Promise<void> => {
    if (!props.state.canvasDraft || !props.state.dirty || pickMode.value || isBusy.value) {return;}
    operation.value = 'save';
    applyState({...props.state, mode: 'saving', error: null});
    try {
        const next = await runSaveLoop(props.state, props.client, props.sessionStore);
        applyState(next);
    } finally {
        operation.value = null;
    }
};

const runRecognize = async (): Promise<void> => {
    if (pickMode.value || isBusy.value) {return;}
    operation.value = 'recognize';
    applyState({...props.state, error: null});
    try {
        const next = await runRecognizeLoop(props.state, props.client);
        applyState(next);
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
                annotationId: entityVisualId(nextDraft.entities[0].id),
            }));
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
            void runSave();
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
        class="annotator-shell"
        data-rpa-snapshot-ignore="true"
        data-rpa-annotator-host="true"
        :data-annotator-mode="state.mode"
        :data-annotator-draft="state.canvasDraft ? 'present' : 'empty'"
        :data-annotator-profile="state.profileName || ''"
        :class="{picking: pickMode}"
    >
        <button
            v-if="panelCollapsed && !pickMode"
            type="button"
            class="annotator-restore"
            @click="panelCollapsed = false"
        >
            <span class="annotator-restore-dot"></span>
            页面标注
            <span v-if="state.dirty" class="annotator-restore-badge">未保存</span>
        </button>

        <aside v-if="!panelCollapsed && !pickMode" class="annotator-workspace">
            <header class="annotator-workspace-header">
                <div class="annotator-title-block">
                    <span class="annotator-eyebrow">页面语义</span>
                    <strong>{{ currentEntity?.name || '当前页面' }}</strong>
                    <span class="annotator-status" :class="{error: state.error, busy: isBusy}">
                        {{ state.error ? '操作失败' : statusText }}
                    </span>
                </div>
                <div class="annotator-window-actions">
                    <button type="button" aria-label="收起" title="收起" @click="panelCollapsed = true">−</button>
                    <button type="button" aria-label="退出标注" title="退出标注" @click="emit('exit')">×</button>
                </div>
            </header>

            <div v-if="state.error" class="annotator-error-banner">
                <div>
                    <strong>没有完成操作</strong>
                    <p>{{ state.error }}</p>
                </div>
                <button
                    type="button"
                    :disabled="isBusy"
                    @click="state.canvasDraft ? runRecognize() : enterEntityPickMode()"
                >重试</button>
            </div>

            <div v-if="isBusy" class="annotator-progress" role="status" aria-live="polite">
                <span class="annotator-spinner"></span>
                <span>{{ busyLabel }}</span>
            </div>

            <div v-if="!state.canvasDraft" class="annotator-empty-state">
                <div class="annotator-empty-icon">⌁</div>
                <h2>先选择实体区域</h2>
                <p>请框定同时包含查询条件、结果列表和分页的大块业务区域。选择实体前不会识别内部字段或按钮。</p>
                <button
                    type="button"
                    class="annotator-main-action"
                    data-annotator-action="select-entity"
                    :disabled="isBusy"
                    @click="enterEntityPickMode"
                >选择实体区域</button>
            </div>

            <template v-else>
                <section class="annotator-section annotator-entity-section">
                    <div class="annotator-section-heading">
                        <span>实体</span>
                        <span>{{ entities.length }}</span>
                    </div>
                    <div class="annotator-entity-list">
                        <button
                            v-for="entity in entities"
                            :key="entity.id"
                            type="button"
                            class="annotator-entity-item"
                            :class="{active: entity.id === state.currentEntityId}"
                            @click="selectEntity(entity.id)"
                        >
                            <span class="annotator-entity-kind">{{ entity.kind }}</span>
                            <span class="annotator-entity-name">{{ entity.name || entity.businessTag }}</span>
                        </button>
                    </div>
                </section>

                <section
                    v-if="!hasInternalObjects && !state.artifactRevision"
                    class="annotator-scope-ready"
                >
                    <span class="annotator-scope-step">实体范围已确认</span>
                    <h2>{{ currentEntity?.name || '当前实体' }}</h2>
                    <p>下一步只分析该区域内部的查询字段、操作、表格列、行操作和分页。</p>
                    <button
                        type="button"
                        class="annotator-main-action"
                        data-annotator-action="recognize"
                        :disabled="isBusy"
                        @click="runRecognize"
                    >{{ operation === 'recognize' ? '正在识别…' : '识别内部对象' }}</button>
                    <button
                        type="button"
                        class="annotator-secondary-action"
                        :disabled="isBusy"
                        @click="enterEntityPickMode"
                    >重新选择实体范围</button>
                </section>

                <template v-else>
                <section class="annotator-section annotator-object-section">
                    <div class="annotator-section-heading">
                        <span>页面对象</span>
                        <button
                            type="button"
                            class="annotator-text-action"
                            :disabled="!currentEntity || isBusy"
                            @click="enterPickMode(null)"
                        >＋ 添加</button>
                    </div>
                    <div class="annotator-object-list">
                        <button
                            v-for="item in currentVisualItems"
                            :key="item.annotationId"
                            type="button"
                            class="annotator-object-item"
                            :class="{
                                active: item.annotationId === state.currentAnnotationId,
                                inferred: item.origin === 'inferred',
                                missing: itemStatus(item) === '未找到',
                            }"
                            @click="onSelectAnnotation(item.annotationId)"
                        >
                            <span class="annotator-object-icon" :data-kind="item.kind"></span>
                            <span class="annotator-object-copy">
                                <strong>{{ item.labelName }}</strong>
                                <small>{{ kindLabel(item.kind) }} · {{ item.businessKey }}</small>
                            </span>
                            <span class="annotator-object-status">{{ itemStatus(item) }}</span>
                        </button>
                    </div>
                </section>

                <section v-if="selectedAnnotation" class="annotator-section annotator-inspector-section">
                    <div class="annotator-section-heading">
                        <span>属性</span>
                        <button
                            type="button"
                            class="annotator-text-action"
                            @click="applyState(pickReceived(state, {annotationId: null}))"
                        >关闭</button>
                    </div>
                    <EditCard
                        :annotation="selectedAnnotation"
                        :entity="selectedEntity"
                        :candidate="selectedCandidate"
                        :candidate-index="pickCandidateIndex"
                        :candidate-chain-length="pickCandidates.length"
                        :can-change-type="selectedIsNativeAnnotation"
                        :can-delete="selectedBox?.kind !== 'entity'"
                        :can-ignore="selectedBox?.kind !== 'entity' && selectedBox?.kind !== 'pagination'"
                        @update="updateSelectedAnnotation"
                        @reselect="enterPickMode(selectedAnnotation.id)"
                        @outer="onNavigate('outer')"
                        @inner="onNavigate('inner')"
                        @delete="onDeleteAnnotation(selectedAnnotation.id)"
                        @ignore="onIgnoreAnnotation(selectedAnnotation.id)"
                        @choose-type="onChooseType"
                    />
                </section>

                <section v-else class="annotator-selection-hint">
                    点击网页上的框或右侧对象列表，查看并修改它的名称和业务标识。
                </section>

                <section class="annotator-rule-name">
                    <label for="rpa-profile-name">规则名称</label>
                    <input
                        id="rpa-profile-name"
                        v-model="profileNameModel"
                        type="text"
                        placeholder="例如：订单列表"
                    />
                </section>

                <footer class="annotator-footer">
                    <div class="annotator-history-actions">
                        <button
                            type="button"
                            aria-label="撤销"
                            title="撤销"
                            :disabled="state.history.past.length === 0 || isBusy"
                            @click="applyUndo"
                        >↶</button>
                        <button
                            type="button"
                            aria-label="重做"
                            title="重做"
                            :disabled="state.history.future.length === 0 || isBusy"
                            @click="applyRedo"
                        >↷</button>
                        <button type="button" :disabled="isBusy" @click="runRecognize">重新识别</button>
                    </div>
                    <div class="annotator-primary-actions">
                        <button type="button" :disabled="isBusy" @click="runCheck">检查</button>
                        <button
                            type="button"
                            class="annotator-save-action"
                            :disabled="!state.dirty || isBusy || !state.profileName"
                            @click="runSave"
                        >保存</button>
                    </div>
                </footer>
                </template>
            </template>
        </aside>

        <div v-if="pickMode" class="annotator-pick-bar">
            <div>
                <strong>
                    {{ operation === 'pick'
                        ? '正在识别所选范围…'
                        : (pickPurpose === 'entity' ? '点击实体区域内任意位置' : '点击网页中的对象') }}
                </strong>
                <span>
                    {{ pickPurpose === 'entity'
                        ? '只会提供实体大区域候选；使用外层/内部切换后确认范围。'
                        : '移动鼠标查看范围，点击后选择最合适的业务层级。' }}
                </span>
            </div>
            <button type="button" @click="onPickCancel">取消</button>
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
        v-if="!pickMode"
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
        @navigate="onNavigate"
        @confirm="onPickConfirm"
        @cancel="onPickCancel"
    />
</template>

<style scoped>
.annotator-shell {
    position: fixed;
    inset: 0;
    z-index: 4;
    pointer-events: none;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #172033;
}
.annotator-workspace {
    position: fixed;
    top: 16px;
    right: 16px;
    bottom: 16px;
    width: 340px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: auto;
    background: rgba(255, 255, 255, 0.98);
    border: 1px solid rgba(148, 163, 184, 0.4);
    border-radius: 16px;
    box-shadow: 0 22px 60px rgba(15, 23, 42, 0.24), 0 4px 14px rgba(15, 23, 42, 0.12);
    backdrop-filter: blur(18px);
}
.annotator-workspace-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid #e7ebf2;
    background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
}
.annotator-title-block { min-width: 0; display: grid; gap: 3px; }
.annotator-title-block strong { font-size: 15px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.annotator-eyebrow { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.annotator-status { color: #64748b; font-size: 11px; }
.annotator-status.busy { color: #1d4ed8; }
.annotator-status.error { color: #b42318; }
.annotator-window-actions { display: flex; gap: 4px; }
.annotator-window-actions button,
.annotator-history-actions button,
.annotator-primary-actions button {
    border: 1px solid #d8dee9;
    background: #fff;
    color: #334155;
    border-radius: 8px;
    cursor: pointer;
}
.annotator-window-actions button { width: 28px; height: 28px; font-size: 17px; line-height: 1; }
.annotator-window-actions button:hover { background: #f1f5f9; }
.annotator-error-banner {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin: 12px 12px 0;
    padding: 10px 12px;
    border: 1px solid #fecaca;
    border-radius: 10px;
    background: #fff7f7;
    color: #991b1b;
}
.annotator-error-banner strong { font-size: 12px; }
.annotator-error-banner p { margin: 3px 0 0; font-size: 11px; line-height: 1.4; }
.annotator-error-banner button { border: 1px solid #fca5a5; border-radius: 7px; background: #fff; color: #991b1b; padding: 5px 8px; cursor: pointer; }
.annotator-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 12px 0;
    padding: 9px 11px;
    border-radius: 10px;
    background: #eff6ff;
    color: #1d4ed8;
    font-size: 12px;
}
.annotator-spinner {
    width: 13px;
    height: 13px;
    border: 2px solid #bfdbfe;
    border-top-color: #2563eb;
    border-radius: 999px;
    animation: annotator-spin .8s linear infinite;
}
@keyframes annotator-spin { to { transform: rotate(360deg); } }
.annotator-empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 28px;
    text-align: center;
}
.annotator-empty-icon {
    width: 52px;
    height: 52px;
    display: grid;
    place-items: center;
    margin-bottom: 12px;
    border-radius: 14px;
    background: #eaf2ff;
    color: #2563eb;
    font-size: 30px;
}
.annotator-empty-state h2 { margin: 0 0 8px; font-size: 18px; }
.annotator-empty-state p { margin: 0 0 20px; color: #64748b; font-size: 12px; line-height: 1.55; }
.annotator-scope-ready {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 24px;
    text-align: center;
}
.annotator-scope-ready h2 { margin: 8px 0; font-size: 17px; }
.annotator-scope-ready p { margin: 0 0 18px; color: #64748b; font-size: 12px; line-height: 1.55; }
.annotator-scope-step { color: #2563eb; font-size: 11px; font-weight: 800; letter-spacing: .04em; }
.annotator-main-action,
.annotator-secondary-action {
    width: 100%;
    height: 38px;
    border-radius: 9px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}
.annotator-main-action { border: 1px solid #2563eb; background: #2563eb; color: #fff; }
.annotator-secondary-action { margin-top: 8px; border: 1px solid #d8dee9; background: #fff; color: #334155; }
.annotator-section { border-bottom: 1px solid #eef1f5; }
.annotator-section-heading {
    min-height: 36px;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: #64748b;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .02em;
}
.annotator-text-action { border: none; background: transparent; color: #2563eb; font-size: 11px; font-weight: 700; cursor: pointer; }
.annotator-entity-list { display: flex; gap: 6px; padding: 0 12px 12px; overflow-x: auto; }
.annotator-entity-item {
    flex: 0 0 auto;
    min-width: 108px;
    max-width: 180px;
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    text-align: left;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #fff;
    cursor: pointer;
}
.annotator-entity-item.active { border-color: #93b4ff; background: #eff6ff; box-shadow: inset 0 0 0 1px #bfdbfe; }
.annotator-entity-kind { color: #64748b; font-size: 9px; text-transform: uppercase; }
.annotator-entity-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 700; }
.annotator-object-section { min-height: 140px; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.annotator-object-list { flex: 1; overflow: auto; padding: 0 8px 10px; }
.annotator-object-item {
    width: 100%;
    min-height: 48px;
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: #172033;
    text-align: left;
    cursor: pointer;
}
.annotator-object-item:hover { background: #f8fafc; }
.annotator-object-item.active { background: #eef5ff; border-color: #c8dcff; }
.annotator-object-item.missing { background: #fff7f7; }
.annotator-object-icon { width: 8px; height: 8px; border-radius: 3px; background: #3b82f6; }
.annotator-object-icon[data-kind="field"] { background: #22a06b; }
.annotator-object-icon[data-kind="action"] { background: #f59e0b; }
.annotator-object-icon[data-kind="column"],
.annotator-object-icon[data-kind="pagination"] { background: #8b5cf6; }
.annotator-object-copy { min-width: 0; display: grid; gap: 2px; }
.annotator-object-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.annotator-object-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #64748b; font-size: 10px; }
.annotator-object-status { color: #64748b; font-size: 10px; white-space: nowrap; }
.annotator-object-item.inferred .annotator-object-status { color: #b7791f; }
.annotator-inspector-section { max-height: 310px; overflow: auto; padding-bottom: 12px; }
.annotator-inspector-section :deep(.annotator-edit-card) {
    width: auto;
    margin: 0 12px;
    padding: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
}
.annotator-inspector-section :deep(.annotator-edit-row) { gap: 5px; }
.annotator-inspector-section :deep(.annotator-edit-input),
.annotator-inspector-section :deep(.annotator-edit-select) { min-height: 32px; padding: 6px 8px; }
.annotator-inspector-section :deep(.annotator-edit-actions) { margin-top: 4px; }
.annotator-selection-hint { margin: 10px 12px; padding: 10px; border-radius: 9px; background: #f8fafc; color: #64748b; font-size: 11px; line-height: 1.45; }
.annotator-rule-name { display: grid; gap: 5px; padding: 10px 12px; border-top: 1px solid #eef1f5; }
.annotator-rule-name label { color: #64748b; font-size: 10px; font-weight: 700; }
.annotator-rule-name input { height: 32px; box-sizing: border-box; border: 1px solid #d8dee9; border-radius: 8px; padding: 0 9px; color: #172033; background: #fff; }
.annotator-footer {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px 12px;
    border-top: 1px solid #e7ebf2;
    background: #f8fafc;
}
.annotator-history-actions,
.annotator-primary-actions { display: flex; gap: 6px; }
.annotator-history-actions button,
.annotator-primary-actions button { min-height: 32px; padding: 0 10px; font-size: 11px; cursor: pointer; }
.annotator-primary-actions .annotator-save-action { border-color: #2563eb; background: #2563eb; color: #fff; font-weight: 700; }
button:disabled { opacity: .45; cursor: not-allowed !important; }
.annotator-restore {
    position: fixed;
    top: 16px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 38px;
    padding: 0 12px;
    pointer-events: auto;
    border: 1px solid #d8dee9;
    border-radius: 999px;
    background: #fff;
    color: #172033;
    font-size: 12px;
    font-weight: 700;
    box-shadow: 0 10px 30px rgba(15, 23, 42, .2);
    cursor: pointer;
}
.annotator-restore-dot { width: 8px; height: 8px; border-radius: 999px; background: #2563eb; }
.annotator-restore-badge { color: #b45309; font-size: 10px; font-weight: 600; }
.annotator-pick-bar {
    position: fixed;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    min-width: 360px;
    max-width: min(560px, calc(100vw - 32px));
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 11px 12px 11px 15px;
    pointer-events: auto;
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 14px;
    background: rgba(15, 23, 42, .94);
    color: #fff;
    box-shadow: 0 18px 48px rgba(15,23,42,.34);
    backdrop-filter: blur(16px);
}
.annotator-pick-bar div { display: grid; gap: 2px; }
.annotator-pick-bar strong { font-size: 12px; }
.annotator-pick-bar span { color: #cbd5e1; font-size: 10px; }
.annotator-pick-bar button { border: 1px solid #475569; border-radius: 8px; background: #1e293b; color: #fff; padding: 7px 10px; cursor: pointer; }
@media (max-width: 720px) {
    .annotator-workspace { top: 8px; right: 8px; bottom: 8px; width: min(340px, calc(100vw - 16px)); }
    .annotator-pick-bar { min-width: 0; width: calc(100vw - 32px); }
}
</style>
