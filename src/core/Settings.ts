export interface GameSettings {
  /** Базовая чувствительность (условные единицы, ~2.0 — норма). */
  sensitivity: number;
  /** Множитель чувствительности при прицеливании. */
  adsSensMul: number;
  /** Горизонтальное поле зрения от бедра, градусы. */
  fovDeg: number;
  masterVolume: number;
  invertY: boolean;
  viewBob: boolean;
  crosshair: boolean;
  shadows: boolean;
  postFx: boolean;
  showFps: boolean;
  /** Потолок частоты кадров; 0 — без ограничения (по vsync). */
  fpsLimit: number;
  /** Множитель разрешения рендера относительно нативного. */
  renderScale: number;
}

export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  sensitivity: 2.0,
  adsSensMul: 0.75,
  fovDeg: 95,
  masterVolume: 0.7,
  invertY: false,
  viewBob: true,
  crosshair: true,
  shadows: true,
  postFx: true,
  showFps: true,
  fpsLimit: 0,
  renderScale: 1,
});

const STORAGE_KEY = "range-shooter.settings.v1";

type Listener = (s: Readonly<GameSettings>) => void;

/** Хранилище настроек: значения + подписка на изменения + localStorage. */
export class SettingsStore {
  private data: GameSettings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<Listener>();

  constructor() {
    this.load();
  }

  get current(): Readonly<GameSettings> {
    return this.data;
  }

  set<K extends keyof GameSettings>(key: K, value: GameSettings[K]): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.save();
    this.emit();
  }

  resetToDefaults(): void {
    this.data = { ...DEFAULT_SETTINGS };
    this.save();
    this.emit();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.data);
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof GameSettings)[]) {
        const v = parsed[key];
        if (typeof v === typeof DEFAULT_SETTINGS[key]) {
          // Типы совпали — присваиваем через приведение: ключи проверены выше.
          (this.data[key] as GameSettings[typeof key]) = v as GameSettings[typeof key];
        }
      }
    } catch {
      // Битые/недоступные настройки не должны мешать запуску игры.
      this.data = { ...DEFAULT_SETTINGS };
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* приватный режим — просто не сохраняем */
    }
  }
}

export const settings = new SettingsStore();
