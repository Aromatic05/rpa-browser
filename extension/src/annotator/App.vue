<script setup lang="ts">
import type { AnnotatorState } from './state/annotator_state.js';

defineProps<{
    state: AnnotatorState;
}>();

defineEmits<{
    (e: 'exit'): void;
    (e: 'undo'): void;
    (e: 'redo'): void;
    (e: 'check'): void;
    (e: 'save'): void;
}>();
</script>

<template>
    <div class="annotator-root" data-rpa-snapshot-ignore="true">
        <div class="annotator-toolbar">
            <span class="annotator-mode">mode: {{ state.mode }}</span>
            <span class="annotator-flag" v-if="state.dirty">dirty</span>
            <span class="annotator-flag" v-if="state.stale">stale</span>
            <span class="annotator-flag" v-if="state.error">{{ state.error }}</span>
            <div class="annotator-spacer"></div>
            <button class="annotator-btn" :disabled="state.history.past.length === 0" @click="$emit('undo')">undo</button>
            <button class="annotator-btn" :disabled="state.history.future.length === 0" @click="$emit('redo')">redo</button>
            <button class="annotator-btn" :disabled="!state.canvasDraft" @click="$emit('check')">check</button>
            <button class="annotator-btn annotator-primary" :disabled="!state.dirty || !state.canvasDraft" @click="$emit('save')">save</button>
            <button class="annotator-btn annotator-exit" @click="$emit('exit')">exit</button>
        </div>
        <div class="annotator-summary">
            <div class="annotator-line">profile: {{ state.profileName || '-' }}</div>
            <div class="annotator-line">revision: {{ state.artifactRevision ? state.artifactRevision.slice(0, 8) : '-' }}</div>
            <div class="annotator-line">entities: {{ state.canvasDraft ? state.canvasDraft.entities.length : 0 }}</div>
        </div>
    </div>
</template>
