import { Vector3 } from "@babylonjs/core";
import { clamp01, moveTowards } from "../core/MathUtil";
import type { InputManager } from "../input/InputManager";
import type { AimOffset, Player } from "../player/Player";
import type { AudioManager } from "../fx/AudioManager";
import type { GrenadeSystem } from "../fx/Grenades";
import { ViewPunchSpring, ZERO_AIM, type ViewPunch } from "./Recoil";
import type { ActionKey, ViewModel } from "./ViewModel";
import type { GrenadeConfig } from "./WeaponConfig";
import { MOUSE_ALT, MOUSE_FIRE, type HudAmmo, type IWeapon } from "./Types";

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** Бросок: короткий доворот назад и резкий выброс вперёд. */
const THROW_ANIM: ActionKey[] = [
  { t: 0, pos: Vector3.Zero(), rot: Vector3.Zero() },
  { t: 0.22, pos: V(0.03, 0.05, -0.1), rot: V(-0.45, 0.15, -0.1) },
  { t: 0.5, pos: V(-0.06, -0.02, 0.2), rot: V(0.6, -0.25, 0.15) },
  { t: 0.78, pos: V(-0.02, -0.06, 0.05), rot: V(0.2, -0.1, 0.05) },
  { t: 1, pos: Vector3.Zero(), rot: Vector3.Zero() },
];

/**
 * Метательное снаряжение. Кнопка удерживается — рука уходит на замах,
 * отпускается — бросок. ЛКМ бросает далеко, ПКМ подкидывает под ноги.
 */
export class GrenadeWeapon implements IWeapon {
  private count: number;
  private pullT = 0;
  private pulling = false;
  private lobbing = false;
  private throwTimer = 0;
  private pendingThrow = false;
  private cooldown = 0;
  private pinPulled = false;

  private readonly punch = new ViewPunchSpring(160, 14, 2.5);
  private readonly dir = new Vector3();
  private readonly up = new Vector3();
  private readonly right = new Vector3();
  private readonly origin = new Vector3();

  constructor(
    private readonly config: GrenadeConfig,
    readonly viewModel: ViewModel,
    private readonly player: Player,
    private readonly audio: AudioManager,
    private readonly grenades: GrenadeSystem
  ) {
    this.count = config.count;
  }

  // ---------------------------------------------------------------- состояние

  get kind(): GrenadeConfig["kind"] {
    return this.config.kind;
  }
  get slot(): number {
    return this.config.slot;
  }
  get displayName(): string {
    return this.config.name;
  }
  get shortName(): string {
    return this.config.shortName;
  }
  get caliber(): string {
    return "ГРАНАТА";
  }
  get hudAmmo(): HudAmmo | null {
    return null;
  }
  get hudCount(): number {
    return this.count;
  }
  get available(): boolean {
    return this.count > 0;
  }
  /** Замах показываем через ту же «позу прицеливания» модели. */
  get aimProgress(): number {
    return this.pullT;
  }
  get adsFovMul(): number {
    return 1;
  }
  get usesScope(): boolean {
    return false;
  }
  get sightType(): "none" {
    return "none";
  }
  /** Марка помогает прицелить бросок, поэтому оставляем её узкой. */
  get spreadDegrees(): number {
    return 0.4;
  }
  get allowSprint(): boolean {
    return !this.pulling && this.throwTimer <= 0;
  }
  get busy(): boolean {
    return this.pulling || this.throwTimer > 0;
  }
  get recoilAim(): AimOffset {
    return ZERO_AIM;
  }
  get viewPunch(): ViewPunch {
    return this.punch.value;
  }
  get isReloading(): boolean {
    return false;
  }
  get reloadProgress(): number {
    return 0;
  }

  refill(): void {
    this.count = this.config.count;
  }

  onEquip(): void {
    this.pulling = false;
    this.pullT = 0;
    this.throwTimer = 0;
    this.pendingThrow = false;
    this.pinPulled = false;
    this.cooldown = 0.2;
    this.punch.reset();
  }

  onHolster(): void {
    this.pulling = false;
    this.pullT = 0;
    this.throwTimer = 0;
    this.pendingThrow = false;
  }

  // -------------------------------------------------------------------- кадр

  updateAim(dt: number, _input: InputManager, _canAct: boolean): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.punch.update(dt);

    const target = this.pulling ? 1 : 0;
    this.pullT = moveTowards(this.pullT, target, dt / 0.16);

    if (this.throwTimer > 0) {
      this.throwTimer = Math.max(0, this.throwTimer - dt);
      // Граната покидает руку в середине анимации.
      if (this.pendingThrow && this.throwTimer <= this.config.throwTime * 0.55) {
        this.pendingThrow = false;
        this.release();
      }
    }
  }

  updateAction(_dt: number, input: InputManager, canAct: boolean): void {
    if (this.count <= 0 || this.cooldown > 0 || this.throwTimer > 0) {
      if (!canAct) this.pulling = false;
      return;
    }

    const strong = canAct && input.isMouseDown(MOUSE_FIRE);
    const weak = canAct && input.isMouseDown(MOUSE_ALT);
    const held = strong || weak;

    if (held && !this.pulling) {
      this.pulling = true;
      this.lobbing = weak && !strong;
      if (!this.pinPulled) {
        this.pinPulled = true;
        this.audio.pinPull();
      }
    } else if (!held && this.pulling) {
      this.pulling = false;
      this.startThrow();
    }
  }

  updateViewModel(dt: number, equipT: number): void {
    this.viewModel.update(dt, {
      adsT: this.pullT,
      sprintT: this.player.sprinting ? 1 : 0,
      speedRatio: this.player.speedRatio,
      grounded: this.player.grounded,
      mouseDX: this.player.mouseDelta.x,
      mouseDY: this.player.mouseDelta.y,
      reloadT: 0,
      reloadEmpty: false,
      equipT,
    });
  }

  // ------------------------------------------------------------------ бросок

  private startThrow(): void {
    this.throwTimer = this.config.throwTime;
    this.pendingThrow = true;
    this.cooldown = this.config.throwTime + this.config.cooldown;
    this.viewModel.playAction(THROW_ANIM, this.config.throwTime * 1.3);
    this.punch.impulse(0.5, 0.25, 0.4);
    this.audio.throwWhoosh();
  }

  private release(): void {
    if (this.count <= 0) return;
    this.count--;
    this.pinPulled = false;

    this.player.getAimForward(this.dir);
    this.player.getAimRight(this.right);
    this.player.getAimUp(this.up);

    // Небольшой подъём траектории, чтобы граната летела дугой, а не строго в пол.
    this.dir.addInPlace(this.up.scale(this.lobbing ? 0.25 : 0.08)).normalize();

    this.origin.copyFrom(this.player.camera.globalPosition);
    this.origin.addInPlace(this.dir.scale(0.45));
    this.origin.addInPlace(this.right.scale(0.12));

    const speed = this.lobbing ? this.config.lobSpeed : this.config.throwSpeed;
    this.grenades.spawn(this.config, this.origin, this.dir, speed, this.player.body.velocity);
    this.viewModel.setMagazineVisible(true);
  }

  /** Прогресс замаха для HUD-подсказки. */
  get pullProgress(): number {
    return clamp01(this.pullT);
  }
}
