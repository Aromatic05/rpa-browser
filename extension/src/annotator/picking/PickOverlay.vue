<script setup lang="ts">
import {computed} from 'vue';
import type {PickCandidate} from '../types.js';
import {recommendAnnotationTypes, type RecommendedType} from '../recommend/recommend_types.js';
import type {EntityKind} from '../types.js';

const props = defineProps<{
    candidate: PickCandidate | null;
    candidateIndex: number;
    candidateChainLength: number;
    currentEntityKind: EntityKind | undefined;
    pointer: {x: number; y: number} | null;
}>();

const emit = defineEmits<{
    (e: 'navigate', direction: 'outer' | 'inner'): void;
    (e: 'confirm'): void;
    (e: 'cancel'): void;
}>();

const recommendations = computed((): RecommendedType[] => {
    if (!props.candidate) {return [];}
    return recommendAnnotationTypes(props.candidate, props.currentEntityKind);
});

const cardStyle = computed((): Record<string, string> => {
    if (!props.pointer) {return {display: 'none'};}
    const x = Math.min(props.pointer.x + 12, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 260);
    const y = Math.min(props.pointer.y + 12, (typeof window !== 'undefined' ? window.innerHeight : 768) - 200);
    return {
        left: `${Math.max(8, x)}px`,
        top: `${Math.max(8, y)}px`,
    };
});

const canOuter = computed(() => props.candidateIndex < props.candidateChainLength - 1);
const canInner = computed(() => props.candidateIndex > 0);
</script>

<template>
    <div
        v-if="candidate && pointer"
        class="annotator-pick-overlay"
        :style="cardStyle"
        data-rpa-snapshot-ignore="true"
        data-rpa-annotator-host="true"
    >
        <div class="annotator-pick-header">
            <span class="annotator-pick-level">{{ candidate.level }}</span>
            <span class="annotator-pick-role" v-if="candidate.role">{{ candidate.role }}</span>
            <span class="annotator-pick-stability" v-if="candidate.stabilityHint">{{ candidate.stabilityHint }}</span>
        </div>
        <div class="annotator-pick-text" v-if="candidate.text">{{ candidate.text }}</div>
        <div class="annotator-pick-meta">
            <span v-if="candidate.matchCount !== undefined">匹配 {{ candidate.matchCount }}</span>
            <span v-if="candidate.expect">期望 {{ candidate.expect }}</span>
        </div>
        <div class="annotator-pick-recommend" v-if="recommendations.length > 0">
            <button
                v-for="rec in recommendations"
                :key="rec"
                type="button"
                class="annotator-pick-rec"
                @click.stop="emit('confirm')"
            >{{ rec }}</button>
        </div>
        <div class="annotator-pick-actions">
            <button
                type="button"
                class="annotator-pick-btn"
                :disabled="!canOuter"
                @click.stop="emit('navigate', 'outer')"
            >选择外层</button>
            <button
                type="button"
                class="annotator-pick-btn"
                :disabled="!canInner"
                @click.stop="emit('navigate', 'inner')"
            >选择内部</button>
            <button
                type="button"
                class="annotator-pick-btn annotator-pick-confirm"
                @click.stop="emit('confirm')"
            >确认</button>
            <button
                type="button"
                class="annotator-pick-btn annotator-pick-cancel"
                @click.stop="emit('cancel')"
            >取消</button>
        </div>
    </div>
</template>

<style scoped>
.annotator-pick-overlay {
    position: fixed;
    width: 240px;
    padding: 10px;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.24);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: #0f172a;
    pointer-events: auto;
    z-index: 3;
}
.annotator-pick-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
}
.annotator-pick-level {
    background: #1d4ed8;
    color: #fff;
    border-radius: 6px;
    padding: 2px 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
}
.annotator-pick-role {
    font-size: 11px;
    color: #475569;
}
.annotator-pick-stability {
    font-size: 10px;
    color: #b91c1c;
    background: #fee2e2;
    padding: 1px 5px;
    border-radius: 4px;
}
.annotator-pick-text {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 4px;
    word-break: break-word;
}
.annotator-pick-meta {
    font-size: 11px;
    color: #475569;
    margin-bottom: 6px;
    display: flex;
    gap: 8px;
}
.annotator-pick-recommend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
}
.annotator-pick-rec {
    border: 1px solid #94a3b8;
    background: #f1f5f9;
    color: #0f172a;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
}
.annotator-pick-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
}
.annotator-pick-btn {
    border: 1px solid #cbd5e1;
    background: #fff;
    color: #0f172a;
    border-radius: 6px;
    padding: 4px 6px;
    font-size: 11px;
    cursor: pointer;
}
.annotator-pick-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
.annotator-pick-confirm {
    background: #2563eb;
    border-color: #2563eb;
    color: #fff;
}
.annotator-pick-cancel {
    background: #111827;
    border-color: #111827;
    color: #f9fafb;
}
</style>
