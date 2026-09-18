import {
  Color3,
  Mesh,
  MeshBuilder,
  type Node,
  PointLight,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { clamp01, damp, lerp, randRange, smoothstep, spring } from "../core/MathUtil";
import type { TextureLibrary } from "../world/Textures";
import { sampleBoltCycle } from "./BoltCycle";
import type { FpsArms } from "./FpsArms";
import {
  buildHands,
  createWeaponModel,
  ModelFactory,
  VIEWMODEL_LAYER,
  type WeaponModel,
  type WeaponModelKind,
} from "./models";

export { VIEWMODEL_LAYER } from "./models";

export interface ViewModelContext {
  adsT: number;
  sprintT: number;
  speedRatio: number;
  grounded: boolean;
  mouseDX: number;
  mouseDY: number;
  /** 0..1 — прогресс перезарядки (0, если не перезаряжаем). */
  reloadT: number;
  reloadEmpty: boolean;
  /** 0 — оружие убрано, 1 — в руках. */
  equipT: number;
  /** Undefined when idle; 0..1 is the firearm's manual bolt-action timeline. */
  boltCycleT?: number;
}

/** Ключевой кадр анимации: смещение относительно базовой позы. */
export interface ActionKey {
  t: number;
  pos: Vector3;
  rot: Vector3;
}

const ZERO_KEY: ActionKey = { t: 0, pos: Vector3.Zero(), rot: Vector3.Zero() };

/** Тактическая перезарядка: рука уходит за магазином и возвращается на цевьё. */
const RELOAD_ARM_TACTICAL: ActionKey[] = [
  ZERO_KEY,
  { t: 0.2, pos: new Vector3(0.02, -0.1, -0.24), rot: new Vector3(-0.1, -0.25, 0.18) },
  { t: 0.37, pos: new Vector3(0.03, -0.24, -0.3), rot: new Vector3(-0.25, -0.35, 0.26) },
  { t: 0.56, pos: new Vector3(0.02, -0.09, -0.23), rot: new Vector3(-0.1, -0.25, 0.18) },
  { t: 0.72, pos: new Vector3(0, -0.03, -0.12), rot: new Vector3(-0.05, -0.14, 0.09) },
  { t: 0.88, pos: Vector3.Zero(), rot: Vector3.Zero() },
  { t: 1, pos: Vector3.Zero(), rot: Vector3.Zero() },
];

/** С пустым магазином добавляется движение к рукоятке взведения. */
const RELOAD_ARM_EMPTY: ActionKey[] = [
  ZERO_KEY,
  { t: 0.18, pos: new Vector3(0.02, -0.1, -0.24), rot: new Vector3(-0.1, -0.25, 0.18) },
  { t: 0.34, pos: new Vector3(0.03, -0.24, -0.3), rot: new Vector3(-0.25, -0.35, 0.26) },
  { t: 0.52, pos: new Vector3(0.02, -0.09, -0.23), rot: new Vector3(-0.1, -0.25, 0.18) },
  { t: 0.68, pos: new Vector3(0.01, -0.02, -0.2), rot: new Vector3(-0.02, -0.3, 0.12) },
  { t: 0.78, pos: new Vector3(0.015, 0.03, -0.3), rot: new Vector3(0.12, -0.5, 0.14) },
  { t: 0.9, pos: Vector3.Zero(), rot: Vector3.Zero() },
  { t: 1, pos: Vector3.Zero(), rot: Vector3.Zero() },
];

/** Поза в момент `t` по набору ключевых кадров. */
export function sampleKeys(keys: ActionKey[], t: number, outPos: Vector3, outRot: Vector3): void {
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t <= b.t) {
      const w = smoothstep((t - a.t) / Math.max(1e-4, b.t - a.t));
      Vector3.LerpToRef(a.pos, b.pos, w, outPos);
      Vector3.LerpToRef(a.rot, b.rot, w, outRot);
      return;
    }
  }
  const last = keys[keys.length - 1]!;
  outPos.copyFrom(last.pos);
  outRot.copyFrom(last.rot);
}

