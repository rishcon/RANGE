import { DEG, clamp, damp, randRange, randSign, spring } from "../core/MathUtil";
import { PATTERN_SCALE, type WeaponConfig } from "./WeaponConfig";

/** Визуальная тряска камеры. На направление выстрела не влияет. */
export interface ViewPunch {
  pitch: number;
  yaw: number;
  roll: number;
}

/** Чем обернулся последний выстрел — вьюмодель берёт отсюда силу рывка. */
export interface ShotKick {
  /** Итоговая сила относительно «холодного» первого выстрела. */
  strength: number;
  /** Ствол клюнул заметно резче обычного. */
  hitch: boolean;
}

/** Предохранитель от разгона: дальше этих углов отдача прицел не уводит. */
const AIM_LIMIT_PITCH = 35 * DEG;
const AIM_LIMIT_YAW = 25 * DEG;

/**
 * Отдача собрана из шести слоёв, которые накладываются друг на друга. По
 * отдельности каждый предсказуем, вместе — паттерн невозможно «заучить
 * наизусть» и приходится реально бороться со стволом, как в PUBG и CS2.
 *
 * 1. **Паттерн** — детерминированная основа, но выборка идёт с дробной фазой:
 *    у каждой очереди своё смещение внутри таблицы, поэтому N-й выстрел не
 *    попадает в одну и ту же ступень.
 * 2. **Пружина прицела** — недодемпфированная, поэтому ствол не «приезжает» в
 *    точку, а подскакивает с перелётом и оседает обратно.
 * 3. **Залипший увод** — часть горизонтали не возвращается сама, и после
 *    очереди прицел остаётся сбитым вбок: доводить надо мышью.
 * 4. **Нагрев ствола** — копится между очередями и медленно уходит. Горячий
 *    ствол бьёт сильнее, гуляет шире и дрожит заметнее, поэтому третий магазин
 *    подряд удержать труднее первого.
 * 5. **Тремор** — высокочастотная дрожь из двух несоизмеримых гармоник на
 *    боевом канале: длинную очередь физически нельзя держать точно.
 * 6. **Клевки** — редкие выстрелы с резко усиленным импульсом.
 *
 * Всё это живёт в канале прицела (`pitch`/`yaw`) — он уводит пули. Отдельно
 * идёт чисто визуальная тряска (`view`), которая сбивает картинку, но на точку
 * попадания не влияет.
 */
export class RecoilController {
  /** Текущее смещение прицела (радианы). */
  pitch = 0;
  yaw = 0;

  readonly view: ViewPunch = { pitch: 0, yaw: 0, roll: 0 };
  readonly lastKick: ShotKick = { strength: 1, hitch: false };

  /** Куда «упёрся» ствол: накопленный паттерн, к нему тянется пружина. */
  private targetPitch = 0;
  private targetYaw = 0;
  /** Состояние недодемпфированной пружины прицела. */
  private springPitch = 0;
  private springYaw = 0;
  private velPitch = 0;
  private velYaw = 0;

  private shotIndex = 0;
  private sinceLastShot = 10;

  /** Нагрев ствола 0..1: копится через очереди, уходит только в паузах. */
  private barrelHeat = 0;
  /** Невозвращаемый горизонтальный увод — его игрок правит мышью сам. */
  private yawBias = 0;

  private viewVelPitch = 0;
  private viewVelYaw = 0;
  private viewVelRoll = 0;

  /** Фаза дрейфа — своя у каждой очереди, поэтому паттерн не заучивается. */
  private driftSeed = Math.random() * 100;
  /** Дробное смещение внутри таблицы паттерна — тоже своё у каждой очереди. */
  private patternPhase = 0;

  private tremorTime = 0;
  private readonly tremorA = Math.random() * 7;
  private readonly tremorB = Math.random() * 7;
  private readonly tremorC = Math.random() * 7;
  private readonly tremorD = Math.random() * 7;

  /** Рабочая ступень паттерна — чтобы не плодить объекты на каждый выстрел. */
  private readonly step = { up: 0, side: 0 };

  constructor(private readonly cfg: WeaponConfig) {}

  get index(): number {
    return this.shotIndex;
  }

