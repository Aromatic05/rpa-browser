import type { Page } from 'playwright';
import type { ActionContext } from '../../src/runner/execute';
import { executeCommand } from '../../src/runner/execute';
import { createRecordingState } from '../../src/record/recording';
import type { PageRegistry } from '../../src/runtime/page_registry';

export const createRegistry = (page: Page, tabToken: string): PageRegistry => ({
  bindPage: async () => tabToken,
  getPage: async () => page,
  listPages: () => [{ tabToken, page }],
  cleanup: () => {}
});

export const createCtx = (page: Page, tabToken: string): ActionContext => {
  const pageRegistry = createRegistry(page, tabToken);
  const ctx: ActionContext = {
    page,
    tabToken,
    pageRegistry,
    log: () => {},
    recordingState: createRecordingState(),
    replayOptions: {
      clickDelayMs: 0,
      stepDelayMs: 0,
      scroll: { minDelta: 200, maxDelta: 300, minSteps: 1, maxSteps: 2 }
    },
    navDedupeWindowMs: 300,
    execute: undefined
  };
  ctx.execute = (cmd) => executeCommand(ctx, cmd);
  return ctx;
};
