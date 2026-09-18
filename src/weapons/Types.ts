import type { InputManager } from "../input/InputManager";
import type { AimOffset } from "../player/Player";
import type { ViewPunch } from "./Recoil";
import type { SightType } from "./WeaponConfig";
import type { ViewModel } from "./ViewModel";

export const MOUSE_FIRE = 0;
export const MOUSE_ALT = 2;

/** Счётчики за сессию — общие для всего арсенала. */
export interface SessionStats {
  shots: number;
  hits: number;
  headshots: number;
  kills: number;
}

export function createStats(): SessionStats {
  return { shots: 0, hits: 0, headshots: 0, kills: 0 };
}

export interface HudAmmo {
  mag: number;
  reserve: number;
  magSize: number;
}

/**
 * Общий контракт для всего, что можно держать в руках: огнестрел, нож, гранаты.
 * Инвентарь работает только через него.
 */
export interface IWeapon {
  readonly slot: number;
  readonly displayName: string;
  readonly caliber: string;
  readonly viewModel: ViewModel;

  /** Боезапас для HUD; null — оружие без патронов (нож). */
  readonly hudAmmo: HudAmmo | null;
  /** Счётчик штук для слота (гранаты); null — не применимо. */
  readonly hudCount: number | null;
  /** Доступно ли для выбора (гранаты заканчиваются). */
  readonly available: boolean;

  readonly aimProgress: number;
  readonly adsFovMul: number;
  readonly usesScope: boolean;
  /** Что показывать при прицеливании: ничего, точку коллиматора или оптику. */
  readonly sightType: SightType | "none";
  /** Полуугол конуса разброса в градусах; 0 — марка не нужна. */
  readonly spreadDegrees: number;
  /** Нагрев ствола 0..1: горячий бьёт жёстче — HUD подкрашивает этим марку. */
  readonly barrelHeat: number;
  readonly allowSprint: boolean;
  /** Идёт действие, во время которого нельзя менять оружие. */
  readonly busy: boolean;
  readonly recoilAim: AimOffset;
  readonly viewPunch: ViewPunch;
  readonly isReloading: boolean;
  readonly reloadProgress: number;

  onEquip(): void;
  onHolster(): void;

  /** Фаза 1: прицеливание, отдача, таймеры. Вызывается ДО обновления игрока. */
  updateAim(dt: number, input: InputManager, canAct: boolean): void;
  /** Фаза 2: собственно действие. Вызывается ПОСЛЕ обновления игрока. */
  updateAction(dt: number, input: InputManager, canAct: boolean): void;
  /** Анимация модели в руках. */
  updateViewModel(dt: number, equipT: number): void;
}
