import type {ObservationNodeId, PageObservation} from '../observation/model/contracts';
import type {PageSnapshotSessionEntry} from '../session/contracts';

const CONTENT_REF_PREFIX = 'v2-content';

export type SnapshotContentResolution =
    | {ok: true; nodeId: ObservationNodeId; content: string}
    | {ok: false; code: 'ERR_BAD_ARGS' | 'ERR_STALE' | 'ERR_NOT_FOUND'; message: string};

export const buildSnapshotContentRef = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
): string | undefined => readSnapshotNodeContent(entry.capture.control.observation, nodeId)
    ? `${CONTENT_REF_PREFIX}:${encodeURIComponent(entry.identity.pageEpoch)}:${encodeURIComponent(nodeId)}`
    : undefined;

export const resolveSnapshotContentRef = (
    entry: PageSnapshotSessionEntry,
    ref: string,
): SnapshotContentResolution => {
    const parsed = parseSnapshotContentRef(ref);
    if (!parsed) {
        return {ok: false, code: 'ERR_BAD_ARGS', message: 'invalid V2 snapshot content ref'};
    }
    if (parsed.pageEpoch !== entry.identity.pageEpoch) {
        return {ok: false, code: 'ERR_STALE', message: 'snapshot content ref belongs to a different page epoch'};
    }
    const nodes = new Map(Object.entries(entry.capture.control.observation.nodes));
    if (!nodes.has(parsed.nodeId)) {
        return {ok: false, code: 'ERR_NOT_FOUND', message: 'snapshot content node no longer exists'};
    }
    const content = readSnapshotNodeContent(entry.capture.control.observation, parsed.nodeId);
    if (!content) {
        return {ok: false, code: 'ERR_NOT_FOUND', message: 'snapshot content is empty'};
    }
    return {ok: true, nodeId: parsed.nodeId, content};
};

export const readSnapshotNodeContent = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): string | undefined => {
    const values: string[] = [];
    const seen = new Set<string>();
    const nodes = new Map(Object.entries(observation.nodes));
    const visit = (current: ObservationNodeId) => {
        if (!nodes.has(current)) {return;}
        const a11y = observation.accessibility[current];
        const runtime = observation.runtimeState[current];
        for (const value of [
            observation.text[current],
            a11y?.name,
            a11y?.description,
            a11y?.value,
            runtime?.value,
            runtime?.popupSelectedText,
            runtime?.ariaValueText,
            runtime?.contentEditableText,
        ]) {
            const normalized = value?.replace(/\s+/g, ' ').trim();
            if (!normalized || seen.has(normalized)) {continue;}
            seen.add(normalized);
            values.push(normalized);
        }
        for (const childId of observation.children[current] ?? []) {visit(childId);}
    };
    visit(nodeId);
    return values.length > 0 ? values.join('\n') : undefined;
};

const parseSnapshotContentRef = (
    ref: string,
): {pageEpoch: string; nodeId: ObservationNodeId} | undefined => {
    const match = /^v2-content:([^:]+):([^:]+)$/u.exec(ref.trim());
    if (!match) {return undefined;}
    try {
        const pageEpoch = decodeURIComponent(match[1]);
        const nodeId = decodeURIComponent(match[2]);
        return pageEpoch && nodeId ? {pageEpoch, nodeId} : undefined;
    } catch {
        return undefined;
    }
};