interface FallingMag {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
  life: number;
}

/**
 * Анимация оружия в руках: инерция от мыши, покачивание при ходьбе, отдача,
 * цикл затвора, перезарядка, доставание/убирание и произвольные действия
 * (удар ножом, бросок гранаты). Геометрию поставляет `models.ts`.
 */
export class ViewModel {
  readonly root: TransformNode;
  readonly model: WeaponModel;

  private readonly leftArm: TransformNode;
  private readonly rightArm: TransformNode;
  /** Общая рига рук; пока оружие в руках, она висит на этом вьюмодели. */
  private readonly arms: FpsArms | null;
  /** Куда вернуть ствол, когда ригу заберёт другое оружие. */
  private readonly bodyRest: { pos: Vector3; rot: Vector3 };
  private readonly allMeshes: Mesh[] = [];
  private readonly flashPlane: Mesh | null = null;
  private readonly flashLight: PointLight | null = null;
  private readonly fillLight: PointLight;

  private readonly fallingMags: FallingMag[] = [];

  // Пружины отдачи.
  private kickPos = 0;
  private kickPosVel = 0;
  private kickRot = 0;
  private kickRotVel = 0;
  private kickRoll = 0;
  private kickRollVel = 0;

  private boltT = 0;
  private boltTravel = 0.032;
  private readonly boltRest: number;
  private readonly boltRestRoll: number;
  private readonly chargingHandleRest: number;
  private flashT = 0;
  private bobPhase = 0;
  private idlePhase = Math.random() * 6;

  private actionKeys: ActionKey[] | null = null;
  private actionTime = 0;
  private actionDuration = 0;

  private adsHidden = false;

  private readonly sway = { x: 0, y: 0, rx: 0, ry: 0, rz: 0 };
  private readonly curPos = new Vector3();
  private readonly curRot = new Vector3();
  private readonly tmpPos = new Vector3();
  private readonly tmpRot = new Vector3();
  private readonly actionPos = new Vector3();
  private readonly actionRot = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpScale = new Vector3();
  private readonly tmpVec = new Vector3();
  private readonly adsSolve = new Vector3();
  private readonly armTargetPos = new Vector3();
  private readonly armTargetRot = new Vector3();

  constructor(
    scene: Scene,
    parent: Node,
    factory: ModelFactory,
    kind: WeaponModelKind,
    textures: TextureLibrary,
    hasMuzzleFlash: boolean,
    arms: FpsArms | null = null
  ) {
    this.root = new TransformNode(`vm-root-${kind}`, scene);
    this.root.parent = parent;

    this.model = createWeaponModel(kind, scene, this.root, factory);
    this.allMeshes.push(...this.model.meshes);
    this.boltRest = this.model.bolt ? this.model.bolt.position.z : 0;
    this.boltRestRoll = this.model.bolt?.rotation.z ?? 0;
    this.chargingHandleRest = this.model.chargingHandle?.position.z ?? 0;

    this.leftArm = new TransformNode("vm-left-arm", scene);
    this.leftArm.parent = this.model.body;
    this.rightArm = new TransformNode("vm-right-arm", scene);
    this.rightArm.parent = this.model.body;

    // Рига рук заменяет процедурные кисти: оружие держат настоящие анимированные
    // кисти, поэтому строить перчатки из примитивов больше незачем.
    this.arms = arms && this.model.hands.rig ? arms : null;
    this.bodyRest = { pos: this.model.body.position.clone(), rot: this.model.body.rotation.clone() };
    if (!this.arms) {
      this.allMeshes.push(...buildHands(scene, factory, this.model.hands, this.leftArm, this.rightArm));
    }

    if (hasMuzzleFlash) {
      const flash = MeshBuilder.CreatePlane("vm-flash", { size: 0.34 }, scene);
      flash.parent = this.model.muzzle;
      flash.position.set(0, 0, 0.04);
      flash.billboardMode = Mesh.BILLBOARDMODE_ALL;
      flash.renderingGroupId = VIEWMODEL_LAYER;
      flash.isPickable = false;
      flash.applyFog = false;
      flash.isVisible = false;
      const flashMat = new StandardMaterial(`mat-vm-flash-${kind}`, scene);
      flashMat.emissiveTexture = textures.flash;
      flashMat.opacityTexture = textures.flash;
      flashMat.diffuseColor = Color3.Black();
      flashMat.specularColor = Color3.Black();
      flashMat.disableLighting = true;
      flashMat.backFaceCulling = false;
      flash.material = flashMat;
      this.flashPlane = flash;

      const light = new PointLight(`vm-flash-light-${kind}`, new Vector3(0, 0, 0), scene);
      light.parent = this.model.muzzle;
      light.diffuse = new Color3(1, 0.82, 0.5);
      light.intensity = 0;
      light.range = 14;
      this.flashLight = light;
    }

    // Подсветка только вьюмодели — иначе ствол проваливается в тень навеса.
    this.fillLight = new PointLight(`vm-fill-${kind}`, new Vector3(0.2, 0.3, -0.2), scene);
    this.fillLight.parent = parent;
    this.fillLight.diffuse = new Color3(0.85, 0.88, 0.95);
    this.fillLight.intensity = 1.15;
    this.fillLight.range = 5;
    this.fillLight.includedOnlyMeshes = this.arms ? [...this.allMeshes, ...this.arms.meshes] : this.allMeshes;

    this.curPos.copyFrom(this.model.poses.hip.pos);
    this.curRot.copyFrom(this.model.poses.hip.rot);
    this.root.setEnabled(false);
    this.fillLight.setEnabled(false);
  }

