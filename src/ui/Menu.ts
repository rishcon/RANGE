import { settings, type GameSettings } from "../core/Settings";

export type MenuScreen = "main" | "pause" | "settings";

export interface MenuCallbacks {
  onStart: () => void;
  onStartDuel: () => void;
  onResume: () => void;
  onQuitToMenu: () => void;
  onResetRange: () => void;
  onExit: () => void;
  onNavigate?: () => void;
}

/** Значения ползунка "Ограничение FPS" (0 — без ограничения). */
const FPS_LIMITS = [0, 60, 75, 90, 120, 144, 165, 200, 240];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Menu: не найден элемент #${id}`);
  return node as T;
}

/** Главное меню, пауза и настройки. Работает поверх канваса как обычный DOM. */
export class Menu {
  private readonly root = el("menu-root");
  private readonly panels: Record<MenuScreen, HTMLElement> = {
    main: el("menu-main"),
    pause: el("menu-pause"),
    settings: el("menu-settings"),
  };

  private current: MenuScreen = "main";
  private previous: MenuScreen = "main";
  private open = true;

  constructor(private readonly callbacks: MenuCallbacks) {
    this.bindButtons();
    this.bindSettings();
    this.syncSettingsUI(settings.current);
    settings.onChange((s) => this.syncSettingsUI(s));
  }

  get isOpen(): boolean {
    return this.open;
  }

  get screen(): MenuScreen {
    return this.current;
  }

  show(screen: MenuScreen): void {
    this.current = screen;
    this.open = true;
    this.root.classList.remove("hidden");
    this.root.classList.toggle("translucent", screen !== "main");
    for (const key of Object.keys(this.panels) as MenuScreen[]) {
      this.panels[key].classList.toggle("hidden", key !== screen);
    }
  }

  hide(): void {
    this.open = false;
    this.root.classList.add("hidden");
  }

  /** Показывает настройки, запоминая, куда возвращаться. */
  private openSettings(): void {
    this.previous = this.current;
    this.show("settings");
  }

  private bindButtons(): void {
    const click = (id: string, fn: () => void): void => {
      el(id).addEventListener("click", () => {
        this.callbacks.onNavigate?.();
        fn();
      });
    };

    click("btn-start", () => this.callbacks.onStart());
    click("btn-duel", () => this.callbacks.onStartDuel());
    click("btn-settings", () => this.openSettings());
    click("btn-exit", () => this.callbacks.onExit());

    click("btn-resume", () => this.callbacks.onResume());
    click("btn-pause-settings", () => this.openSettings());
    click("btn-reset-range", () => this.callbacks.onResetRange());
    click("btn-quit-menu", () => this.callbacks.onQuitToMenu());

    click("btn-settings-back", () => this.show(this.previous === "settings" ? "main" : this.previous));
    click("btn-settings-reset", () => settings.resetToDefaults());

    // В вебе выходить некуда — кнопку прячем.
    if (!window.desktop?.isDesktop) el("btn-exit").style.display = "none";
  }

  private bindSettings(): void {
    const range = (id: string, key: keyof GameSettings): void => {
      const input = el<HTMLInputElement>(id);
      input.addEventListener("input", () => {
        settings.set(key, Number(input.value) as never);
      });
    };
    const check = (id: string, key: keyof GameSettings): void => {
      const input = el<HTMLInputElement>(id);
      input.addEventListener("change", () => {
        settings.set(key, input.checked as never);
      });
    };

    range("set-sens", "sensitivity");
    range("set-adssens", "adsSensMul");
    range("set-fov", "fovDeg");
    range("set-volume", "masterVolume");
    check("set-invert", "invertY");
    check("set-bob", "viewBob");
    check("set-crosshair", "crosshair");
    check("set-shadows", "shadows");
    check("set-postfx", "postFx");
    check("set-fpsmeter", "showFps");
    range("set-renderscale", "renderScale");

    // Ползунок ходит по индексам списка, а в настройках лежит само значение FPS.
    const fpsInput = el<HTMLInputElement>("set-fpslimit");
    fpsInput.addEventListener("input", () => {
      const index = Math.round(Number(fpsInput.value));
      settings.set("fpsLimit", FPS_LIMITS[index] ?? 0);
    });
  }

  private syncSettingsUI(s: Readonly<GameSettings>): void {
    el<HTMLInputElement>("set-sens").value = String(s.sensitivity);
    el("val-sens").textContent = s.sensitivity.toFixed(2);

    el<HTMLInputElement>("set-adssens").value = String(s.adsSensMul);
    el("val-adssens").textContent = s.adsSensMul.toFixed(2);

    el<HTMLInputElement>("set-fov").value = String(s.fovDeg);
    el("val-fov").textContent = String(Math.round(s.fovDeg));

    el<HTMLInputElement>("set-volume").value = String(s.masterVolume);
    el("val-volume").textContent = `${Math.round(s.masterVolume * 100)}%`;

    el<HTMLInputElement>("set-invert").checked = s.invertY;
    el<HTMLInputElement>("set-bob").checked = s.viewBob;
    el<HTMLInputElement>("set-crosshair").checked = s.crosshair;
    el<HTMLInputElement>("set-shadows").checked = s.shadows;
    el<HTMLInputElement>("set-postfx").checked = s.postFx;
    el<HTMLInputElement>("set-fpsmeter").checked = s.showFps;

    const fpsIndex = Math.max(0, FPS_LIMITS.indexOf(s.fpsLimit));
    el<HTMLInputElement>("set-fpslimit").value = String(fpsIndex);
    el("val-fpslimit").textContent = s.fpsLimit === 0 ? "Выкл" : String(s.fpsLimit);

    el<HTMLInputElement>("set-renderscale").value = String(s.renderScale);
    el("val-renderscale").textContent = `${Math.round(s.renderScale * 100)}%`;
  }
}
