import { DEG, clamp, damp, randRange, spring } from "../core/MathUtil";
import { PATTERN_SCALE, type WeaponConfig } from "./WeaponConfig";

/** Визуальная тряска камеры. На направление выстрела не влияет. */
export interface ViewPunch {
  pitch: number;
  yaw: number;
  roll: number;
}

/**
 * Отдача разделена на два независимых канала, как в CS/PUBG:
 *
 * 1. **Смещение прицела** (`pitch`/`yaw`) — детерминированный паттерн плюс
 *    рандомизация и низкочастотный дрейф. Именно оно уводит пули, компенсируется
 *    мышью и возвращается в ноль после паузы в стрельбе.
 * 2. **Тряска камеры** (`view`) — пружинный импульс на каждый выстрел, который
 *    дёргает картинку, но не смещает точку попадания. Он не даёт спокойно
 *    «читать» паттерн и заставляет стрелять короткими очередями.
 */
export class RecoilController {
  /** Текущее смещение прицела (радианы). */
  pitch = 0;
  yaw = 0;

  readonly view: ViewPunch = { pitch: 0, yaw: 0, roll: 0 };

  private targetPitch = 0;
  private targetYaw = 0;
  private shotIndex = 0;
  private sinceLastShot = 10;

  private viewVelPitch = 0;
  private viewVelYaw = 0;
  private viewVelRoll = 0;

  /** Фаза дрейфа — своя у каждой очереди, поэтому паттерн не заучивается наизусть. */
  private driftSeed = Math.random() * 100;

  constructor(private readonly cfg: WeaponConfig) {}

  get index(): number {
    return this.shotIndex;
  }

  /** Добавить импульс очередного выстрела. */
  kick(multiplier: number): void {
    const cfg = this.cfg;
    const idx = this.shotIndex;
    const step = cfg.pattern[Math.min(idx, cfg.pattern.length - 1)]!;

    // Отдача нарастает по ходу очереди, а первые выстрелы ослаблены.
    const ramp = Math.min(1 + idx * cfg.recoilRampPerShot, cfg.recoilRampMax);
    const first = idx < cfg.recoilFirstShots ? cfg.recoilFirstShotMul : 1;
    const m = multiplier * ramp * first;

    const j = cfg.recoilJitter;
    const up = step.up * randRange(1 - j, 1 + j);
    // Горизонталь шумит сильнее вертикали, плюс медленный дрейф всей очереди.
    const drift = Math.sin(this.driftSeed + idx * 0.41) * cfg.recoilDrift;
    const side = (step.side + drift) * randRange(1 - j * 1.6, 1 + j * 1.6) + randRange(-0.05, 0.05);

    this.targetPitch -= up * PATTERN_SCALE * m;
    this.targetYaw += side * PATTERN_SCALE * m;

    this.addViewPunch(m);

    this.shotIndex++;
    this.sinceLastShot = 0;
  }

  /**
   * Импульс скорости пружины. Чтобы пик совпал с заданной амплитудой,
   * скорость берём как A * 2*sqrt(k) — для выбранного демпфирования это
   * даёт примерно нужный подброс.
   */
  private addViewPunch(m: number): void {
    const cfg = this.cfg;
    const impulse = 2 * Math.sqrt(cfg.viewPunchStiffness);
    this.viewVelPitch -= cfg.viewPunchPitch * DEG * m * randRange(0.75, 1.3) * impulse;
    this.viewVelYaw += cfg.viewPunchYaw * DEG * m * randRange(-1.3, 1.3) * impulse;
    this.viewVelRoll += cfg.viewPunchRoll * DEG * m * randRange(-1.2, 1.2) * impulse;
  }