  // ------------------------------------------------------------------ события

  setActive(active: boolean): void {
    this.root.setEnabled(active);
    this.fillLight.setEnabled(active);
    if (this.arms) {
      const body = this.model.body;
      if (active) {
        // Ригу забирает то оружие, которое сейчас в руках. Ствол живёт в
        // держателе рядом с ригой, а его позу каждый кадр считают по кистям.
        this.arms.attachTo(this.root);
        this.arms.clearAction();
        this.arms.setVisible(true);
        body.parent = this.arms.mount;
        this.arms.hold(this.model);
      } else if (body.parent === this.arms.mount) {
        this.arms.hold(null);
        body.parent = this.root;
        body.rotationQuaternion = null;
        body.position.copyFrom(this.bodyRest.pos);
        body.rotation.copyFrom(this.bodyRest.rot);
        if (this.arms.attachedTo === this.root) this.arms.attachTo(null);
      }
    }
    if (!active) {
      this.resetBoltCycle();
      this.actionKeys = null;
      this.flashT = 0;
      if (this.flashPlane) this.flashPlane.isVisible = false;
      if (this.flashLight) this.flashLight.intensity = 0;
    }
  }

  /** Импульс отдачи вьюмодели; в прицеле он заметно слабее. */
  fire(adsT: number, strength = 1): void {
    const scale = lerp(1, 0.45, adsT) * strength;
    // Клип отдачи рук держим чуть дольше интервала между выстрелами, иначе в
    // автоматическом огне руки успевают вернуться в покой между импульсами.
    this.arms?.trigger("fire", 0.13);
    this.kickPosVel -= randRange(1.5, 2.1) * scale;
    this.kickRotVel -= randRange(5.5, 7.5) * scale;
    this.kickRollVel += randRange(-4, 4) * scale;
    // A manual bolt remains locked during firing; only the hand opens it.
    this.boltT = this.model.manualBolt ? 0 : 1;
    this.boltTravel = 0.032;

    if (this.flashPlane && this.flashLight) {
      this.flashT = 1;
      this.flashPlane.isVisible = !this.adsHidden;
      this.flashPlane.rotation.z = Math.random() * Math.PI;
      const s = randRange(0.75, 1.25) * strength;
      this.flashPlane.scaling.set(s, s, s);
      this.flashLight.intensity = 4.5 * strength;
    }
  }

