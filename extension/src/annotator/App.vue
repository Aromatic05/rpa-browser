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
    enterAnnotation,
    failed,
    type AnnotatorState,
} from './state/annotator_state.js';
import {
    addAnnotation,
    deleteAnnotation,
    replaceAnnotationTarget,
    setAnnotationDisposition,
    updateAnnotation,
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
}>();

const emit = defineEmits<{
    (e: 'exit'): void;
    (e: 'check'): void;
    (e: 'save'): void;
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
    const nextDraft = updateAnnotation(props.state.canvasDraft, entityId, annotationId, patch);
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

const onEnterAnnotation = (): void => {
    applyState(enterAnnotation(props.state));
    emit('check');
};

onMounted(() => {
    refreshViewport();
    pickerDetach = attachPickerListeners(document, {
        isActive: () => pickMode.value,
        onHover: onHoverUpdate,
        onPick: (event) => {
            void onPickEvent(event);
        },
    });
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
    },
);
</script>

<template>
    <div class="annotator-root" data-rpa-snapshot-ignore="true" data-rpa-annotator-host="true">
        <div class="annotator-toolbar">
            <span class="annotator-mode">mode: {{ state.mode }}</span>
            <span class="annotator-flag" v-if="state.dirty">dirty</span>
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
                @click="onEnterAnnotation"
            >check</button>
            <button
                type="button"
                class="annotator-btn annotator-primary"
                :disabled="!state.dirty || !state.canvasDraft || pickMode"
                @click="emit('save')"
            >save</button>
            <button
                type="button"
                class="annotator-btn"
                :disabled="pickMode"
                @click="emit('exit')"
            >exit</button>
        </div>
        <div class="annotator-summary">
            <div class="annotator-line">profile: {{ state.profileName || '-' }}</div>
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
