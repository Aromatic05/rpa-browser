import type { ResolveHint, ResolvePolicy } from '../runner/steps/types';

export type RecordedTargetFingerprint = {
    nodeId: string;
    primaryDomId?: string;
    sourceDomIds?: string[];
    role?: string;
    tag?: string;
    name?: string;
    content?: string;
    attrs?: Record<string, string>;
    bbox?: { x: number; y: number; width: number; height: number };
    runtimeState?: Record<string, string>;
    semanticHints?: {
        entityNodeId?: string;
        entityKind?: string;
        fieldLabel?: string;
        actionIntent?: string;
        actionTargetNodeId?: string;
    };
};

export type RecordedEntityBinding = {
    entityId: string;
    type: 'region' | 'group';
    role: 'container' | 'item' | 'descendant';
    kind?: string;
    itemId?: string;
    slotIndex?: number;
};

export type RecordedReplayHints = ResolvePolicy;

export type RecordedStepEnhancement = {
    version: 1;
    eventType?: string;
    snapshot?: {
        mode?: 'full' | 'diff';
        snapshotId?: string;
        pageIdentity?: {
            workspaceName: string;
            tabName: string;
            url: string;
        };
        capturedAt: number;
    };
    target?: RecordedTargetFingerprint;
    entityBindings?: RecordedEntityBinding[];
    resolveHint?: ResolveHint;
    resolvePolicy?: ResolvePolicy;
    rawContext?: {
        pageUrl?: string;
        recorderVersion?: string;
    };
};

export type RecordingEnhancementMap = Record<string, RecordedStepEnhancement>;