  /** Нагрев ствола 0..1 — HUD подкрашивает им марку прицела. */
  get heat(): number {
    return this.barrelHeat;
  }

  /**
   * Ступень паттерна с дробным индексом: между соседними строками таблицы
   * интерполируем, поэтому счётчик выстрелов больше не даёт ровно те же углы.
   */
  private sample(pos: number): { up: number; side: number } {
    const pattern = this.cfg.pattern;
    const last = pattern.length - 1;
    const p = clamp(pos, 0, last);
    const i = Math.floor(p);
    const f = p - i;
    const a = pattern[i]!;
    const b = pattern[Math.min(i + 1, last)]!;
    this.step.up = a.up + (b.up - a.up) * f;
    this.step.side = a.side + (b.side - a.side) * f;
    return this.step;
  }

  /** Добавить импульс очередного выстрела. */
  kick(multiplier: number): void {
    const cfg = this.cfg;
    const idx = this.shotIndex;
    const heat = this.barrelHeat;

    const step = this.sample(idx + this.patternPhase);

    // Отдача нарастает по ходу очереди, первые выстрелы ослаблены, а горячий
    // ствол бьёт сильнее холодного.
    const ramp = Math.min(1 + idx * cfg.recoilRampPerShot, cfg.recoilRampMax);
    const first = idx < cfg.recoilFirstShots ? cfg.recoilFirstShotMul : 1;
    const m = multiplier * ramp * first * (1 + heat * cfg.recoilHeatRecoil);

    const j = cfg.recoilJitter * (1 + heat * cfg.recoilHeatJitter);
    let up = step.up * randRange(1 - j, 1 + j);

    // Горизонталь: паттерн плюс две несоизмеримые гармоники дрейфа. Их период
    // не кратен длине очереди, поэтому «змейка» каждый раз новая.
    const d = cfg.recoilDrift * (1 + heat * 0.7);
    const drift =
      Math.sin(this.driftSeed + idx * 0.41) * d + Math.sin(this.driftSeed * 1.73 + idx * 0.17) * d * 0.45;
    let side =
      (step.side + drift) * randRange(1 - j * 1.6, 1 + j * 1.6) + randRange(-0.05, 0.05) * (1 + heat * 0.5);

    // Редкий клевок: ствол дёргает резче и уводит вбок. Чем горячее, тем чаще —
    // под конец долгой перестрелки очередь становится совсем рваной.
    const hitch = Math.random() < cfg.recoilHitchChance * (1 + heat * 1.5);
    if (hitch) {
      up *= cfg.recoilHitchMul;
      side = side * cfg.recoilHitchMul + randSign() * cfg.recoilDrift * 1.8;
    }

    const upRad = up * PATTERN_SCALE * m;
    const sideRad = side * PATTERN_SCALE * m;

    this.targetPitch = clamp(this.targetPitch - upRad, -AIM_LIMIT_PITCH, AIM_LIMIT_PITCH);
    this.targetYaw = clamp(this.targetYaw + sideRad, -AIM_LIMIT_YAW, AIM_LIMIT_YAW);
    // Часть увода «залипает»: сама она не уйдёт, доводить придётся мышью.
    this.yawBias = clamp(this.yawBias + sideRad * cfg.recoilYawStick, -AIM_LIMIT_YAW, AIM_LIMIT_YAW);

    // Добавочный импульс скорости: ствол не просто едет к новой точке, а
    // подскакивает мимо неё и возвращается.
    const snap = cfg.recoilAttack * cfg.recoilSnap;
    this.velPitch -= upRad * snap;
    this.velYaw += sideRad * snap;

    this.barrelHeat = Math.min(1, this.barrelHeat + cfg.recoilHeatPerShot);

    this.lastKick.strength = m * (hitch ? cfg.recoilHitchMul : 1);
    this.lastKick.hitch = hitch;

    this.addViewPunch(m, hitch);

    this.shotIndex++;
    this.sinceLastShot = 0;
  }

