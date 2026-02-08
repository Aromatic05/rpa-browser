import { createEmitter } from './emitter';
import { installHandlers } from './handlers';

const global = window as any;
if (!global.__rpa_recorder_installed) {
    global.__rpa_recorder_installed = true;
    try {
        console.warn('[recorder] installed', location.href);
    } catch {}
    const bindingName = global.__rpa_recorder_binding || '__rpa_record';
    const recorderVersion = 'payload-v2';
    const { emit, debugTarget } = createEmitter(bindingName, recorderVersion);
    installHandlers(emit, debugTarget);
}
