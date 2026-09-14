export {};

declare global {
  /** Мост, который пробрасывает preload Electron. В вебе отсутствует. */
  interface DesktopBridge {
    isDesktop: boolean;
    quit(): void;
    toggleFullscreen(): void;
  }

  interface Window {
    desktop?: DesktopBridge;
  }
}
