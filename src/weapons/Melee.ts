import { AbstractMesh, Mesh, Ray, Scene, Vector3 } from "@babylonjs/core";
import type { InputManager } from "../input/InputManager";
import type { AimOffset, Player } from "../player/Player";
import type { Effects } from "../fx/Effects";
import type { AudioManager } from "../fx/AudioManager";
import type { SurfaceKind } from "../world/Level";
import type { HitZone, TargetManager } from "../world/Targets";
import { ViewPunchSpring, ZERO_AIM, type ViewPunch } from "./Recoil";
import { VIEWMODEL_LAYER, type ActionKey, type ViewModel } from "./ViewModel";
import type { MeleeConfig } from "./WeaponConfig";
import { MOUSE_ALT, MOUSE_FIRE, type HudAmmo, type IWeapon, type SessionStats } from "./Types";

const V = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** Быстрый удар: короткий замах и резкий рез слева направо. */
const LIGHT_SWING: ActionKey[] = [
  { t: 0, pos: Vector3.Zero(), rot: Vector3.Zero() },
  { t: 0.18, pos: V(0.05, 0.02, -0.05), rot: V(-0.2, 0.35, -0.25) },
  { t: 0.42, pos: V(-0.14, -0.03, 0.14), rot: V(0.25, -0.85, 0.55) },
  { t: 0.75, pos: V(-0.04, 0, 0.03), rot: V(0.08, -0.25, 0.18) },
  { t: 1, pos: Vector3.Zero(), rot: Vector3.Zero() },
];

/** Сильный удар: широкий замах через плечо и удар сверху вниз. */
const HEAVY_SWING: ActionKey[] = [
  { t: 0, pos: Vector3.Zero(), rot: Vector3.Zero() },
  { t: 0.26, pos: V(0.1, 0.12, -0.12), rot: V(-0.7, 0.5, -0.4) },
  { t: 0.46, pos: V(-0.1, -0.14, 0.18), rot: V(0.75, -0.6, 0.35) },
  { t: 0.72, pos: V(-0.04, -0.04, 0.06), rot: V(0.25, -0.2, 0.12) },
  { t: 1, pos: Vector3.Zero(), rot: Vector3.Zero() },
];

interface PendingHit {
  timer: number;
  damage: number;
  heavy: boolean;
}

/**
 * Ближний бой. Два удара, как в CS: быстрый по ЛКМ и сильный по ПКМ.
 * Попадание считается не в момент нажатия, а с задержкой — в фазе, когда
 * клинок реально проходит перед игроком.
 */
export class Melee implements IWeapon {
  private cooldown = 0;
  private pending: PendingHit | null = null;
  private lightWasDown = false;
  private heavyWasDown = false;

  private readonly punch = new ViewPunchSpring(180, 14, 3);
  private readonly ray = new Ray(new Vector3(), new Vector3(), 1);
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly probe = new Vector3();

  constructor(
    private readonly config: MeleeConfig,
    readonly viewModel: ViewModel,
    private readonly scene: Scene,
    private readonly player: Player,
    private readonly effects: Effects,
    private readonly audio: AudioManager,
    private readonly targets: TargetManager,
    private readonly stats: SessionStats,
    private readonly onHit?: (zone: HitZone, killed: boolean) => void
  ) {}

  // ---------------------------------------------------------------- состояние

