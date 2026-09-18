import { AbstractMesh, Mesh, Ray, Scene, Vector3 } from "@babylonjs/core";
import { DEG, clamp01, gaussian, lerp, moveTowards } from "../core/MathUtil";
import type { InputManager } from "../input/InputManager";
import type { AimOffset, Player } from "../player/Player";
import type { Effects } from "../fx/Effects";
import type { AudioManager } from "../fx/AudioManager";
import type { SurfaceKind } from "../world/Level";
import type { HitZone, TargetManager } from "../world/Targets";
import { RecoilController, type ViewPunch } from "./Recoil";
import { VIEWMODEL_LAYER, type ViewModel } from "./ViewModel";
import { shotInterval, type SightType, type WeaponConfig } from "./WeaponConfig";
import { MOUSE_ALT, MOUSE_FIRE, type HudAmmo, type IWeapon, type SessionStats } from "./Types";
import { BOLT_CYCLE } from "./BoltCycle";

export type FirearmState = "ready" | "reloading";

export interface WeaponEvents {
  onHitConfirmed?: (zone: HitZone, killed: boolean) => void;
  onShot?: () => void;
}

interface ReloadPhase {
  at: number;
  fn: () => void;
}

/**
 * Огнестрельное оружие: подача, огонь, разброс, отдача, прицеливание и
 * перезарядка. Один класс обслуживает автомат, болтовую винтовку и пистолет —
 * разница только в конфиге.
 */
export class Firearm implements IWeapon {
  readonly config: WeaponConfig;
  readonly recoil: RecoilController;

  private ammoInMag: number;
  private reserve: number;

  private state: FirearmState = "ready";
  private fireTimer = 0;
  private cycleTimer = 0;
  private cycleDuration = 0;
  private boltPlayed = true;
  private boltClosed = true;
  private timeSinceShot = 10;
  private triggerWasDown = false;
  private dryFired = false;

  private adsT = 0;
  /** Прицеливание — переключатель, а не удержание (как в PUBG). */
  private adsActive = false;
  /** Выбросить гильзу при ближайшем цикле затвора (болтовая винтовка). */
  private ejectOnBolt = false;

  private bloom = 0;

  private reloadTimer = 0;
  private reloadDuration = 0;
  private reloadWasEmpty = false;
  private reloadPhases: ReloadPhase[] = [];
  private reloadPhaseIndex = 0;

  private readonly ray = new Ray(new Vector3(), new Vector3(), 1);
  private readonly dir = new Vector3();
  private readonly muzzlePos = new Vector3();
  private readonly ejectPos = new Vector3();
  private readonly endPoint = new Vector3();
  private readonly camRight = new Vector3();
  private readonly camUp = new Vector3();
  private readonly camFwd = new Vector3();

  constructor(
    config: WeaponConfig,
    readonly viewModel: ViewModel,
    private readonly scene: Scene,
    private readonly player: Player,
    private readonly effects: Effects,
    private readonly audio: AudioManager,
    private readonly targets: TargetManager,
    private readonly stats: SessionStats,
    private readonly events: WeaponEvents = {}
  ) {
    this.config = config;
    this.recoil = new RecoilController(config);
    this.ammoInMag = config.magSize;
    this.reserve = config.reserveAmmo;
  }

  // ---------------------------------------------------------------- состояние

  get slot(): number {
    return this.config.slot;
  }

  get displayName(): string {
    return this.config.name;
  }

  get caliber(): string {
    return this.config.caliber;
  }

  get hudAmmo(): HudAmmo {
    return { mag: this.ammoInMag, reserve: this.reserve, magSize: this.config.magSize };
  }

  get hudCount(): number | null {
    return null;
  }

  get available(): boolean {
    return true;
  }

  get mag(): number {
    return this.ammoInMag;
  }

  get reserveAmmo(): number {
    return this.reserve;
  }

  get isReloading(): boolean {
    return this.state === "reloading";
  }

  get reloadProgress(): number {
    return this.reloadDuration > 0 ? clamp01(this.reloadTimer / this.reloadDuration) : 0;
  }

  get aimProgress(): number {
    return this.adsT;
  }

  get adsFovMul(): number {
    return this.config.adsFovMul;
  }

  get usesScope(): boolean {
    return this.config.scope;
  }

  get sightType(): SightType {
    return this.config.sightType;
  }

  get recoilAim(): AimOffset {
    return this.recoil;
  }

  get barrelHeat(): number {
    return this.recoil.heat;
  }

