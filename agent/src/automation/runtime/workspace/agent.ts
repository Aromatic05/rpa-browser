import type {RunnerConfig} from '../../../platform/config';
import type {RunStepsDeps} from '../../runner/run_steps';
import type {ControlPlaneResult} from '../control_plane';
import type {PortAllocator} from '../service/ports';
import type {WorkspaceService} from '../service/types';
import type {WorkspaceRouterInput} from './router';
import type {WorkspaceTabs} from './tabs';
import type {RecordingPlaybackView} from '../../recording/control';

export type WorkspaceAgentBinding = {
    service: WorkspaceService;
    acquirePlayback?: () => (() => void) | null;
    control: {
        handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
    };
};

export type WorkspaceAgentFactoryDeps = {
    workspaceName: string;
    tabs: WorkspaceTabs;
    runStepsDeps: RunStepsDeps;
    runnerConfig: RunnerConfig;
    portAllocator: PortAllocator;
    playbackView?: () => RecordingPlaybackView | undefined;
    runWorkspaceExecution: <T>(actionType: string, run: () => Promise<T>) => Promise<T>;
};

export type WorkspaceAgentFactory = (deps: WorkspaceAgentFactoryDeps) => WorkspaceAgentBinding;