  /**
   * Импульс скорости пружины. Чтобы пик совпал с заданной амплитудой,
   * скорость берём как A * 2*sqrt(k) — для выбранного демпфирования это
   * даёт примерно нужный подброс.
   */
  private addViewPunch(m: number, hitch: boolean): void {
    const cfg = this.cfg;
    const impulse = 2 * Math.sqrt(cfg.viewPunchStiffness);
    // Горячий ствол трясёт картинку сильнее, клевок — ещё сильнее.
    const k = m * (1 + this.barrelHeat * 0.45) * (hitch ? 1.9 : 1) * impulse;
    this.viewVelPitch -= cfg.viewPunchPitch * DEG * k * randRange(0.75, 1.3);
    this.viewVelYaw += cfg.viewPunchYaw * DEG * k * randRange(-1.3, 1.3);
    this.viewVelRoll += cfg.viewPunchRoll * DEG * k * randRange(-1.2, 1.2);
  }

  update(dt: number): void {
    const cfg = this.cfg;
    this.sinceLastShot += dt;
    this.tremorTime += dt;

    // Ствол остывает только тогда, когда из него не стреляют.
    const firing = this.sinceLastShot < 0.25;
    if (!firing) this.barrelHeat = Math.max(0, this.barrelHeat - cfg.recoilHeatCool * dt);

    // Пауза в стрельбе -> прицел возвращается. Вертикаль уходит в ноль, а
    // горизонталь — только к залипшему уводу, и то медленнее.
    if (this.sinceLastShot > cfg.recoilRecoveryDelay) {
      const k = cfg.recoilRecoverySpeed;
      this.targetPitch = damp(this.targetPitch, 0, k, dt);
      this.targetYaw = damp(this.targetYaw, this.yawBias, k * cfg.recoilYawRecoveryMul, dt);
      this.yawBias = damp(this.yawBias, 0, cfg.recoilYawStickDecay, dt);
    }
    if (this.sinceLastShot > 0.32 && this.shotIndex > 0) {
      // Новая очередь — новая фаза дрейфа и новое смещение внутри паттерна.
      this.shotIndex = 0;
      this.driftSeed = Math.random() * 100;
      this.patternPhase = randRange(0, cfg.recoilPatternSmear);
    }

    this.updateAimSpring(dt);

    // Тремор: чем горячее ствол и длиннее очередь, тем сильнее «плывёт» точка
    // попадания. Именно он не даёт держать зажим бесконечно долго.
    const burst = Math.min(1, this.shotIndex / 12);
    const amp = cfg.recoilTremor * DEG * (0.25 + 0.75 * this.barrelHeat) * (0.35 + 0.65 * burst);
    const t = this.tremorTime;
    const tremorPitch = (Math.sin(t * 13.7 + this.tremorA) + 0.6 * Math.sin(t * 23.3 + this.tremorB)) * amp;
    const tremorYaw =
      (Math.sin(t * 11.1 + this.tremorC) + 0.6 * Math.sin(t * 19.7 + this.tremorD)) * amp * 1.3;

    this.pitch = this.springPitch + tremorPitch;
    this.yaw = this.springYaw + tremorYaw;

    this.updateViewPunch(dt);
  }

  /**
   * Недодемпфированная пружина прицела: `recoilAttack` — собственная частота,
   * `recoilSpringDamping` — коэффициент затухания (<1 даёт перелёт). Жёсткая
   * пружина на большом кадре расходится, поэтому шаг дробим.
   */
  private updateAimSpring(dt: number): void {
    const cfg = this.cfg;
    const w = cfg.recoilAttack;
    const k = w * w;
    const c = 2 * cfg.recoilSpringDamping * w;

    const steps = Math.min(8, Math.max(1, Math.ceil(dt * w * 4)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velPitch += ((this.targetPitch - this.springPitch) * k - this.velPitch * c) * h;
      this.springPitch += this.velPitch * h;
      this.velYaw += ((this.targetYaw - this.springYaw) * k - this.velYaw * c) * h;
      this.springYaw += this.velYaw * h;
    }
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
    this.springPitch = 0;
    this.springYaw = 0;
    this.velPitch = 0;
    this.velYaw = 0;
    this.shotIndex = 0;
    this.sinceLastShot = 10;
    this.barrelHeat = 0;
    this.yawBias = 0;
    this.patternPhase = 0;
    this.lastKick.strength = 1;
    this.lastKick.hitch = false;
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
