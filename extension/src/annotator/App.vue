<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref, watch} from 'vue';
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
    deleteAnnotation,
    replaceAnnotationTarget,
    setAnnotationDisposition,
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
    PickRect,
} from './types.js';

const props = defineProps<{
    state: AnnotatorState;
    client: AnnotatorClient | null;
    sessionStore?: SessionStore | null;
}>();

const emit = defineEmits<{
    (e: 'exit'): void;
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
    if (!props.client || !page || props.state.mode !== 'editing' || props.state.dirty) {return;}
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
        {width: viewport.value.width, height: viewport.value.height},
        {},
    ),
);

const entities = computed<CanvasEntityDraft[]>(() =>
    props.state.canvasDraft ? props.state.canvasDraft.entities : [],
);

const currentEntity = computed<CanvasEntityDraft | null>(() => {
    if (!props.state.currentEntityId) {return null;}
    return entities.value.find((entity) => entity.id === props.state.currentEntityId) ?? null;
});

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
    for (const entity of entities.value) {
        if (entity.annotations.some((a) => a.id === props.state.currentAnnotationId)) {
            return entity.id;
        }
    }
    return null;
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
    if (!props.state.canvasDraft || pickMode.value) {
        return;
    }
    applyState({...props.state, mode: 'checking', error: null});
    const next = await runCheckLoop(props.state, props.client);
    applyState(next);
};

const runSave = async (): Promise<void> => {
    if (!props.state.canvasDraft || !props.state.dirty || pickMode.value) {
        return;
    }
    applyState({...props.state, mode: 'saving', error: null});
    const next = await runSaveLoop(props.state, props.client, props.sessionStore);
    applyState(next);
};

const runRecognize = async (): Promise<void> => {
    if (pickMode.value) {
        return;
    }
    applyState({...props.state, error: null});
    const next = await runRecognizeLoop(props.state, props.client);
    applyState(next);
};

