/**
 * recorder：管理录制状态与事件捕获。
 */

import type { RawEvent } from './event_capture.js';
import { installCapture } from './event_capture.js';

export type RecorderOptions = {
    tabToken: string;
    onEvent: (event: RawEvent) => void;
};

let recording = false;
let disposeCapture: (() => void) | null = null;

export const startRecording = (opts: RecorderOptions) => {
    if (recording) return;
    recording = true;
    disposeCapture = installCapture({
        onEvent: (event) => {
            opts.onEvent(event);
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