  /** Clear an interrupted cycle on holster, reload, death or session reset. */
  resetBoltCycle(): void {
    if (!this.model.manualBolt) return;
    this.boltT = 0;
    this.rightArm.position.setAll(0);
    this.rightArm.rotation.setAll(0);
    if (this.model.bolt) {
      this.model.bolt.position.z = this.boltRest;
      this.model.bolt.rotation.z = this.boltRestRoll;
    }
  }

  /** Проиграть анимацию действия: смещения накладываются поверх базовой позы. */
  playAction(keys: ActionKey[], duration: number): void {
    this.actionKeys = keys;
    this.actionDuration = Math.max(0.01, duration);
    this.actionTime = 0;
  }

  setMagazineVisible(visible: boolean): void {
    if (this.model.magazine) this.model.magazine.isVisible = visible;
  }

  /** Отстёгнутый магазин падает на землю — отдельный меш в мировых координатах. */
  dropMagazine(): void {
    const source = this.model.magazine;
    if (!source) return;

    source.getWorldMatrix().decompose(this.tmpScale, this.tmpQuat, this.tmpPos);

    const mesh = source.clone("dropped-mag", null);
    mesh.parent = null;
    mesh.renderingGroupId = 0;
    mesh.isVisible = true;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.position.copyFrom(this.tmpPos);
    mesh.rotationQuaternion = this.tmpQuat.clone();
    mesh.scaling.copyFrom(this.tmpScale);

    const forward = this.root.getDirection(Vector3.Forward()).normalize();
    this.fallingMags.push({
      mesh,
      velocity: forward.scale(randRange(0.4, 0.9)).add(new Vector3(0, -0.4, 0)),
      spin: new Vector3(randRange(-6, 6), randRange(-6, 6), randRange(-6, 6)),
      life: 3,
    });
  }

  getMuzzleWorldPosition(out: Vector3): Vector3 {
    return out.copyFrom(this.model.muzzle.getAbsolutePosition());
  }

  getEjectWorldPosition(out: Vector3): Vector3 {
    return out.copyFrom(this.model.ejectPort.getAbsolutePosition());
  }

  /** Скрыта ли модель (оптический прицел закрывает обзор собой). */
  get isHiddenByScope(): boolean {
    return this.adsHidden;
  }

  // --------------------------------------------------------------------- кадр

  update(dt: number, ctx: ViewModelContext): void {
    this.updateScopeVisibility(ctx);
    this.updateSway(dt, ctx);
    this.updateSprings(dt);
    this.updateAction(dt);
    // Руки считаем до позы: прицеливание опирается на то, где оказалась марка.
    if (this.arms && this.arms.attachedTo === this.root) {
      this.arms.update(dt, {
        speedRatio: ctx.speedRatio,
        sprintT: ctx.sprintT,
        adsT: ctx.adsT,
        reloadT: ctx.reloadT,
        reloadEmpty: ctx.reloadEmpty,
        equipT: ctx.equipT,
        boltCycleT: ctx.boltCycleT,
      });
    }
    this.composePose(dt, ctx);
    this.updateLeftArm(dt, ctx);
    this.updateManualBolt(ctx);
    this.updateChargingHandle(ctx);
    this.updateFlash(dt);
    this.updateFallingMags(dt);
  }

  /** Модель с оптикой при полном прицеливании прячется — её заменяет оверлей. */
  private updateScopeVisibility(ctx: ViewModelContext): void {
    const hide = this.model.hideOnAds && ctx.adsT > 0.82;
    if (hide === this.adsHidden) return;
    this.adsHidden = hide;
    for (const m of this.allMeshes) m.isVisible = !hide;
    this.arms?.setVisible(!hide);
    if (hide && this.flashPlane) this.flashPlane.isVisible = false;
  }

