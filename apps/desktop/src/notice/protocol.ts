import type { DesktopNotice } from '@frequencia/shared';

/** Main → notice window: show this one. */
export const NOTICE_SHOW = 'notice:show';
/** Notice window → main: it was clicked. */
export const NOTICE_CLICK = 'notice:click';
/** Notice window → main: it finished leaving; the next one may come. */
export const NOTICE_DONE = 'notice:done';

/** The bridge the preload script exposes to the notice page. */
export interface NoticeBridge {
  onShow(listener: (notice: DesktopNotice) => void): void;
  click(): void;
  done(): void;
}