const entityIdForAnnotation = (annotationId: string): string | null => {
    for (const entity of entities.value) {
        if (entity.annotations.some((a) => a.id === annotationId)) {
            return entity.id;
        }
    }
    if (annotationId.startsWith('entity:')) {
        return annotationId.slice('entity:'.length);
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
    pickTargetAnnotationId.value = annotationId;
    pickTargetEntityId.value = ensurePickTargetEntity();
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
};

const onHoverUpdate = (rect: PickRect | null, p: {x: number; y: number}): void => {
    hoverBox.value = rect;
    pointer.value = p;
};

const onPickEvent = async (event: {fingerprint: PickFingerprint; pointer: {x: number; y: number}}): Promise<void> => {
    if (!props.client) {
        applyState(failed(props.state, 'picker unavailable: no dispatch client'));
        return;
    }
    pickPointer.value = event.pointer;
    let result: AnnotatorPickResult;
    try {
        result = await props.client.pick({fingerprint: event.fingerprint});
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applyState(failed(props.state, `pick failed: ${message}`));
        return;
    }
    pickCandidates.value = result.candidateChain;
    pickCandidateIndex.value = result.candidateChain.length > 0 ? 0 : -1;
};

const onPickConfirm = (): void => {
    const candidate = selectedCandidate.value;
    if (!candidate) {return;}
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
        nextDraft = replaceAnnotationTarget(
            props.state.canvasDraft,
            entityId,
            pickTargetAnnotationId.value,
            plan.annotation.target,
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
            const nextDraft = replaceAnnotationTarget(
                props.state.canvasDraft,
                entityId,
                pickTargetAnnotationId.value,
                plan.annotation.target,
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
    if (annotationId === `entity:${entityId}`) {
        nextDraft = updateEntity(props.state.canvasDraft, entityId, {name: patch.name, businessTag: patch.businessKey});
    } else if (entity.columns.some((column) => column.id === annotationId)) {
        nextDraft = updateColumn(props.state.canvasDraft, entityId, annotationId, {name: patch.name, fieldKey: patch.businessKey});
    } else if (entity.columns.some((column) => column.actions.some((action) => action.id === annotationId))) {
        nextDraft = updateColumnAction(props.state.canvasDraft, entityId, annotationId, {text: patch.name, actionIntent: patch.businessKey});
    } else if (annotationId === `pagination:${entityId}`) {
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
    const nextDraft = deleteAnnotation(props.state.canvasDraft, entityId, annotationId);
    applyState(draftEdited(props.state, nextDraft));
    applyState(pickReceived(props.state, {annotationId: null, entityId}));
};

const onIgnoreAnnotation = (annotationId: string): void => {
    if (!props.state.canvasDraft) {return;}
    const entityId = entityIdForAnnotation(annotationId);
    if (!entityId) {return;}
    const nextDraft = setAnnotationDisposition(
        props.state.canvasDraft,
        entityId,
        annotationId,
        'ignored',
    );
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
    <div class="annotator-root" data-rpa-snapshot-ignore="true" data-rpa-annotator-host="true">
        <div class="annotator-toolbar">
            <span class="annotator-mode">mode: {{ state.mode }}</span>
            <span class="annotator-flag" v-if="state.dirty">dirty</span>
            <span class="annotator-flag annotator-flag-saved" v-if="!state.dirty && state.artifactRevision">已保存</span>
            <span class="annotator-flag" v-if="state.stale">stale</span>
            <span class="annotator-flag annotator-flag-error" v-if="state.error">{{ state.error }}</span>
            <span class="annotator-flag annotator-flag-pick" v-if="pickMode">pick</span>
            <div class="annotator-spacer"></div>
            <button
                type="button"
                class="annotator-btn"
                :disabled="!currentEntity || pickMode"
                @click="enterPickMode(null)"
            >新增标注</button>
            <button
                type="button"
                class="annotator-btn"
                :disabled="pickMode"
                @click="runRecognize"
            >重新识别</button>
            <button
                type="button"
                class="annotator-btn"
                :disabled="state.history.past.length === 0"
                @click="applyUndo"
            >undo</button>
            <button
                type="button"
                class="annotator-btn"
                :disabled="state.history.future.length === 0"
                @click="applyRedo"
            >redo</button>
            <button
                type="button"
                class="annotator-btn"
                :disabled="!state.canvasDraft || pickMode"
                @click="runCheck"
            >check</button>
            <button
                type="button"
                class="annotator-btn annotator-primary"
                :disabled="!state.dirty || !state.canvasDraft || pickMode"
                @click="runSave"
            >save</button>
            <button
                type="button"
                class="annotator-btn"
                :disabled="pickMode"
                @click="emit('exit')"
            >exit</button>
        </div>
        <div class="annotator-summary">
            <label class="annotator-line">
                规则名称
                <input v-model="profileNameModel" class="annotator-profile-input" type="text" placeholder="先识别页面以生成名称" />
            </label>
            <div class="annotator-line">
                revision: {{ state.artifactRevision ? state.artifactRevision.slice(0, 8) : '-' }}
            </div>
            <div class="annotator-line">entities: {{ state.canvasDraft ? state.canvasDraft.entities.length : 0 }}</div>
            <div class="annotator-line" v-if="currentEntity">current: {{ currentEntity.name }}</div>
            <div class="annotator-line annotator-hint" v-if="pickMode">
                点击页面元素以构建指纹；选择外层/内部调整候选；确认写入草稿。
            </div>
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
        @select="onSelectAnnotation"
        @update-annotation="onUpdateAnnotation"
        @reselect="(annotationId) => enterPickMode(annotationId)"
        @navigate="onNavigate"
        @delete="onDeleteAnnotation"
        @ignore="onIgnoreAnnotation"
        @choose-type="onChooseType"
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
.annotator-root {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1;
    background: #ffffff;
    border-bottom: 1px solid #e2e8f0;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12);
    pointer-events: auto;
}
</style>