  private updateSway(dt: number, ctx: ViewModelContext): void {
    // Инерция: ствол «отстаёт» от поворота камеры.
    const damping = lerp(11, 20, ctx.adsT);
    const scale = lerp(1, 0.28, ctx.adsT);
    const tx = clamp01(Math.abs(ctx.mouseDX) / 60) * Math.sign(ctx.mouseDX) * 0.035 * scale;
    const ty = clamp01(Math.abs(ctx.mouseDY) / 60) * Math.sign(ctx.mouseDY) * 0.03 * scale;

    this.sway.x = damp(this.sway.x, -tx, damping, dt);
    this.sway.y = damp(this.sway.y, ty, damping, dt);
    this.sway.ry = damp(this.sway.ry, -tx * 3.2, damping, dt);
    this.sway.rx = damp(this.sway.rx, ty * 3.4, damping, dt);
    this.sway.rz = damp(this.sway.rz, tx * 5.5, damping, dt);
  }

  private updateSprings(dt: number): void {
    [this.kickPos, this.kickPosVel] = spring(this.kickPos, this.kickPosVel, 0, 260, 21, dt);
    [this.kickRot, this.kickRotVel] = spring(this.kickRot, this.kickRotVel, 0, 300, 22, dt);
    [this.kickRoll, this.kickRollVel] = spring(this.kickRoll, this.kickRollVel, 0, 220, 20, dt);

    const bolt = this.model.bolt;
    if (!bolt || this.model.manualBolt) return;
    if (this.boltT > 0) {
      this.boltT = Math.max(0, this.boltT - dt / 0.055);
      // Затвор уходит назад и возвращается за один цикл.
      bolt.position.z = this.boltRest - Math.sin((1 - this.boltT) * Math.PI) * this.boltTravel;
    } else if (bolt.position.z !== this.boltRest) {
      bolt.position.z = this.boltRest;
    }
  }

  private updateAction(dt: number): void {
    if (!this.actionKeys) {
      this.actionPos.setAll(0);
      this.actionRot.setAll(0);
      return;
    }
    this.actionTime += dt;
    const t = clamp01(this.actionTime / this.actionDuration);
    sampleKeys(this.actionKeys, t, this.actionPos, this.actionRot);
    if (t >= 1) this.actionKeys = null;
  }

