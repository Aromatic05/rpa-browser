import type {PageSnapshotSessionEntry} from '../../snapshot';

export type WorldRevision = Readonly<{
    pageEpoch: string;
    captureRevision: number;
}>;

export type WorldView = Readonly<{
    workspaceName: string;
    tabName: string;
    pageUrl: string;
    revision: WorldRevision;
    entry: PageSnapshotSessionEntry;
}>;

export type WorldViewDescriptor = Readonly<{
    workspaceName: string;
    tabName: string;
    pageUrl: string;
    revision: WorldRevision;
}>;

export type WorldViewSource = {
    pin: (input?: {tabName?: string}) => Promise<WorldView>;
};