  get slot(): number {
    return this.config.slot;
  }
  get displayName(): string {
    return this.config.name;
  }
  get caliber(): string {
    return "БЛИЖНИЙ БОЙ";
  }
  get hudAmmo(): HudAmmo | null {
    return null;
  }
  get hudCount(): number | null {
    return null;
  }
  get available(): boolean {
    return true;
  }
  get aimProgress(): number {
    return 0;
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
  /** У ножа марка нужна только как точка — берём фиксированный минимум. */
  get spreadDegrees(): number {
    return 0.8;
  }
  get allowSprint(): boolean {
    return this.cooldown <= 0;
  }
  get busy(): boolean {
    return this.pending !== null;
  }
  get recoilAim(): AimOffset {
    return ZERO_AIM;
  }
  get barrelHeat(): number {
    return 0;
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

  onEquip(): void {
    this.cooldown = 0.2;
    this.pending = null;
    this.lightWasDown = true;
    this.heavyWasDown = true;
    this.punch.reset();
  }

  onHolster(): void {
    this.pending = null;
    this.cooldown = 0;
  }

  // -------------------------------------------------------------------- кадр

  updateAim(dt: number, _input: InputManager, _canAct: boolean): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.punch.update(dt);

    if (this.pending) {
      this.pending.timer -= dt;
      if (this.pending.timer <= 0) {
        const { damage, heavy } = this.pending;
        this.pending = null;
        this.resolveSwing(damage, heavy);
      }
    }
  }

  updateAction(_dt: number, input: InputManager, canAct: boolean): void {
    const light = canAct && input.isMouseDown(MOUSE_FIRE);
    const heavy = canAct && input.isMouseDown(MOUSE_ALT);

    const lightPressed = light && !this.lightWasDown;
    const heavyPressed = heavy && !this.heavyWasDown;
    this.lightWasDown = light;
    this.heavyWasDown = heavy;

    if (this.cooldown > 0 || this.pending) return;

    // Быстрый удар можно держать зажатым, сильный — только по нажатию.
    if (heavyPressed) this.swing(true);
    else if (light && (lightPressed || this.config.lightInterval > 0)) this.swing(false);
  }

  updateViewModel(dt: number, equipT: number): void {
    this.viewModel.update(dt, {
      adsT: 0,
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

  // ------------------------------------------------------------------- удар

  private swing(heavy: boolean): void {
    const cfg = this.config;
    const interval = heavy ? cfg.heavyInterval : cfg.lightInterval;
    this.cooldown = interval;
    this.pending = {
      timer: heavy ? cfg.heavyHitDelay : cfg.lightHitDelay,
      damage: heavy ? cfg.heavyDamage : cfg.lightDamage,
      heavy,
    };

    this.viewModel.playAction(heavy ? HEAVY_SWING : LIGHT_SWING, interval * 0.95);
    this.punch.impulse(heavy ? 0.9 : 0.35, heavy ? 0.5 : 0.2, heavy ? 1.2 : 0.5);
    this.audio.knifeSwing(heavy);
  }

  /**
   * Проверяем несколько лучей веером: одиночный луч по центру слишком
   * требователен для ближнего боя.
   */
  private resolveSwing(damage: number, heavy: boolean): void {
    const cfg = this.config;
    this.player.getAimForward(this.fwd);
    this.player.getAimRight(this.right);
    this.player.getAimUp(this.up);

    const origin = this.player.camera.globalPosition;
    const offsets: Array<[number, number]> = [
      [0, 0],
      [0.28, 0],
      [-0.28, 0],
      [0, 0.22],
      [0, -0.22],
    ];

    for (const [rx, ry] of offsets) {
      this.probe.copyFrom(this.fwd);
      this.probe.addInPlace(this.right.scale(rx * 0.35));
      this.probe.addInPlace(this.up.scale(ry * 0.35));
      this.probe.normalize();

      this.ray.origin.copyFrom(origin);
      this.ray.direction.copyFrom(this.probe);
      this.ray.length = cfg.range;

      const pick = this.scene.pickWithRay(this.ray, Melee.hittablePredicate);
      if (!pick?.hit || !pick.pickedPoint || !pick.pickedMesh) continue;

      const mesh = pick.pickedMesh;
      const meta = mesh.metadata as { surface?: SurfaceKind } | undefined;
      const surface: SurfaceKind = meta?.surface ?? "concrete";
      const normal = pick.getNormal(true, true) ?? this.probe.scale(-1);

      const result =
        mesh instanceof Mesh
          ? this.targets.registerHit(mesh, damage, { head: cfg.headMultiplier, limb: 0.85 }, pick.pickedPoint, {
              point: pick.pickedPoint,
              direction: this.probe,
              force: heavy ? 7 : 3.5,
            })
          : null;

      if (result && !result.ignored) {
        this.stats.hits++;
        this.stats.shots++;
        if (result.zone === "head") this.stats.headshots++;
        if (result.killed) this.stats.kills++;
        this.audio.hitmarker(result.zone === "head");
        if (result.killed) this.audio.targetDown();
        this.onHit?.(result.zone, result.killed);
      }

      this.effects.impact(pick.pickedPoint, normal, mesh, surface);
      this.audio.knifeHit(surface, heavy);
      return;
    }

    // Промах по воздуху — только свист клинка, уже сыгранный в swing().
    this.stats.shots++;
  }

  private static hittablePredicate(mesh: AbstractMesh): boolean {
    // У бойцов в модели из GLB зоны поражения — невидимые примитивы под ней:
    // стрелять по ним надо, а рисовать их не нужно.
    const meta = mesh.metadata as { hitProxy?: boolean } | undefined;
    return (
      mesh.isPickable &&
      (mesh.isVisible || meta?.hitProxy === true) &&
      mesh.isEnabled() &&
      mesh.renderingGroupId !== VIEWMODEL_LAYER
    );
  }
}
