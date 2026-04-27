import { getNodeAttr, normalizeText } from './runtime_store';
import type { FinalEntityRecord, SnapshotResult, UnifiedNode } from './types';

export type TablePaginationReason =
    | 'nextActionEnabled'
    | 'nextActionDisabled'
    | 'nextActionNotResolved'
    | 'nextActionNodeMissing';

export type TablePaginationState = {
    hasNextPage: boolean;
    nodeId?: string;
    reason: TablePaginationReason;
};

export const resolveTablePagination = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
): TablePaginationState => {
    const nodeId = entity.pagination?.nextAction?.nodeId;
    if (!nodeId) {
        return {
            hasNextPage: false,
            reason: 'nextActionNotResolved',
        };
    }

    const node = snapshot.nodeIndex[nodeId];
    if (!node) {
        return {
            hasNextPage: false,
            nodeId,
            reason: 'nextActionNodeMissing',
        };
    }

    if (isPaginationActionDisabled(snapshot, nodeId)) {
        return {
            hasNextPage: false,
            nodeId,
            reason: 'nextActionDisabled',
        };
    }

    return {
        hasNextPage: true,
        nodeId,
        reason: 'nextActionEnabled',
    };
};

export const isPaginationActionDisabled = (
    snapshot: SnapshotResult,
    nodeId: string,
): boolean => {
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {return false;}

    const disabledAttr = getNodeAttr(node, 'disabled');
    if (isTruthyDisabled(disabledAttr)) {return true;}

    const ariaDisabled = getNodeAttr(node, 'aria-disabled');
    if (normalizeLower(ariaDisabled) === 'true') {return true;}

    const classText = [getNodeAttr(node, 'class'), getNodeAttr(node, 'className')]
        .map(normalizeLower)
        .filter(Boolean)
        .join(' ');
    if (classText.includes('disabled')) {return true;}

    return false;
};

export const queryTableHasNextPage = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
): TablePaginationState => {
    return resolveTablePagination(snapshot, entity);
};

export const resolveTableNextPageTarget = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
): { ok: true; nodeId: string } | { ok: false; reason: TablePaginationReason } => {
    const state = resolveTablePagination(snapshot, entity);
    if (!state.nodeId) {
        return {
            ok: false,
            reason: state.reason,
        };
    }
    if (!state.hasNextPage) {
        return {
            ok: false,
            reason: state.reason,
        };
    }
    return {
        ok: true,
        nodeId: state.nodeId,
    };
};

const isTruthyDisabled = (value: string | undefined): boolean => {
    const normalized = normalizeLower(value);
    return normalized === 'true' || normalized === 'disabled';
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() || '';

export const getPaginationNode = (snapshot: SnapshotResult, nodeId: string | undefined): UnifiedNode | undefined => {
    if (!nodeId) {return undefined;}
    return snapshot.nodeIndex[nodeId];
};
