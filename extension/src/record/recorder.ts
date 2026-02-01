/**
 * recorder：管理录制状态与事件捕获。
 */

import type { RecordedStep } from '../shared/types.js';
import { installCapture } from './event_capture.js';
import { normalizeEvent } from './event_normalize.js';

export type RecorderOptions = {
    tabToken: string;
    onStep: (step: RecordedStep) => void;
};

let recording = false;
let disposeCapture: (() => void) | null = null;

export const startRecording = (opts: RecorderOptions) => {
    if (recording) return;
    recording = true;
    disposeCapture = installCapture({
        onEvent: (event) => {
            const step = normalizeEvent(event, { tabToken: opts.tabToken });
            if (step) opts.onStep(step);
        },
    });
};

export const stopRecording = () => {
    recording = false;
    if (disposeCapture) {
        disposeCapture();
        disposeCapture = null;
    }
};

export const isRecording = () => recording;