  get viewPunch(): ViewPunch {
    return this.recoil.view;
  }

  get busy(): boolean {
    return this.state === "reloading";
  }

  /** Текущий полуугол конуса разброса в градусах — им же рисуется марка прицела. */
  get spreadDegrees(): number {
    const cfg = this.config;
    const hip = cfg.spreadBase * cfg.spreadHipMul;
    let spread = lerp(hip, cfg.spreadBase, this.adsT);
    if (this.player.crouching) spread *= cfg.spreadCrouchMul;
    spread += cfg.spreadMoveAdd * this.player.speedRatio;
    if (!this.player.grounded) spread += cfg.spreadAirAdd;
    return spread + this.bloom;
  }

  get allowSprint(): boolean {
    return this.cycleTimer <= 0 && this.timeSinceShot > 0.22 && !this.adsActive;
  }

  /** Включено ли прицеливание (для подсказок и переключения слотов). */
  get isAimingToggled(): boolean {
    return this.adsActive;
  }

  refill(): void {
    this.ammoInMag = this.config.magSize;
    this.reserve = this.config.reserveAmmo;
    this.state = "ready";
    this.reloadTimer = 0;
    this.cancelBoltCycle();
    this.adsActive = false;
    this.adsT = 0;
    this.ejectOnBolt = false;
    this.viewModel.setMagazineVisible(true);
    this.recoil.reset();
  }

  onEquip(): void {
    this.adsT = 0;
    this.adsActive = false;
    this.triggerWasDown = true;
    this.recoil.reset();
    this.bloom = 0;
  }

  onHolster(): void {
    // Перезарядку прерываем — как в большинстве шутеров.
    this.state = "ready";
    this.reloadTimer = 0;
    this.reloadDuration = 0;
    this.adsT = 0;
    this.adsActive = false;
    this.cancelBoltCycle();
    this.ejectOnBolt = false;
    this.viewModel.setMagazineVisible(true);
  }

  // ----------------------------------------------------- фаза 1: прицел/отдача

  updateAim(dt: number, input: InputManager, canAct: boolean): void {
    this.timeSinceShot += dt;
    this.fireTimer = Math.max(0, this.fireTimer - dt);

    if (this.cycleTimer > 0) {
      this.cycleTimer = Math.max(0, this.cycleTimer - dt);
      const progress = 1 - this.cycleTimer / this.cycleDuration;
      if (!this.boltPlayed && progress >= BOLT_CYCLE.eject) {
        this.boltPlayed = true;
        this.audio.boltPull();
        if (this.ejectOnBolt) {
          this.ejectOnBolt = false;
          this.ejectShell();
        }
      }
      if (!this.boltClosed && progress >= BOLT_CYCLE.close) {
        this.boltClosed = true;
        this.audio.boltRelease();
      }
    }

    // Прицел включается нажатием и выключается повторным — удерживать не нужно.
    if (canAct && input.wasMousePressed(MOUSE_ALT)) {
      this.adsActive = !this.adsActive;
      this.audio.adsToggle(this.adsActive);
    }
    if (!canAct || this.state === "reloading") this.adsActive = false;

    const speed = 1 / Math.max(0.01, this.config.adsTime);
    // Keep the player's toggle intent, but lower the scope until the hand is
    // back on the grip. RMB during the cycle can cancel the automatic return.
    const cycling = this.cycleTimer > this.cycleDuration * (1 - BOLT_CYCLE.aim);
    this.adsT = moveTowards(this.adsT, this.adsActive && !cycling ? 1 : 0, speed * dt);

    this.bloom = Math.max(0, this.bloom - this.config.spreadRecovery * dt);
    this.recoil.update(dt);
    this.updateReload(dt, input, canAct);
  }

  // ------------------------------------------------------- фаза 2: стрельба

  updateAction(_dt: number, input: InputManager, canAct: boolean): void {
    const triggerDown = canAct && input.isMouseDown(MOUSE_FIRE);
    const justPressed = triggerDown && !this.triggerWasDown;

    if (!triggerDown) this.dryFired = false;

    const auto = this.config.fireMode === "auto";
    const wantsShot = auto ? triggerDown : justPressed;
    const ready = this.state === "ready" && this.fireTimer <= 0 && this.cycleTimer <= 0;

    if (wantsShot && ready) {
      if (this.ammoInMag > 0) {
        this.shoot();
      } else if (!this.dryFired) {
        this.dryFired = true;
        this.audio.dryFire();
        this.fireTimer = 0.22;
      }
    }

    this.triggerWasDown = triggerDown;
  }

