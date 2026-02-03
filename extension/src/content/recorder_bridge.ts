/**
 * recorder_bridge：桥接录制模块与消息协议。
 *
 * 设计说明：
 * - 只处理 RECORD_START/RECORD_STOP。
 * - 录制步骤上报统一走 send.recordStep。
 */

import { MSG } from '../shared/protocol.js';
import { send } from '../shared/send.js';

type RecorderModule = {
    startRecording: (opts: { tabToken: string; onStep: (step: any) => void }) => void;
    stopRecording: () => void;
};

const loadRecorder = (() => {
    let cached: Promise<RecorderModule> | null = null;
    return () => {
        if (!cached) {
            const url = chrome.runtime.getURL('record/recorder.js');
            cached = import(url) as Promise<RecorderModule>;
        }
        return cached;
    };
})();

export const createRecorderBridge = (tabToken: string) => {
    const handle = async (message: any, sendResponse: (response?: any) => void) => {
        if (message?.type === MSG.RECORD_START) {
            const recorder = await loadRecorder();
            recorder.startRecording({
                tabToken,
                onStep: async (step: any) => {
                    await send.recordStep(tabToken, step);
                },
            });
            sendResponse({ ok: true });
            return true;
        }
        if (message?.type === MSG.RECORD_STOP) {
            const recorder = await loadRecorder();
            recorder.stopRecording();
            sendResponse({ ok: true });
            return true;
        }
        return false;
    };

    return { handle };
};
