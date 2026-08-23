import type {WorldView, WorldViewDescriptor} from './contracts';

export const describeWorldView = (view: WorldView): WorldViewDescriptor => Object.freeze({
    workspaceName: view.workspaceName,
    tabName: view.tabName,
    pageUrl: view.pageUrl,
    revision: view.revision,
});
