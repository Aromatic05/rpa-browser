/**
 * recorder：管理录制状态与事件捕获。
 *
 * 设计说明：
 * - extension 仅负责轻量捕获并回传
 * - 不在这里生成 Step（由 agent 侧完成）
 */

import { installCapture } from './event_capture.js';
import type { RawEvent } from './event_capture.js';

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
