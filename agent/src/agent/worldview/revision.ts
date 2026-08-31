import type {WorldViewDescriptor} from './contracts';

export const isSameWorldView = (
    left: WorldViewDescriptor,
    right: WorldViewDescriptor,
): boolean =>
    left.workspaceName === right.workspaceName
    && left.tabName === right.tabName
    && left.pageUrl === right.pageUrl
    && left.revision.pageEpoch === right.revision.pageEpoch
    && left.revision.captureRevision === right.revision.captureRevision;
