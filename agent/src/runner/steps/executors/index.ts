import type { StepName, StepResult, StepUnion } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { executeBrowserClick } from './click';
import { executeBrowserFill } from './fill';
import { executeBrowserGoto } from './goto';
import { executeBrowserSnapshot } from './snapshot';
import { executeBrowserGoBack } from './go_back';
import { executeBrowserReload } from './reload';
import { executeBrowserCreateTab } from './create_tab';
import { executeBrowserSwitchTab } from './switch_tab';
import { executeBrowserCloseTab } from './close_tab';
import { executeBrowserGetPageInfo } from './get_page_info';
import { executeBrowserTakeScreenshot } from './take_screenshot';
import { executeBrowserType } from './type';
import { executeBrowserSelectOption } from './select_option';
import { executeBrowserHover } from './hover';
import { executeBrowserScroll } from './scroll';
import { executeBrowserPressKey } from './press_key';
import { executeBrowserDragAndDrop } from './drag_and_drop';
import { executeBrowserMouse } from './mouse';

export type ExecutorFn = (step: StepUnion, deps: RunStepsDeps, workspaceId: string) => Promise<StepResult>;

export const stepExecutors: Record<StepName, ExecutorFn> = {
    'browser.goto': executeBrowserGoto as ExecutorFn,
    'browser.go_back': executeBrowserGoBack as ExecutorFn,
    'browser.reload': executeBrowserReload as ExecutorFn,
    'browser.create_tab': executeBrowserCreateTab as ExecutorFn,
    'browser.switch_tab': executeBrowserSwitchTab as ExecutorFn,
    'browser.close_tab': executeBrowserCloseTab as ExecutorFn,
    'browser.get_page_info': executeBrowserGetPageInfo as ExecutorFn,
    'browser.snapshot': executeBrowserSnapshot as ExecutorFn,
    'browser.take_screenshot': executeBrowserTakeScreenshot as ExecutorFn,
    'browser.click': executeBrowserClick as ExecutorFn,
    'browser.fill': executeBrowserFill as ExecutorFn,
    'browser.type': executeBrowserType as ExecutorFn,
    'browser.select_option': executeBrowserSelectOption as ExecutorFn,
    'browser.hover': executeBrowserHover as ExecutorFn,
    'browser.scroll': executeBrowserScroll as ExecutorFn,
    'browser.press_key': executeBrowserPressKey as ExecutorFn,
    'browser.drag_and_drop': executeBrowserDragAndDrop as ExecutorFn,
    'browser.mouse': executeBrowserMouse as ExecutorFn,
};
