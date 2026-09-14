import { DEG } from "../core/MathUtil";
import type { WeaponModelKind } from "./models";

export type FireMode = "auto" | "semi" | "bolt";
export type WeaponId = "ar15" | "sniper" | "pistol";
export type SoundProfile = "rifle" | "sniper" | "pistol";
/** Чем целятся: механика, коллиматор или оптика. */
export type SightType = "iron" | "reddot" | "scope";

export interface RecoilStep {
  /** Подброс вверх, градусы. */
  up: number;
  /** Увод в сторону, градусы (знак = сторона). */
  side: number;
}

export interface WeaponConfig {
  id: WeaponId;
  name: string;
  caliber: string;
  /** Номер слота в инвентаре (клавиша). */
  slot: number;
  modelKind: WeaponModelKind;
  sound: SoundProfile;

  fireMode: FireMode;
  /** Темп стрельбы, выстрелов в минуту. */
  rpm: number;
  magSize: number;
  reserveAmmo: number;
  /** Время перезаряжания затвора после выстрела (болтовая винтовка). */
  cycleTime: number;

  damage: number;
  headMultiplier: number;
  limbMultiplier: number;
  /** Максимальная дальность рейкаста, м. */
  range: number;

  /** Перезарядка с патроном в стволе / с пустым магазином, сек. */
  reloadTime: number;
  reloadEmptyTime: number;
  /** Время выхода в прицел, сек. */
  adsTime: number;
  /** Во сколько раз сужается поле зрения при прицеливании. */
  adsFovMul: number;
  /** Оптический прицел: модель прячется, включается оверлей. */
  scope: boolean;
  sightType: SightType;

  /** Базовый разброс (полуугол конуса, градусы) при идеальных условиях. */
  spreadBase: number;
  spreadHipMul: number;
  spreadCrouchMul: number;
  spreadMoveAdd: number;
  spreadAirAdd: number;
  /** Прирост разброса за выстрел и скорость его спада. */
  spreadPerShot: number;
  spreadMax: number;
  spreadRecovery: number;

  /** Множитель силы отдачи в прицеле и при приседе. */
  recoilAdsMul: number;
  recoilCrouchMul: number;
  /** Случайный разброс паттерна: ±доля от значения шага. */
  recoilJitter: number;
  /** Пауза до начала возврата прицела (должна быть длиннее интервала между
   *  выстрелами, иначе паттерн «съедается» возвратом прямо в очереди). */
  recoilRecoveryDelay: number;
  recoilRecoverySpeed: number;
  recoilAttack: number;

  /** Сколько первых выстрелов очереди ослаблены и во сколько раз. */
  recoilFirstShots: number;
  recoilFirstShotMul: number;
  /** Насколько отдача растёт с каждым выстрелом очереди («разогрев» ствола). */
  recoilRampPerShot: number;
  recoilRampMax: number;
  /**
   * Низкочастотный горизонтальный дрейф паттерна (градусы). Фаза своя у каждой
   * очереди — благодаря ей одинаковое «заучивание» паттерна не работает.
   */
  recoilDrift: number;

  /**
   * Визуальная тряска камеры на выстреле (градусы). На точку попадания НЕ влияет
   * — только сбивает прицеливание игроку, как viewpunch в CS.
   */
  viewPunchPitch: number;
  viewPunchYaw: number;
  viewPunchRoll: number;
  viewPunchStiffness: number;
  viewPunchDamping: number;
  /** Ограничение накопленной тряски, градусы. */
  viewPunchMax: number;

  /** Паттерн отдачи по выстрелам (как в тактических шутерах). */
  pattern: RecoilStep[];
}

/**
 * Паттерн винтовки: первые три выстрела почти строго вверх и слабее остальных
 * (короткие очереди остаются точными), затем ствол резко уходит вверх и начинает
 * «змейку» вправо-влево. Суммарно за магазин набегает около 20° вертикали —
 * удержать зажим без оттяжки мыши вниз невозможно.
 */
const AR15_PATTERN: RecoilStep[] = [
  { up: 0.55, side: 0.02 },
  { up: 0.85, side: -0.06 },
  { up: 1.05, side: 0.1 },
  { up: 1.15, side: 0.26 },
  { up: 1.15, side: 0.42 },
  { up: 1.1, side: 0.55 },
  { up: 1.0, side: 0.52 },
  { up: 0.9, side: 0.3 },
  { up: 0.8, side: -0.05 },
  { up: 0.72, side: -0.42 },
  { up: 0.66, side: -0.66 },
  { up: 0.62, side: -0.8 },
  { up: 0.58, side: -0.72 },
  { up: 0.56, side: -0.46 },
  { up: 0.54, side: -0.12 },
  { up: 0.52, side: 0.3 },
  { up: 0.5, side: 0.6 },
  { up: 0.48, side: 0.75 },
  { up: 0.47, side: 0.68 },
  { up: 0.46, side: 0.44 },
  { up: 0.45, side: 0.12 },
  { up: 0.44, side: -0.26 },
  { up: 0.43, side: -0.55 },
  { up: 0.42, side: -0.66 },
  { up: 0.41, side: -0.58 },
  { up: 0.4, side: -0.34 },
  { up: 0.39, side: 0.02 },
  { up: 0.38, side: 0.36 },
  { up: 0.37, side: 0.56 },
  { up: 0.36, side: 0.62 },
];