  private composePose(dt: number, ctx: ViewModelContext): void {
    const poses = this.model.poses;

    // Базовая поза: бедро -> прицел -> бег -> перезарядка (приоритет по возрастанию).
    this.tmpPos.copyFrom(poses.hip.pos);
    this.tmpRot.copyFrom(poses.hip.rot);

    const ads = smoothstep(ctx.adsT);
    Vector3.LerpToRef(this.tmpPos, this.adsPosition(poses.ads.pos), ads, this.tmpPos);
    Vector3.LerpToRef(this.tmpRot, poses.ads.rot, ads, this.tmpRot);

    const sprint = ctx.sprintT * (1 - ads);
    Vector3.LerpToRef(this.tmpPos, poses.sprint.pos, sprint, this.tmpPos);
    Vector3.LerpToRef(this.tmpRot, poses.sprint.rot, sprint, this.tmpRot);

    if (ctx.boltCycleT !== undefined && this.model.manualBolt) {
      const weight = sampleBoltCycle(ctx.boltCycleT).pose;
      // Roll the action toward the camera while the left hand supports it.
      this.tmpPos.addInPlaceFromFloats(-0.035 * weight, -0.012 * weight, 0.035 * weight);
      this.tmpRot.y -= 0.12 * weight;
      this.tmpRot.z -= 0.23 * weight;
    }

    if (ctx.reloadT > 0) {
      // Ствол уходит вниз-влево в начале и возвращается в конце анимации.
      const w =
        ctx.reloadT < 0.18
          ? smoothstep(ctx.reloadT / 0.18)
          : ctx.reloadT > 0.82
            ? smoothstep((1 - ctx.reloadT) / 0.18)
            : 1;
      Vector3.LerpToRef(this.tmpPos, poses.reload.pos, w, this.tmpPos);
      Vector3.LerpToRef(this.tmpRot, poses.reload.rot, w, this.tmpRot);
    }

    // Покачивание при ходьбе.
    const bobScale = ctx.speedRatio * (ctx.grounded ? 1 : 0.2) * lerp(1, 0.22, ads) * ctx.equipT;
    this.bobPhase += dt * lerp(6, 11, ctx.speedRatio) * (ctx.speedRatio > 0.02 ? 1 : 0);
    this.idlePhase += dt * 1.1;

    const bobX = Math.sin(this.bobPhase) * 0.016 * bobScale;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * 0.013 * bobScale;
    const bobRoll = Math.sin(this.bobPhase) * 0.05 * bobScale;

    // Дыхание в покое.
    const idle = (1 - ctx.speedRatio) * lerp(1, 0.35, ads);
    const idleX = Math.sin(this.idlePhase * 0.9) * 0.0025 * idle;
    const idleY = Math.sin(this.idlePhase * 1.4 + 0.7) * 0.002 * idle;

    this.tmpPos.x += this.sway.x + bobX + idleX + this.actionPos.x;
    this.tmpPos.y += this.sway.y + bobY + idleY + this.actionPos.y;
    this.tmpPos.z += this.kickPos * 0.035 + this.actionPos.z;
    this.tmpPos.y += this.kickPos * -0.008;

    this.tmpRot.x += this.sway.rx + this.kickRot * 0.05 + this.actionRot.x;
    this.tmpRot.y += this.sway.ry + this.actionRot.y;
    this.tmpRot.z += this.sway.rz + bobRoll + this.kickRoll * 0.02 + this.actionRot.z;

    // Доставание/убирание: оружие уводится вниз и разворачивается.
    const hidden = 1 - clamp01(ctx.equipT);
    this.tmpPos.y -= hidden * 0.34;
    this.tmpPos.z -= hidden * 0.06;
    this.tmpRot.x += hidden * 0.7;
    this.tmpRot.z += hidden * 0.35;

    // Сглаживание перехода между позами.
    const follow = 26;
    this.curPos.x = damp(this.curPos.x, this.tmpPos.x, follow, dt);
    this.curPos.y = damp(this.curPos.y, this.tmpPos.y, follow, dt);
    this.curPos.z = damp(this.curPos.z, this.tmpPos.z, follow, dt);
    this.curRot.x = damp(this.curRot.x, this.tmpRot.x, follow, dt);
    this.curRot.y = damp(this.curRot.y, this.tmpRot.y, follow, dt);
    this.curRot.z = damp(this.curRot.z, this.tmpRot.z, follow, dt);

    this.root.position.copyFrom(this.curPos);
    this.root.rotation.copyFrom(this.curRot);
  }

  /**
   * Куда увести ригу при прицеливании. С анимированными руками фиксированная
   * поза не годится: кисти живут своей жизнью, и марка уезжала бы с центра.
   * Поэтому каждый кадр гасим её собственное смещение по горизонтали и
   * вертикали — марка садится ровно на перекрестье.
   */
  private adsPosition(fallback: Vector3): Vector3 {
    if (!this.arms || !this.model.sight) return fallback;
    this.arms.sightInRoot(this.model, this.adsSolve);
    this.adsSolve.set(-this.adsSolve.x, -this.adsSolve.y, fallback.z);
    return this.adsSolve;
  }

  /** Левая рука снимает и ставит магазин, затем возвращается на цевьё. */
  private updateLeftArm(dt: number, ctx: ViewModelContext): void {
    if (this.arms || !this.model.hands.left) return;

    if (ctx.reloadT > 0) {
      sampleKeys(
        ctx.reloadEmpty ? RELOAD_ARM_EMPTY : RELOAD_ARM_TACTICAL,
        ctx.reloadT,
        this.armTargetPos,
        this.armTargetRot
      );
    } else {
      this.armTargetPos.setAll(0);
      this.armTargetRot.setAll(0);
    }

    const k = 20;
    const pos = this.leftArm.position;
    const rot = this.leftArm.rotation;
    pos.set(
      damp(pos.x, this.armTargetPos.x, k, dt),
      damp(pos.y, this.armTargetPos.y, k, dt),
      damp(pos.z, this.armTargetPos.z, k, dt)
    );
    rot.set(
      damp(rot.x, this.armTargetRot.x, k, dt),
      damp(rot.y, this.armTargetRot.y, k, dt),
      damp(rot.z, this.armTargetRot.z, k, dt)
    );
  }

