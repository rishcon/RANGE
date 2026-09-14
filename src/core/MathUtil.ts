/** Мелкая математика, общая для игрока, оружия и эффектов. */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Кадронезависимое сглаживание: экспоненциальное приближение `current` к `target`.
 * lambda — "скорость" (1/сек), чем больше, тем жёстче.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randSign(): number {
  return Math.random() < 0.5 ? -1 : 1;
}

/** Нормальное распределение (Box-Muller). Используется для разброса пуль. */
export function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Критически задемпфированная пружина — основа отдачи вьюмодели и "оседания" камеры.
 * Возвращает новые [значение, скорость].
 */
export function spring(
  value: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number
): [number, number] {
  const accel = (target - value) * stiffness - velocity * damping;
  const v = velocity + accel * dt;
  return [value + v * dt, v];
}

/** Горизонтальный FOV (градусы) -> вертикальный FOV (радианы) для заданного аспекта. */
export function hFovToVFov(hFovDeg: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((hFovDeg * DEG) / 2) / Math.max(aspect, 0.0001));
}