  update(dt: number): void {
    const cfg = this.cfg;
    this.sinceLastShot += dt;

    // Пауза в стрельбе -> прицел плавно возвращается, счётчик паттерна сбрасывается.
    if (this.sinceLastShot > cfg.recoilRecoveryDelay) {
      const k = cfg.recoilRecoverySpeed;
      this.targetPitch = damp(this.targetPitch, 0, k, dt);
      this.targetYaw = damp(this.targetYaw, 0, k, dt);
    }
    if (this.sinceLastShot > 0.32 && this.shotIndex > 0) {
      this.shotIndex = 0;
      // Новая очередь — новая фаза дрейфа.
      this.driftSeed = Math.random() * 100;
    }

    // Быстрый, но не мгновенный подъём — именно он читается как "подброс".
    this.pitch = damp(this.pitch, this.targetPitch, cfg.recoilAttack, dt);
    this.yaw = damp(this.yaw, this.targetYaw, cfg.recoilAttack, dt);

    this.updateViewPunch(dt);
  }

  private updateViewPunch(dt: number): void {
    const cfg = this.cfg;
    const k = cfg.viewPunchStiffness;
    const c = cfg.viewPunchDamping;
    const limit = cfg.viewPunchMax * DEG;

    [this.view.pitch, this.viewVelPitch] = spring(this.view.pitch, this.viewVelPitch, 0, k, c, dt);
    [this.view.yaw, this.viewVelYaw] = spring(this.view.yaw, this.viewVelYaw, 0, k, c, dt);
    [this.view.roll, this.viewVelRoll] = spring(this.view.roll, this.viewVelRoll, 0, k, c, dt);

    this.view.pitch = clamp(this.view.pitch, -limit, limit);
    this.view.yaw = clamp(this.view.yaw, -limit, limit);
    this.view.roll = clamp(this.view.roll, -limit * 1.5, limit * 1.5);
  }

  reset(): void {
    this.pitch = 0;
    this.yaw = 0;
    this.targetPitch = 0;
    this.targetYaw = 0;
    this.shotIndex = 0;
    this.sinceLastShot = 10;
    this.view.pitch = 0;
    this.view.yaw = 0;
    this.view.roll = 0;
    this.viewVelPitch = 0;
    this.viewVelYaw = 0;
    this.viewVelRoll = 0;
  }
}

/** Неподвижное смещение прицела — для оружия без отдачи (нож, гранаты). */
export const ZERO_AIM = { pitch: 0, yaw: 0 };

/**
 * Отдельная пружина тряски камеры для оружия без паттерна отдачи:
 * ножа и броска гранаты.
 */
export class ViewPunchSpring {
  readonly value: ViewPunch = { pitch: 0, yaw: 0, roll: 0 };

  private velPitch = 0;
  private velYaw = 0;
  private velRoll = 0;

  constructor(
    private readonly stiffness = 200,
    private readonly damping = 15,
    private readonly maxDeg = 4
  ) {}

  /** Импульс в градусах; пик примерно совпадает с переданной амплитудой. */
  impulse(pitchDeg: number, yawDeg: number, rollDeg: number): void {
    const k = 2 * Math.sqrt(this.stiffness);
    this.velPitch -= pitchDeg * DEG * k;
    this.velYaw += yawDeg * DEG * k;
    this.velRoll += rollDeg * DEG * k;
  }

  update(dt: number): void {
    const limit = this.maxDeg * DEG;
    [this.value.pitch, this.velPitch] = spring(this.value.pitch, this.velPitch, 0, this.stiffness, this.damping, dt);
    [this.value.yaw, this.velYaw] = spring(this.value.yaw, this.velYaw, 0, this.stiffness, this.damping, dt);
    [this.value.roll, this.velRoll] = spring(this.value.roll, this.velRoll, 0, this.stiffness, this.damping, dt);
    this.value.pitch = clamp(this.value.pitch, -limit, limit);
    this.value.yaw = clamp(this.value.yaw, -limit, limit);
    this.value.roll = clamp(this.value.roll, -limit * 1.5, limit * 1.5);
  }

  reset(): void {
    this.value.pitch = 0;
    this.value.yaw = 0;
    this.value.roll = 0;
    this.velPitch = 0;
    this.velYaw = 0;
    this.velRoll = 0;
  }
}
