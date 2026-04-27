import type { StepName, StepResult, StepUnion } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { executeBrowserClick } from './click';
import { executeBrowserFill } from './fill';
import { executeBrowserGoto } from './goto';
import { executeBrowserSnapshot } from './snapshot/pipeline/snapshot';
import { executeBrowserGoBack } from './go_back';
import { executeBrowserReload } from './reload';
import { executeBrowserCreateTab } from './create_tab';
import { executeBrowserSwitchTab } from './switch_tab';
import { executeBrowserCloseTab } from './close_tab';
import { executeBrowserGetPageInfo } from './get_page_info';
import { executeBrowserListTabs } from './list_tabs';
import { executeBrowserGetContent } from './get_content';
import { executeBrowserReadConsole } from './read_console';
import { executeBrowserReadNetwork } from './read_network';
import { executeBrowserEvaluate } from './evaluate';
import { executeBrowserTakeScreenshot } from './take_screenshot';
import { executeBrowserType } from './type';
import { executeBrowserSelectOption } from './select_option';
import { executeBrowserHover } from './hover';
import { executeBrowserScroll } from './scroll';
import { executeBrowserPressKey } from './press_key';
import { executeBrowserDragAndDrop } from './drag_and_drop';
import { executeBrowserMouse } from './mouse';
import { executeBrowserListEntities } from './list_entities';
import { executeBrowserGetEntity } from './get_entity';
import { executeBrowserFindEntities } from './find_entities';
import { executeBrowserQueryEntity } from './query_entity';
import { executeBrowserResolveEntityTarget } from './resolve_entity_target';
import { executeBrowserAddEntity } from './add_entity';
import { executeBrowserDeleteEntity } from './delete_entity';
import { executeBrowserRenameEntity } from './rename_entity';
import { executeBrowserAssert } from './assert';
import { executeBrowserQuery } from './query';
import { executeBrowserCompute } from './compute';
import { executeBrowserCheckpoint } from './checkpoint';

export type ExecutorFn = (step: StepUnion, deps: RunStepsDeps, workspaceId: string) => Promise<StepResult>;

export const stepExecutors: Record<StepName, ExecutorFn> = {
    'browser.goto': executeBrowserGoto as ExecutorFn,
    'browser.go_back': executeBrowserGoBack as ExecutorFn,
    'browser.reload': executeBrowserReload as ExecutorFn,
    'browser.create_tab': executeBrowserCreateTab as ExecutorFn,
    'browser.switch_tab': executeBrowserSwitchTab as ExecutorFn,
    'browser.close_tab': executeBrowserCloseTab as ExecutorFn,
    'browser.get_page_info': executeBrowserGetPageInfo as ExecutorFn,
    'browser.list_tabs': executeBrowserListTabs as ExecutorFn,
    'browser.snapshot': executeBrowserSnapshot as ExecutorFn,
    'browser.get_content': executeBrowserGetContent as ExecutorFn,
    'browser.read_console': executeBrowserReadConsole as ExecutorFn,
    'browser.read_network': executeBrowserReadNetwork as ExecutorFn,
    'browser.evaluate': executeBrowserEvaluate as ExecutorFn,
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
    'browser.list_entities': executeBrowserListEntities as ExecutorFn,
    'browser.get_entity': executeBrowserGetEntity as ExecutorFn,
    'browser.find_entities': executeBrowserFindEntities as ExecutorFn,
    'browser.query_entity': executeBrowserQueryEntity as ExecutorFn,
    'browser.resolve_entity_target': executeBrowserResolveEntityTarget as ExecutorFn,
    'browser.add_entity': executeBrowserAddEntity as ExecutorFn,
    'browser.delete_entity': executeBrowserDeleteEntity as ExecutorFn,
    'browser.rename_entity': executeBrowserRenameEntity as ExecutorFn,
    'browser.assert': executeBrowserAssert as ExecutorFn,
    'browser.query': executeBrowserQuery as ExecutorFn,
    'browser.compute': executeBrowserCompute as ExecutorFn,
    'browser.checkpoint': executeBrowserCheckpoint as ExecutorFn,
};