/** Болтовка: между выстрелами всегда пауза, поэтому паттерн короткий и резкий. */
const SNIPER_PATTERN: RecoilStep[] = [
  { up: 3.4, side: 0.15 },
  { up: 3.6, side: -0.2 },
  { up: 3.5, side: 0.25 },
];

/** Пистолет: каждый выстрел заметно подбрасывает, но паттерн почти вертикальный. */
const PISTOL_PATTERN: RecoilStep[] = [
  { up: 0.9, side: 0.05 },
  { up: 1.15, side: -0.12 },
  { up: 1.3, side: 0.18 },
  { up: 1.4, side: -0.22 },
  { up: 1.45, side: 0.26 },
  { up: 1.5, side: -0.3 },
  { up: 1.5, side: 0.3 },
  { up: 1.5, side: -0.28 },
];

export const AR15: WeaponConfig = {
  id: "ar15",
  name: "AR-15",
  caliber: "5.56×45",
  slot: 1,
  modelKind: "rifle",
  sound: "rifle",

  fireMode: "auto",
  rpm: 720,
  magSize: 30,
  reserveAmmo: 150,
  cycleTime: 0,

  damage: 27,
  headMultiplier: 4,
  limbMultiplier: 0.7,
  range: 300,

  reloadTime: 2.15,
  reloadEmptyTime: 2.85,
  adsTime: 0.2,
  // Коллиматор почти не приближает — он про быстрый захват цели.
  adsFovMul: 0.82,
  scope: false,
  sightType: "reddot",

  spreadBase: 0.06,
  spreadHipMul: 14,
  spreadCrouchMul: 0.62,
  spreadMoveAdd: 1.5,
  spreadAirAdd: 3.2,
  spreadPerShot: 0.085,
  spreadMax: 1.1,
  spreadRecovery: 1.6,

  recoilAdsMul: 0.84,
  recoilCrouchMul: 0.8,
  recoilJitter: 0.16,
  recoilRecoveryDelay: 0.14,
  recoilRecoverySpeed: 6.5,
  recoilAttack: 30,

  recoilFirstShots: 2,
  recoilFirstShotMul: 0.8,
  recoilRampPerShot: 0.012,
  recoilRampMax: 1.3,
  recoilDrift: 0.34,

  viewPunchPitch: 0.5,
  viewPunchYaw: 0.3,
  viewPunchRoll: 0.65,
  viewPunchStiffness: 200,
  viewPunchDamping: 15,
  viewPunchMax: 3.2,

  pattern: AR15_PATTERN,
};

export const SNIPER: WeaponConfig = {
  id: "sniper",
  name: "M40 SCOPED",
  caliber: "7.62×51",
  // Тот же слот, что у автомата: «1» переключает основное оружие.
  slot: 1,
  modelKind: "sniper",
  sound: "sniper",

  fireMode: "bolt",
  rpm: 50,
  magSize: 5,
  reserveAmmo: 30,
  // Передёргивание затвора после каждого выстрела.
  cycleTime: 1.25,

  damage: 115,
  headMultiplier: 3,
  limbMultiplier: 0.65,
  range: 600,

  reloadTime: 3.2,
  reloadEmptyTime: 3.6,
  adsTime: 0.34,
  // Оптика: поле зрения сужается почти в шесть раз.
  adsFovMul: 0.17,
  scope: true,
  sightType: "scope",

  spreadBase: 0.012,
  spreadHipMul: 55,
  spreadCrouchMul: 0.5,
  spreadMoveAdd: 3.4,
  spreadAirAdd: 6,
  spreadPerShot: 0.2,
  spreadMax: 0.6,
  spreadRecovery: 1.2,

  recoilAdsMul: 0.9,
  recoilCrouchMul: 0.75,
  recoilJitter: 0.18,
  recoilRecoveryDelay: 0.35,
  recoilRecoverySpeed: 4.5,
  recoilAttack: 26,

  recoilFirstShots: 0,
  recoilFirstShotMul: 1,
  recoilRampPerShot: 0,
  recoilRampMax: 1,
  recoilDrift: 0.1,

  viewPunchPitch: 2.2,
  viewPunchYaw: 0.8,
  viewPunchRoll: 1.6,
  viewPunchStiffness: 150,
  viewPunchDamping: 13,
  viewPunchMax: 6,

  pattern: SNIPER_PATTERN,
};

