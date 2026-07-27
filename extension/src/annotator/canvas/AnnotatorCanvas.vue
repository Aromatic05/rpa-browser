<script setup lang="ts">
import {computed} from 'vue';
import type {AnnotationBox, AnnotationBoxKind} from '../layout/annotation_boxes.js';
import type {LabelPlacement} from '../layout/label_layout.js';
import type {CheckResultByAnnotation, CheckStatus} from '../types.js';
import type {Rect} from '../layout/box_geometry.js';
import {annotationVisualState} from '../state/product_ui.js';

type ScreenBox = {
    annotationId: string;
    kind: AnnotationBoxKind;
    rect: Rect;
    origin: 'inferred' | 'confirmed' | 'manual';
    disposition: 'active' | 'ignored';
    status?: CheckStatus;
    visualStatus: 'inferred' | 'confirmed' | 'error' | 'ignored';
    color: string;
    dashed: boolean;
    matchCount: number;
    isFirstOfGroup: boolean;
};

const props = defineProps<{
    boxes: AnnotationBox[];
    placements: Record<string, LabelPlacement>;
    selectedAnnotationId: string | null;
    checkResults: CheckResultByAnnotation[] | null;
    hoverBox: Rect | null;
    viewportWidth: number;
    viewportHeight: number;
    pickMode: boolean;
    dimOutsideEntity: boolean;
    showEntity: boolean;
    showObjects: boolean;
    showObjectBoxes?: boolean;
}>();

const emit = defineEmits<{
    (e: 'select', annotationId: string): void;
}>();

const STATUS_GLYPH: Record<CheckStatus, string> = {
    unique: '\u2713',
    multiple: '\u26a0',
    missing: '\u2717',
    invalid: '\u2717',
};

const STATUS_COLOR: Record<CheckStatus, string> = {
    unique: '#16a34a',
    multiple: '#d97706',
    missing: '#dc2626',
    invalid: '#dc2626',
};

const checkLookup = computed((): Record<string, CheckResultByAnnotation> => {
    const map: Record<string, CheckResultByAnnotation> = {};
    if (props.checkResults) {
        for (const result of props.checkResults) {
            map[result.canvasAnnotationId] = result;
        }
    }
    return map;
});

const screenBoxes = computed((): ScreenBox[] => {
    const out: ScreenBox[] = [];
    for (const annotationBox of props.boxes) {
        if (annotationBox.kind === 'entity' && !props.showEntity) {continue;}
        if (annotationBox.kind !== 'entity' && (!props.showObjects || props.showObjectBoxes === false)) {continue;}
        const check = checkLookup.value[annotationBox.annotationId];
        const visual = annotationVisualState(annotationBox, check ?? null);
        annotationBox.boxes.forEach((box, index) => {
            out.push({
                annotationId: annotationBox.annotationId,
                kind: annotationBox.kind,
                rect: {x: box.x, y: box.y, width: box.width, height: box.height},
                origin: annotationBox.origin,
                disposition: annotationBox.disposition,
                status: check?.status,
                visualStatus: visual.status,
                color: visual.color,
                dashed: visual.dashed,
                matchCount: annotationBox.matchCount,
                isFirstOfGroup: index === 0,
            });
        });
    }
    return out;
});

const boxLookup = computed(() => new Map(props.boxes.map((box) => [box.annotationId, box])));

const polylines = computed((): Array<{
    annotationId: string;
    points: string;
    placement: LabelPlacement;
    color: string;
    dashed: boolean;
    visualStatus: 'inferred' | 'confirmed' | 'error' | 'ignored';
}> => {
    const out: Array<{
        annotationId: string;
        points: string;
        placement: LabelPlacement;
        color: string;
        dashed: boolean;
        visualStatus: 'inferred' | 'confirmed' | 'error' | 'ignored';
    }> = [];
    if (!props.showObjects) {return out;}
    for (const [annotationId, placement] of Object.entries(props.placements)) {
        const annotationBox = boxLookup.value.get(annotationId);
        if (!annotationBox || annotationBox.kind === 'entity' || annotationBox.kind === 'column') {continue;}
        const visual = annotationVisualState(annotationBox, checkLookup.value[annotationId] ?? null);
        const points = placement.polyline
            .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
            .join(' ');
        out.push({
            annotationId,
            points,
            placement,
            color: visual.color,
            dashed: visual.dashed,
            visualStatus: visual.status,
        });
    }
    return out;
});

const entityMaskTargets = computed((): ScreenBox[] =>
    screenBoxes.value.filter((box) => box.kind === 'entity'),
);

const maskId = 'rpa-annotator-entity-mask';

const onSelect = (annotationId: string): void => {
    emit('select', annotationId);
};
</script>

