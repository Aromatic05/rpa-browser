import type {RunStepsDeps} from '../../automation/runner/run_steps';
import {ensureFreshPageSession} from '../../automation/runner/session';
import type {WorldViewSource} from './contracts';

export const createWorkspaceWorldViewSource = (input: {
    workspaceName: string;
    deps: RunStepsDeps;
}): WorldViewSource => ({
    pin: async (options = {}) => {
        const {entry, binding} = await ensureFreshPageSession(
            input.deps,
            input.workspaceName,
            options.tabName ? {tabName: options.tabName} : {},
        );
        return Object.freeze({
            workspaceName: input.workspaceName,
            tabName: binding.tabName,
            pageUrl: entry.pageUrl,
            revision: Object.freeze({
                pageEpoch: entry.identity.pageEpoch,
                captureRevision: entry.identity.captureRevision,
            }),
            entry,
        });
    },
});
