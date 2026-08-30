import type {AssetCapabilities, LibraryAssetKind} from './contracts';

const EMPTY: AssetCapabilities = Object.freeze({
    runtimeApplied: false,
    callableFromDsl: false,
    agentDiscovery: false,
    runnerRecovery: false,
    agentRecovery: false,
    replayable: false,
    modelLoadSeam: false,
});

export const capabilitiesFor = (kind: LibraryAssetKind): AssetCapabilities => {
    if (kind === 'automation') {
        return Object.freeze({...EMPTY, agentDiscovery: true});
    }
    if (kind === 'procedure') {
        return Object.freeze({...EMPTY, callableFromDsl: true});
    }
    if (kind === 'recovery') {
        return Object.freeze({...EMPTY, runnerRecovery: true});
    }
    if (kind === 'demonstration') {
        return Object.freeze({...EMPTY, replayable: true});
    }
    return Object.freeze({...EMPTY, runtimeApplied: true});
};