/**
 * commands：定义 agent WS 协议中“仍然保留”的命令类型。
 *
 * 说明：
 * - 旧的 page/element 级命令已移除，统一改走 steps.run。
 * - actions 目录仅保留 workspace/recording 相关命令的处理。
 */

/**
 * CommandScope：显式指定 workspace/tab；缺省时走 active scope。
 */
export type CommandScope = {
    workspaceId?: string;
    tabId?: string;
};

export type BaseCommand = {
    cmd: string;
    tabToken: string;
    scope?: CommandScope;
    args?: Record<string, unknown>;
    requestId?: string;
};

type CommandWithArgs<C extends string, A> = {
    cmd: C;
    tabToken: string;
    scope?: CommandScope;
    args: A;
    requestId?: string;
};

export type RecordStartCommand = CommandWithArgs<'record.start', Record<string, never>>;
export type RecordStopCommand = CommandWithArgs<'record.stop', Record<string, never>>;
export type RecordGetCommand = CommandWithArgs<'record.get', Record<string, never>>;
export type RecordClearCommand = CommandWithArgs<'record.clear', Record<string, never>>;
export type RecordReplayCommand = CommandWithArgs<'record.replay', { stopOnError?: boolean }>;
export type RecordStopReplayCommand = CommandWithArgs<'record.stopReplay', Record<string, never>>;
export type RecordEventCommand = CommandWithArgs<
    'record.event',
    { workspaceId?: string; tabToken?: string; event?: unknown }
>;

export type StepsRunCommand = CommandWithArgs<'steps.run', { steps: unknown[]; stopOnError?: boolean }>;

export type WorkspaceListCommand = CommandWithArgs<'workspace.list', Record<string, never>>;
export type WorkspaceCreateCommand = CommandWithArgs<
    'workspace.create',
    { startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }
>;
export type WorkspaceSetActiveCommand = CommandWithArgs<'workspace.setActive', { workspaceId: string }>;

export type TabListCommand = CommandWithArgs<'tab.list', { workspaceId?: string }>;
export type TabCreateCommand = CommandWithArgs<
    'tab.create',
    { workspaceId?: string; startUrl?: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle' }
>;
export type TabCloseCommand = CommandWithArgs<'tab.close', { workspaceId?: string; tabId: string }>;
export type TabSetActiveCommand = CommandWithArgs<'tab.setActive', { workspaceId?: string; tabId: string }>;

export type Command =
    | WorkspaceListCommand
    | WorkspaceCreateCommand
    | WorkspaceSetActiveCommand
    | TabListCommand
    | TabCreateCommand
    | TabCloseCommand
    | TabSetActiveCommand
    | RecordStartCommand
    | RecordStopCommand
    | RecordGetCommand
    | RecordClearCommand
    | RecordReplayCommand
    | RecordStopReplayCommand
    | RecordEventCommand
    | StepsRunCommand;
