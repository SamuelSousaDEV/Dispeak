import type { DesktopNotice } from '@frequencia/shared';
import { contextBridge, ipcRenderer } from 'electron';
import { NOTICE_CLICK, NOTICE_DONE, NOTICE_SHOW, type NoticeBridge } from './protocol';

const bridge: NoticeBridge = {
  onShow: (listener) => {
    ipcRenderer.on(NOTICE_SHOW, (_event, notice: DesktopNotice) => listener(notice));
  },
  click: () => ipcRenderer.send(NOTICE_CLICK),
  done: () => ipcRenderer.send(NOTICE_DONE),
};

contextBridge.exposeInMainWorld('notice', bridge);