  updateViewModel(dt: number, equipT: number): void {
    this.viewModel.update(dt, {
      adsT: this.adsT,
      sprintT: this.player.sprinting ? 1 : 0,
      speedRatio: this.player.speedRatio,
      grounded: this.player.grounded,
      mouseDX: this.player.mouseDelta.x,
      mouseDY: this.player.mouseDelta.y,
      reloadT: this.state === "reloading" ? this.reloadProgress : 0,
      reloadEmpty: this.reloadWasEmpty,
      equipT,
      boltCycleT: this.cycleTimer > 0 ? 1 - this.cycleTimer / this.cycleDuration : undefined,
    });
  }

  // -------------------------------------------------------------- выстрел

  private shoot(): void {
    const cfg = this.config;
    this.ammoInMag--;
    this.stats.shots++;
    this.fireTimer = shotInterval(cfg);
    this.timeSinceShot = 0;

    if (cfg.fireMode === "bolt") {
      // У болтовой гильза вылетает не с выстрелом, а при передёргивании затвора.
      this.startBoltCycle();
      this.ejectOnBolt = true;
    }

    // Направление берём из «боевых» углов игрока, а не из камеры: тряска,
    // покачивание и дыхание видны на экране, но пулю уводить не должны.
    const camera = this.player.camera;
    this.player.getAimForward(this.camFwd);
    this.player.getAimRight(this.camRight);
    this.player.getAimUp(this.camUp);

    // Разброс: нормальное распределение внутри конуса, ограниченное его краем.
    const spreadRad = this.spreadDegrees * DEG;
    const radius = Math.min(Math.abs(gaussian()) * 0.55, 1.2) * spreadRad;
    const theta = Math.random() * Math.PI * 2;
    const tan = Math.tan(radius);

    this.dir.copyFrom(this.camFwd);
    this.dir.addInPlace(this.camRight.scale(tan * Math.cos(theta)));
    this.dir.addInPlace(this.camUp.scale(tan * Math.sin(theta)));
    this.dir.normalize();

    this.ray.origin.copyFrom(camera.globalPosition);
    this.ray.direction.copyFrom(this.dir);
    this.ray.length = cfg.range;

    const pick = this.scene.pickWithRay(this.ray, Firearm.shootablePredicate);

    // При полном зуме модель спрятана, и дуло брать неоткуда — бьём от камеры.
    if (this.viewModel.isHiddenByScope) {
      this.muzzlePos.copyFrom(this.ray.origin).addInPlace(this.camFwd.scale(0.6));
      this.ejectPos.copyFrom(this.muzzlePos);
    } else {
      this.viewModel.getMuzzleWorldPosition(this.muzzlePos);
      this.viewModel.getEjectWorldPosition(this.ejectPos);
    }

    if (pick?.hit && pick.pickedPoint && pick.pickedMesh) {
      this.endPoint.copyFrom(pick.pickedPoint);
      this.resolveHit(pick.pickedMesh, pick.pickedPoint, pick.getNormal(true, true), pick.distance);
    } else {
      this.endPoint.copyFrom(this.ray.origin).addInPlace(this.dir.scale(cfg.range));
    }

    const recoilMul =
      lerp(1, cfg.recoilAdsMul, this.adsT) *
      (this.player.crouching ? cfg.recoilCrouchMul : 1) *
      (this.player.isMoving ? 1.12 : 1);
    this.recoil.kick(recoilMul);

    // Модель в руках дёргается ровно на ту силу, что ушла в прицел: разогретый
    // ствол и редкие клевки видно по оружию, а не только по крестику.
    const base = cfg.id === "sniper" ? 1.6 : cfg.id === "pistol" ? 0.8 : 1;
    this.viewModel.fire(this.adsT, base * Math.min(2.4, this.recoil.lastKick.strength));
    this.effects.tracer(this.muzzlePos, this.endPoint);
    if (cfg.fireMode !== "bolt") this.ejectShell();
    this.audio.shot(cfg.sound);

    this.bloom = Math.min(cfg.spreadMax, this.bloom + cfg.spreadPerShot);
    this.events.onShot?.();
  }

  /** Выброс стреляной гильзы из окна экстракции. */
  private ejectShell(): void {
    this.player.getAimForward(this.camFwd);
    this.player.getAimRight(this.camRight);
    this.player.getAimUp(this.camUp);
    this.viewModel.getEjectWorldPosition(this.ejectPos);
    this.effects.ejectShell(this.ejectPos, this.camRight, this.camUp, this.camFwd, this.config.id);
    this.audio.shellEject();
  }