<template>
    <svg
        class="annotator-canvas"
        data-rpa-snapshot-ignore="true"
        :style="{width: viewportWidth + 'px', height: viewportHeight + 'px', pointerEvents: pickMode ? 'none' : undefined}"
        :viewBox="`0 0 ${viewportWidth} ${viewportHeight}`"
        aria-hidden="true"
    >
        <defs>
            <marker
                id="rpa-annotator-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
                markerUnits="strokeWidth"
            >
                <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
            </marker>
            <mask :id="maskId">
                <rect
                    :x="0"
                    :y="0"
                    :width="viewportWidth"
                    :height="viewportHeight"
                    fill="white"
                />
                <rect
                    v-for="box in entityMaskTargets"
                    :key="`mask-${box.annotationId}-${box.rect.x}-${box.rect.y}`"
                    :x="box.rect.x + 2"
                    :y="box.rect.y + 2"
                    :width="Math.max(0, box.rect.width - 4)"
                    :height="Math.max(0, box.rect.height - 4)"
                    rx="6"
                    fill="black"
                />
            </mask>
        </defs>
        <rect
            v-if="dimOutsideEntity && entityMaskTargets.length > 0"
            :x="0"
            :y="0"
            :width="viewportWidth"
            :height="viewportHeight"
            fill="rgba(15, 23, 42, 0.46)"
            :mask="`url(#${maskId})`"
            class="annotator-dim"
        />
        <g class="annotator-polylines" v-if="showObjects">
            <polyline
                v-for="entry in polylines"
                :key="`line-${entry.annotationId}`"
                :data-annotation-id="entry.annotationId"
                :points="entry.points"
                :stroke="entry.annotationId === selectedAnnotationId ? '#0f172a' : entry.color"
                :stroke-width="entry.annotationId === selectedAnnotationId ? 2.5 : 1.5"
                :stroke-dasharray="entry.dashed ? '6 4' : ''"
                marker-end="url(#rpa-annotator-arrow)"
                fill="none"
                class="annotator-line"
                :class="[
                    `state-${entry.visualStatus}`,
                    {'annotator-line-selected': entry.annotationId === selectedAnnotationId},
                ]"
                @click.stop="onSelect(entry.annotationId)"
            />
        </g>
        <g class="annotator-boxes" v-if="showEntity || showObjects">
            <g
                v-for="box in screenBoxes"
                :key="`box-${box.annotationId}-${box.rect.x}-${box.rect.y}`"
                :data-annotation-id="box.annotationId"
                :class="[
                    'annotator-box',
                    `kind-${box.kind}`,
                    `state-${box.visualStatus}`,
                    {selected: box.annotationId === selectedAnnotationId},
                ]"
                @click.stop="box.kind !== 'entity' && onSelect(box.annotationId)"
            >
                <rect
                    :x="box.rect.x"
                    :y="box.rect.y"
                    :width="box.rect.width"
                    :height="box.rect.height"
                    :stroke="box.annotationId === selectedAnnotationId ? '#0f172a' : box.color"
                    :stroke-width="box.kind === 'entity' ? 3 : (box.annotationId === selectedAnnotationId ? 3 : 1.75)"
                    :stroke-dasharray="box.dashed ? '7 5' : ''"
                    :fill="box.kind === 'entity' && box.isFirstOfGroup ? 'rgba(37, 99, 235, 0.08)' : 'transparent'"
                    :rx="box.kind === 'entity' ? 8 : 4"
                    :class="{ignored: box.disposition === 'ignored'}"
                />
                <text
                    v-if="box.isFirstOfGroup && box.status"
                    :x="box.rect.x + box.rect.width - 8"
                    :y="box.rect.y + 14"
                    :fill="STATUS_COLOR[box.status]"
                    font-size="14"
                    font-weight="700"
                    text-anchor="end"
                    class="annotator-status-glyph"
                >{{ STATUS_GLYPH[box.status] }}</text>
                <text
                    v-if="box.isFirstOfGroup && box.matchCount > 1"
                    :x="box.rect.x + 4"
                    :y="box.rect.y + 14"
                    fill="#0f172a"
                    font-size="12"
                    font-weight="600"
                    class="annotator-count"
                >x{{ box.matchCount }}</text>
            </g>
        </g>
        <g v-if="hoverBox" class="annotator-hover">
            <rect
                :x="hoverBox.x"
                :y="hoverBox.y"
                :width="hoverBox.width"
                :height="hoverBox.height"
                stroke="#0ea5e9"
                stroke-width="2"
                fill="rgba(14, 165, 233, 0.10)"
                stroke-dasharray="3 3"
                rx="3"
            />
        </g>
    </svg>
</template>

<style scoped>
.annotator-canvas {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 1;
}
.annotator-canvas :deep(.annotator-box),
.annotator-canvas :deep(.annotator-line) {
    pointer-events: auto;
    cursor: pointer;
}
.annotator-canvas :deep(.annotator-box.kind-entity) {
    pointer-events: none;
    cursor: default;
}
.annotator-canvas :deep(.annotator-box.ignored rect) {
    opacity: 0.4;
}
.annotator-canvas :deep(.state-inferred) {
    opacity: 0.72;
}
.annotator-canvas :deep(.state-error) {
    opacity: 1;
}
.annotator-canvas :deep(.annotator-line) {
    vector-effect: non-scaling-stroke;
}
.annotator-dim {
    pointer-events: none;
}
</style>