export const PISTOL: WeaponConfig = {
  id: "pistol",
  name: "P-9",
  caliber: "9×19",
  slot: 2,
  modelKind: "pistol",
  sound: "pistol",

  fireMode: "semi",
  rpm: 420,
  magSize: 12,
  reserveAmmo: 60,
  cycleTime: 0,

  damage: 26,
  headMultiplier: 4,
  limbMultiplier: 0.7,
  range: 160,

  reloadTime: 1.85,
  reloadEmptyTime: 2.35,
  adsTime: 0.16,
  adsFovMul: 0.72,
  scope: false,
  sightType: "iron",

  spreadBase: 0.11,
  spreadHipMul: 10,
  spreadCrouchMul: 0.65,
  spreadMoveAdd: 1.7,
  spreadAirAdd: 3.6,
  spreadPerShot: 0.16,
  spreadMax: 1.4,
  spreadRecovery: 2.4,

  recoilAdsMul: 0.85,
  recoilCrouchMul: 0.82,
  recoilJitter: 0.2,
  recoilRecoveryDelay: 0.12,
  recoilRecoverySpeed: 8,
  recoilAttack: 34,

  recoilFirstShots: 1,
  recoilFirstShotMul: 0.85,
  recoilRampPerShot: 0.02,
  recoilRampMax: 1.25,
  recoilDrift: 0.22,

  viewPunchPitch: 0.8,
  viewPunchYaw: 0.4,
  viewPunchRoll: 0.9,
  viewPunchStiffness: 220,
  viewPunchDamping: 16,
  viewPunchMax: 3.5,

  pattern: PISTOL_PATTERN,
};

// ------------------------------------------------------------------------ нож

export interface MeleeConfig {
  name: string;
  slot: number;
  /** Быстрый удар (ЛКМ) и сильный замах (ПКМ). */
  lightDamage: number;
  heavyDamage: number;
  lightInterval: number;
  heavyInterval: number;
  /** Задержка от начала анимации до момента попадания. */
  lightHitDelay: number;
  heavyHitDelay: number;
  range: number;
  headMultiplier: number;
}

export const KNIFE: MeleeConfig = {
  name: "НОЖ",
  slot: 3,
  lightDamage: 45,
  heavyDamage: 110,
  lightInterval: 0.42,
  heavyInterval: 1.05,
  lightHitDelay: 0.1,
  heavyHitDelay: 0.28,
  range: 1.5,
  headMultiplier: 2,
};

// -------------------------------------------------------------------- гранаты

export type GrenadeKind = "frag" | "smoke" | "flash";

export interface GrenadeConfig {
  kind: GrenadeKind;
  name: string;
  shortName: string;
  slot: number;
  count: number;
  /** Время от броска до срабатывания, сек. */
  fuse: number;
  /** Скорость обычного броска и «подброса» под ноги, м/с. */
  throwSpeed: number;
  lobSpeed: number;
  /** Длительность анимации броска до момента вылета. */
  throwTime: number;
  /** Пауза до следующего броска. */
  cooldown: number;

  /** Осколочная: урон в эпицентре и радиус поражения. */
  damage: number;
  damageRadius: number;
  /** Дымовая: длительность и радиус облака. */
  smokeDuration: number;
  smokeRadius: number;
  /** Светошумовая: радиус ослепления и максимальная длительность. */
  flashRadius: number;
  flashDuration: number;
}

const GRENADE_BASE = {
  count: 2,
  throwSpeed: 17,
  lobSpeed: 7,
  throwTime: 0.34,
  cooldown: 0.6,
  damage: 0,
  damageRadius: 0,
  smokeDuration: 0,
  smokeRadius: 0,
  flashRadius: 0,
  flashDuration: 0,
};

export const FRAG: GrenadeConfig = {
  ...GRENADE_BASE,
  kind: "frag",
  name: "ОСКОЛОЧНАЯ",
  shortName: "ОСК",
  slot: 4,
  fuse: 2.4,
  damage: 130,
  damageRadius: 8,
};

export const SMOKE: GrenadeConfig = {
  ...GRENADE_BASE,
  kind: "smoke",
  name: "ДЫМОВАЯ",
  shortName: "ДЫМ",
  slot: 5,
  count: 2,
  fuse: 1.6,
  smokeDuration: 16,
  smokeRadius: 3.6,
};

export const FLASH: GrenadeConfig = {
  ...GRENADE_BASE,
  kind: "flash",
  name: "СВЕТОШУМОВАЯ",
  shortName: "СВЕТ",
  slot: 6,
  count: 2,
  fuse: 1.7,
  flashRadius: 16,
  flashDuration: 4.2,
};

export const GRENADES: GrenadeConfig[] = [FRAG, SMOKE, FLASH];
export const FIREARMS: WeaponConfig[] = [AR15, SNIPER, PISTOL];

/** Интервал между выстрелами, сек. */
export function shotInterval(cfg: WeaponConfig): number {
  return 60 / cfg.rpm;
}

/** Градусы паттерна -> радианы. */
export const PATTERN_SCALE = DEG;