  private updateFlash(dt: number): void {
    if (this.flashT <= 0 || !this.flashPlane || !this.flashLight) return;
    this.flashT = Math.max(0, this.flashT - dt / 0.035);
    this.flashLight.intensity = this.flashT * 4.5;
    if (this.flashT <= 0) {
      this.flashPlane.isVisible = false;
      this.flashLight.intensity = 0;
    }
  }

  private updateManualBolt(ctx: ViewModelContext): void {
    const setup = this.model.manualBolt, bolt = this.model.bolt, hand = this.model.hands.right;
    if (!setup || !bolt || !hand) return;
    if (ctx.boltCycleT === undefined) { this.resetBoltCycle(); return; }
    const { grip, lift, pull } = sampleBoltCycle(ctx.boltCycleT);
    bolt.position.z = this.boltRest - pull * setup.travel;
    bolt.rotation.z = this.boltRestRoll + lift * setup.liftAngle;

    // The hand follows the actual handle, including its upward rotation and
    // rearward travel. Both forearm and glove remain on the same animation node.
    const angle = bolt.rotation.z;
    const target = new Vector3(
      bolt.position.x + setup.handle.x * Math.cos(angle) - setup.handle.y * Math.sin(angle),
      bolt.position.y + setup.handle.x * Math.sin(angle) + setup.handle.y * Math.cos(angle),
      bolt.position.z + setup.handle.z,
    );
    const armRotation = new Vector3(0.3, -0.12, 0.12 + lift * 0.45);
    const palm = new Vector3(0.006, -0.01, 0.026);
    palm.rotateByQuaternionToRef(Quaternion.FromEulerVector(hand.rot), palm).addInPlace(hand.pos);
    palm.rotateByQuaternionToRef(Quaternion.FromEulerVector(armRotation), palm);
    this.rightArm.position.copyFrom(target.subtract(palm).scaleInPlace(grip));
    this.rightArm.rotation.copyFrom(armRotation.scaleInPlace(grip));
  }

  private updateChargingHandle(ctx: ViewModelContext): void {
    const handle = this.model.chargingHandle;
    if (!handle) return;
    const t = ctx.reloadT;
    const pull = ctx.reloadEmpty && t >= 0.74 && t <= 0.84
      ? t < 0.8 ? smoothstep((t - 0.74) / 0.06) : 1 - smoothstep((t - 0.8) / 0.04)
      : 0;
    handle.position.z = this.chargingHandleRest - pull * 0.045;
  }

  private updateFallingMags(dt: number): void {
    for (let i = this.fallingMags.length - 1; i >= 0; i--) {
      const m = this.fallingMags[i]!;
      m.life -= dt;
      if (m.life <= 0) {
        m.mesh.dispose();
        this.fallingMags.splice(i, 1);
        continue;
      }
      m.velocity.y -= 19.5 * dt;
      m.mesh.position.addInPlace(this.tmpVec.copyFrom(m.velocity).scaleInPlace(dt));
      if (m.mesh.rotationQuaternion) {
        const delta = Quaternion.RotationYawPitchRoll(m.spin.y * dt, m.spin.x * dt, m.spin.z * dt);
        m.mesh.rotationQuaternion.multiplyInPlace(delta);
      }
      if (m.mesh.position.y < 0.04) {
        m.mesh.position.y = 0.04;
        m.velocity.scaleInPlace(0);
        m.spin.scaleInPlace(0);
      }
    }
  }

  dispose(): void {
    for (const m of this.fallingMags) m.mesh.dispose();
    this.fallingMags.length = 0;
    this.root.dispose(false, true);
  }
}
