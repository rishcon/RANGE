import { DEG } from "./MathUtil";

/** Параметры персонажа и мира. Всё в метрах/секундах/радианах. */

export const PLAYER = {
  /** Полная высота капсулы стоя / сидя. */
  standHeight: 1.82,
  crouchHeight: 1.24,
  /** На сколько глаза ниже макушки. */
  eyeDrop: 0.14,
  radius: 0.34,

  walkSpeed: 3.4,
  sprintSpeed: 6.1,
  crouchSpeed: 1.75,
  /** Множитель скорости при прицеливании. */
  adsSpeedMul: 0.52,
  /** Ходьба назад/вбок чуть медленнее. */
  backwardMul: 0.82,
  strafeMul: 0.92,

  accelGround: 60,
  accelAir: 11,
  frictionGround: 11,
  /** Инерция в воздухе почти нулевая — трения нет. */
  frictionAir: 0.05,

  gravity: 19.5,
  jumpVelocity: 6.3,
  /** Сколько времени после схода с края ещё можно прыгнуть. */
  coyoteTime: 0.1,
  jumpBuffer: 0.12,

  /** Скорость смены стойки (1/сек для damp). */
  stanceLerp: 11,

  maxLean: 15 * DEG,
  leanOffset: 0.42,
  leanSpeed: 9.5,

  /** Шаг ноги — раз в сколько метров пройденного пути. */
  stepDistance: 1.9,
  sprintStepDistance: 2.35,

  pitchLimit: 88 * DEG,
};

export const CAMERA = {
  near: 0.02,
  far: 400,
  /** Наклон камеры при стрейфе (рад). */
  strafeTilt: 0.9 * DEG,
  /** Амплитуда покачивания при ходьбе. */
  bobAmount: 0.028,
  bobRoll: 0.35 * DEG,
  /** Дыхание в состоянии покоя. */
  breathAmount: 0.0035,
  landDipMax: 0.16,
};

export const WORLD = {
  /** Позиция и направление взгляда при старте/респавне. */
  spawn: { x: 0, y: 0.55, z: -6 },
  spawnYaw: 0,
  /** Дальний край полигона (за мишенями — вал). */
  rangeLength: 90,
  rangeHalfWidth: 24,
};
