import type { A11yHint } from '../runner/steps/types';

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

export type RecordedReplayHints = {
    preferDirect?: boolean;
    preferScopedSearch?: boolean;
    requireVisible?: boolean;
    allowIndexDrift?: boolean;
    allowFuzzy?: boolean;
};

export type RecordedStepEnhancement = {
    version: 1;
    eventType?: string;
    snapshot?: {
        mode?: 'full' | 'diff';
        snapshotId?: string;
        pageIdentity?: {
            workspaceId: string;
            tabId: string;
            tabToken: string;
            url: string;
        };
        capturedAt: number;
    };
    target?: RecordedTargetFingerprint;
    entityBindings?: RecordedEntityBinding[];
    locator?: {
        direct?: { kind: string; query: string; source: string; fallback?: string };
        scope?: { id: string; kind: string };
        origin?: { primaryDomId: string; sourceDomIds?: string[] };
    };
    replayHints?: RecordedReplayHints;
    rawContext?: {
        selector?: string;
        a11yHint?: A11yHint;
        locatorCandidates?: Array<{
            kind: string;
            selector?: string;
            testId?: string;
            role?: string;
            name?: string;
            text?: string;
            exact?: boolean;
            note?: string;
        }>;
        scopeHint?: string;
        targetHint?: string;
        pageUrl?: string;
        recorderVersion?: string;
    };
};

export type RecordingEnhancementMap = Record<string, RecordedStepEnhancement>;
