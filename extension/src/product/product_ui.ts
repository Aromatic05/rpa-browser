/**
 * Product UI entry point. The content-script mount wires this module to the
 * workspace product controller and renders the right-docked product surface.
 */
export { mountProductUI } from './shell/mount.js';
export type { ProductUIOptions, ProductUIHandle } from './shell/mount.js';
export {
    deriveTitle,
    interactionWaitingKind,
    isActiveActivity,
    isTerminalStatus,
    phaseLabel,
    relativeTimeLabel,
    sanitizeActivityEvent,
    sanitizeWorkspaceView,
    validateClarificationValue,
} from './model/projection.js';
export type {
    ActivityEvent,
    AgentTaskView,
    AnnotateStage,
    AnnotateView,
    AutomationSummary,
    BusinessArea,
    ClarificationSchema,
    CommandPort,
    ConnectionState,
    DemonstrationSummary,
    GuidanceMode,
    InteractionRequest,
    LibrarySummary,
    PageKnowledgeRef,
    PageKnowledgeSummary,
    ProcedureSummary,
    ProductSurface,
    RecoveryOption,
    RecoverySummary,
    StartError,
    TeachKind,
    TeachPhase,
    TeachView,
    TaskHistoryEntry,
    TaskLifecycleStatus,
    TaskOutcome,
    TaskPhase,
    TaskResultView,
    WorkspaceProductView,
    WorkspaceReservation,
} from './model/contracts.js';
export type { SurfaceContext, UiState } from './components/common.js';