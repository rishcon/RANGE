import { contextBridge, ipcRenderer } from "electron";

/**
 * Единственный мост между рендером и main-процессом.
 * В вебе этого объекта нет — игра проверяет `window.desktop` и прячет "Выход".
 */
contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  quit: (): void => ipcRenderer.send("app:quit"),
  toggleFullscreen: (): void => ipcRenderer.send("app:toggle-fullscreen"),
});