  private resolveHit(mesh: AbstractMesh, point: Vector3, normal: Vector3 | null, distance: number): void {
    const n = normal ?? this.dir.scale(-1);
    const meta = mesh.metadata as { surface?: SurfaceKind } | undefined;
    const surface: SurfaceKind = meta?.surface ?? "concrete";

    const result =
      mesh instanceof Mesh
        ? this.targets.registerHit(
            mesh,
            this.config.damage,
            { head: this.config.headMultiplier, limb: this.config.limbMultiplier },
            point,
            // Импульс для рэгдолла: у снайперки он заметно сильнее.
            { point, direction: this.dir, force: this.config.id === "sniper" ? 9 : this.config.id === "pistol" ? 4 : 5.5 }
          )
        : null;

    if (result && !result.ignored) {
      this.stats.hits++;
      if (result.zone === "head") this.stats.headshots++;
      if (result.killed) this.stats.kills++;
      this.audio.hitmarker(result.zone === "head");
      if (result.killed) this.audio.targetDown();
      this.events.onHitConfirmed?.(result.zone, result.killed);
    }

    this.effects.impact(point, n, mesh, surface);
    this.audio.impact(surface, distance);
  }

  private static shootablePredicate(mesh: AbstractMesh): boolean {
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

  // ----------------------------------------------------------- перезарядка

  private updateReload(dt: number, input: InputManager, canAct: boolean): void {
    if (canAct && input.wasPressed("reload")) this.tryStartReload();

    if (this.state !== "reloading") return;

    this.reloadTimer += dt;
    const t = this.reloadProgress;

    while (this.reloadPhaseIndex < this.reloadPhases.length && t >= this.reloadPhases[this.reloadPhaseIndex]!.at) {
      this.reloadPhases[this.reloadPhaseIndex]!.fn();
      this.reloadPhaseIndex++;
    }

    if (this.reloadTimer >= this.reloadDuration) this.finishReload();
  }

  tryStartReload(): boolean {
    if (this.state === "reloading") return false;
    if (this.reserve <= 0) return false;
    if (this.ammoInMag >= this.config.magSize) return false;

    this.reloadWasEmpty = this.ammoInMag === 0;
    this.reloadDuration = this.reloadWasEmpty ? this.config.reloadEmptyTime : this.config.reloadTime;
    this.reloadTimer = 0;
    this.reloadPhaseIndex = 0;
    this.state = "reloading";
    this.adsActive = false;
    this.cancelBoltCycle();

    // Раскадровка: отсоединение магазина -> сброс -> установка -> затвор.
    this.reloadPhases = [
      {
        at: 0.2,
        fn: () => {
          this.audio.magOut();
          this.viewModel.dropMagazine();
          this.viewModel.setMagazineVisible(false);
        },
      },
      { at: 0.33, fn: () => this.audio.magDrop() },
      {
        at: 0.55,
        fn: () => {
          this.viewModel.setMagazineVisible(true);
          this.audio.magIn();
        },
      },
    ];

    if (this.reloadWasEmpty && this.config.fireMode !== "bolt") {
      this.reloadPhases.push({ at: 0.74, fn: () => this.audio.boltPull() });
      this.reloadPhases.push({ at: 0.82, fn: () => this.audio.boltRelease() });
    }

    return true;
  }

  private finishReload(): void {
    const need = this.config.magSize - this.ammoInMag;
    const take = Math.min(need, this.reserve);
    this.ammoInMag += take;
    this.reserve -= take;

    this.state = "ready";
    this.reloadTimer = 0;
    this.reloadDuration = 0;
    this.viewModel.setMagazineVisible(true);
    this.recoil.reset();

    // Chamber a round after changing magazines. Eject only if a spent case
    // remains from a shot whose cycle was interrupted by this reload.
    if (this.config.fireMode === "bolt") {
      this.startBoltCycle();
    }
  }

  private startBoltCycle(): void {
    this.cycleDuration = Math.max(0.01, this.config.cycleTime);
    this.cycleTimer = this.cycleDuration;
    this.boltPlayed = false;
    this.boltClosed = false;
  }

  private cancelBoltCycle(): void {
    this.cycleTimer = 0;
    this.cycleDuration = 0;
    this.boltPlayed = true;
    this.boltClosed = true;
    this.viewModel.resetBoltCycle();
  }
}
