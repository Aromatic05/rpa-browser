/**
 * Product UI entry point — an independent ES module (`product/product_ui.js`).
 * Not yet mounted from the content script; integration wires a controller that
 * feeds `WorkspaceProductView` projections and a typed `CommandPort`.
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
    DemonstrationRef,
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