import type { ActionHandler } from '../execute';
import { navigationHandlers } from './navigation';
import { elementClickHandlers } from './element_click';
import { elementFormHandlers } from './element_form';
import { elementChoiceHandlers } from './element_choice';
import { elementDateHandlers } from './element_date';
import { elementScrollHandlers } from './element_scroll';
import { dialogPopupHandlers } from './dialogs_popups';
import { clipboardHandlers } from './clipboard';
import { keyboardMouseHandlers } from './keyboard_mouse';
import { fileUploadHandlers } from './file_upload';
import { waitsAssertsHandlers } from './waits_asserts';
import { recordingHandlers } from './recording';

export const actionHandlers: Record<string, ActionHandler> = {
  ...navigationHandlers,
  ...elementClickHandlers,
  ...elementFormHandlers,
  ...elementChoiceHandlers,
  ...elementDateHandlers,
  ...elementScrollHandlers,
  ...dialogPopupHandlers,
  ...clipboardHandlers,
  ...keyboardMouseHandlers,
  ...fileUploadHandlers,
  ...waitsAssertsHandlers,
  ...recordingHandlers
};
