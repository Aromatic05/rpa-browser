import { createEmitter } from './emitter';
import { installHandlers } from './handlers';

type RecorderWindow = Window & {
    __rpa_recorder_installed?: boolean;
    __rpa_recorder_binding?: string;
    __rpa_recorder_enabled?: boolean;
};

const runtimeWindow = window as RecorderWindow;
if (runtimeWindow.__rpa_recorder_enabled === undefined) {
    runtimeWindow.__rpa_recorder_enabled = true;
}
if (!runtimeWindow.__rpa_recorder_installed) {
    runtimeWindow.__rpa_recorder_installed = true;
    try {
        console.warn('[recorder] installed', location.href);
    } catch {
        // ignore debug logging failures
    }
    const bindingName = runtimeWindow.__rpa_recorder_binding || '__rpa_record';
    const recorderVersion = 'payload-v2';
    const { emit, debugTarget } = createEmitter(bindingName, recorderVersion);
    installHandlers(emit, debugTarget);
}
