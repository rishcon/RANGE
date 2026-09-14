import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { clamp01, damp, lerp, randRange, spring } from "../core/MathUtil";

export type HitZone = "head" | "chest" | "limb" | "plate";

export interface HitResult {
  damage: number;
  zone: HitZone;
  killed: boolean;
  /** Мишень уже была "мертва" — попадание не засчитывается. */
  ignored: boolean;
}

export interface DamageMultipliers {
  head: number;
  limb: number;
}

/**
 * Всё, во что можно попасть: манекены, стальные плиты и живые бойцы.
 * Меш хранит ссылку на владельца в `metadata`, поэтому система попаданий
 * одинаково работает с любой сущностью.
 */
/** Где и чем прилетело — нужно для импульса рэгдолла. */
export interface HitContext {
  point: Vector3;
  direction: Vector3;
  /** Сила толчка, м/с. */
  force: number;
}

export interface IHittable {
  readonly dead: boolean;
  applyHit(damage: number, zone: HitZone, hit?: HitContext): HitResult;
  /** Центр массы — по нему считается урон от взрыва. */
  getCenter(out: Vector3): Vector3;
}

interface TargetMeta {
  surface: "dummy" | "metal";
  zone: HitZone;
  hittable: IHittable;
}

const RESPAWN_DELAY = 4.5;

/** Ростовой манекен с зонами поражения и реакцией на попадания. */
class Dummy {
  readonly root: TransformNode;
  readonly meshes: Mesh[] = [];
  health = 100;
  dead = false;

  private deadTimer = 0;
  private fallT = 0;
  private reactAngle = 0;
  private reactVel = 0;
  private flash = 0;
  private readonly fallRoll: number;
  private readonly material: StandardMaterial;
  private readonly baseColor: Color3;

  constructor(scene: Scene, position: Vector3, yaw: number, tone: number) {
    this.root = new TransformNode("dummy", scene);
    this.root.position.copyFrom(position);
    this.root.rotation.y = yaw;
    this.fallRoll = randRange(-0.35, 0.35);

    this.baseColor = new Color3(0.62 * tone, 0.55 * tone, 0.4 * tone);
    this.material = new StandardMaterial("mat-dummy", scene);
    this.material.diffuseColor = this.baseColor;
    this.material.specularColor = new Color3(0.05, 0.05, 0.05);
    this.material.specularPower = 16;

    const part = (mesh: Mesh, zone: HitZone): Mesh => {
      mesh.parent = this.root;
      mesh.material = this.material;
      mesh.checkCollisions = false;
      mesh.isPickable = true;
      mesh.receiveShadows = true;
      const meta: TargetMeta = { surface: "dummy", zone, hittable: this };
      mesh.metadata = meta;
      this.meshes.push(mesh);
      return mesh;
    };

    // Ноги.
    for (const dx of [-0.11, 0.11]) {
      const leg = MeshBuilder.CreateCylinder("leg", { diameter: 0.17, height: 0.82, tessellation: 10 }, scene);
      leg.position.set(dx, 0.41, 0);
      part(leg, "limb");
    }
    // Таз.
    const pelvis = MeshBuilder.CreateBox("pelvis", { width: 0.36, height: 0.26, depth: 0.22 }, scene);
    pelvis.position.set(0, 0.95, 0);
    part(pelvis, "chest");
    // Корпус.
    const torso = MeshBuilder.CreateBox("torso", { width: 0.44, height: 0.5, depth: 0.25 }, scene);
    torso.position.set(0, 1.32, 0);
    part(torso, "chest");
    // Плечи.
    const shoulders = MeshBuilder.CreateCylinder("shoulders", { diameter: 0.19, height: 0.52, tessellation: 10 }, scene);
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.set(0, 1.53, 0);
    part(shoulders, "chest");
    // Руки.
    for (const dx of [-0.28, 0.28]) {
      const arm = MeshBuilder.CreateCylinder("arm", { diameter: 0.13, height: 0.62, tessellation: 8 }, scene);
      arm.position.set(dx, 1.22, 0.02);
      arm.rotation.z = dx < 0 ? 0.1 : -0.1;
      part(arm, "limb");
    }
    // Шея и голова.
    const neck = MeshBuilder.CreateCylinder("neck", { diameter: 0.1, height: 0.1, tessellation: 8 }, scene);
    neck.position.set(0, 1.6, 0);
    part(neck, "chest");
    const head = MeshBuilder.CreateSphere("head", { diameter: 0.23, segments: 10 }, scene);
    head.position.set(0, 1.73, 0);
    part(head, "head");

    // Подставка — визуальная, стрелять по ней бессмысленно.
    const base = MeshBuilder.CreateCylinder("dummy-base", { diameter: 0.5, height: 0.06, tessellation: 14 }, scene);
    base.position.set(0, 0.03, 0);
    base.parent = this.root;
    base.material = this.material;
    base.isPickable = false;
    this.meshes.push(base);
  }

  getCenter(out: Vector3): Vector3 {
    return out.copyFrom(this.root.position).addInPlaceFromFloats(0, 1, 0);
  }

  applyHit(damage: number, zone: HitZone): HitResult {
    if (this.dead) return { damage: 0, zone, killed: false, ignored: true };

    this.health -= damage;
    this.flash = 1;
    // Импульс "отдачи корпуса" — сильнее от крупного урона.
    this.reactVel -= Math.min(damage * 0.014, 0.5);

    const killed = this.health <= 0;
    if (killed) {
      this.dead = true;
      this.deadTimer = RESPAWN_DELAY;
    }
    return { damage, zone, killed, ignored: false };
  }

  update(dt: number): void {
    // Вспышка на попадании.
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 7);
      const f = this.flash;
      this.material.emissiveColor.set(0.55 * f, 0.08 * f, 0.04 * f);
    } else if (this.material.emissiveColor.r !== 0) {
      this.material.emissiveColor.setAll(0);
    }

    // Падение / подъём.
    const targetFall = this.dead ? 1 : 0;
    this.fallT = damp(this.fallT, targetFall, this.dead ? 7 : 3.2, dt);

    if (this.dead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        this.dead = false;
        this.health = 100;
      }
    }

    const [angle, vel] = spring(this.reactAngle, this.reactVel, 0, 120, 14, dt);
    this.reactAngle = angle;
    this.reactVel = vel;

    const fall = clamp01(this.fallT);
    this.root.rotation.x = lerp(0, Math.PI * 0.48, fall) + this.reactAngle * (1 - fall);
    this.root.rotation.z = lerp(0, this.fallRoll, fall);
  }

  reset(): void {
    this.health = 100;
    this.dead = false;
    this.deadTimer = 0;
    this.fallT = 0;
    this.reactAngle = 0;
    this.reactVel = 0;
    this.root.rotation.x = 0;
    this.root.rotation.z = 0;
  }
}

/** Стальная поворотная мишень: от попадания откидывается и возвращается. */
class Plate {
  readonly pivot: TransformNode;
  readonly mesh: Mesh;

  private angle = 0;
  private vel = 0;

  constructor(scene: Scene, position: Vector3, material: StandardMaterial, postMaterial: StandardMaterial) {
    const post = MeshBuilder.CreateCylinder("plate-post", { diameter: 0.09, height: position.y, tessellation: 10 }, scene);
    post.position.set(position.x, position.y / 2, position.z);
    post.material = postMaterial;
    post.isPickable = false;
    post.checkCollisions = false;

    this.pivot = new TransformNode("plate-pivot", scene);
    this.pivot.position.copyFrom(position);

    this.mesh = MeshBuilder.CreateCylinder("plate", { diameter: 0.36, height: 0.035, tessellation: 20 }, scene);
    this.mesh.rotation.x = Math.PI / 2;
    this.mesh.position.set(0, -0.2, 0);
    this.mesh.parent = this.pivot;
    this.mesh.material = material;
    this.mesh.checkCollisions = false;
    this.mesh.receiveShadows = true;
    const meta: TargetMeta = { surface: "metal", zone: "plate", hittable: this };
    this.mesh.metadata = meta;
  }

  /** Плиту нельзя «убить» — она просто откидывается. */
  readonly dead = false;

  getCenter(out: Vector3): Vector3 {
    return out.copyFrom(this.pivot.position);
  }

  applyHit(damage: number): HitResult {
    this.vel -= 4.5 + Math.min(damage * 0.05, 2.5);
    return { damage, zone: "plate", killed: false, ignored: false };
  }

  update(dt: number): void {
    const [a, v] = spring(this.angle, this.vel, 0, 55, 5.5, dt);
    this.angle = Math.max(a, -Math.PI * 0.62);
    this.vel = v;
    this.pivot.rotation.x = -this.angle;
  }

  reset(): void {
    this.angle = 0;
    this.vel = 0;
    this.pivot.rotation.x = 0;
  }
}

export interface TargetCallbacks {
  onDummyHit?: (result: HitResult, point: Vector3) => void;
  onPlateHit?: (point: Vector3) => void;
}

/** Расстановка и жизненный цикл всех мишеней полигона. */
export class TargetManager {
  private readonly dummies: Dummy[] = [];
  private readonly plates: Plate[] = [];
  private readonly external: IHittable[] = [];
  private readonly plateMat: StandardMaterial;
  private readonly postMat: StandardMaterial;

  constructor(
    private readonly scene: Scene,
    private readonly callbacks: TargetCallbacks = {}
  ) {
    this.plateMat = new StandardMaterial("mat-plate", scene);
    this.plateMat.diffuseColor = new Color3(0.78, 0.3, 0.16);
    this.plateMat.specularColor = new Color3(0.35, 0.35, 0.35);
    this.plateMat.specularPower = 48;

    this.postMat = new StandardMaterial("mat-plate-post", scene);
    this.postMat.diffuseColor = new Color3(0.3, 0.31, 0.33);
    this.postMat.specularColor = new Color3(0.2, 0.2, 0.2);

    this.populate();
  }

  get allMeshes(): Mesh[] {
    const out: Mesh[] = [];
    for (const d of this.dummies) out.push(...d.meshes);
    for (const p of this.plates) out.push(p.mesh);
    return out;
  }

  private populate(): void {
    // Ближние мишени по дорожкам, дальние — вразнобой, чтобы работать по дистанциям.
    const layout: Array<[number, number]> = [
      [-6.4, 12],
      [0, 12],
      [6.4, 12],
      [-12.6, 18],
      [12.6, 18],
      [-3.2, 25],
      [3.2, 25],
      [0, 34],
      [-9.5, 40],
      [9.5, 40],
      [-4.5, 52],
      [5.5, 52],
      [0, 66],
      [-14, 66],
      [14, 66],
    ];
    for (const [x, z] of layout) {
      const dummy = new Dummy(this.scene, new Vector3(x, 0, z), Math.PI + randRange(-0.25, 0.25), randRange(0.85, 1.1));
      this.dummies.push(dummy);
    }

    for (const [x, y, z] of [
      [-16.5, 1.35, 15],
      [16.5, 1.35, 15],
      [-1.8, 1.1, 22],
      [1.8, 1.6, 22],
      [11, 1.4, 30],
      [-11, 1.4, 30],
    ] as Array<[number, number, number]>) {
      this.plates.push(new Plate(this.scene, new Vector3(x, y, z), this.plateMat, this.postMat));
    }
  }

  /** Меши манекенов отбрасывают тени — регистрируем их снаружи. */
  forEachShadowCaster(fn: (m: Mesh) => void): void {
    for (const d of this.dummies) for (const m of d.meshes) fn(m);
    for (const p of this.plates) fn(p.mesh);
  }

  /**
   * Обработать попадание рейкаста. Возвращает null, если меш — не мишень.
   */
  registerHit(
    mesh: Mesh,
    baseDamage: number,
    mul: DamageMultipliers,
    point: Vector3,
    hit?: HitContext
  ): HitResult | null {
    const meta = mesh.metadata as TargetMeta | undefined;
    if (!meta?.hittable) return null;

    const zone = meta.zone;
    const factor = zone === "head" ? mul.head : zone === "limb" ? mul.limb : 1;
    const result = meta.hittable.applyHit(baseDamage * factor, zone, hit);

    if (!result.ignored) {
      if (zone === "plate") this.callbacks.onPlateHit?.(point);
      else this.callbacks.onDummyHit?.(result, point);
    }
    return result;
  }

  /** Подключить внешнюю цель (бойцов) к урону по площади. */
  addHittable(hittable: IHittable): void {
    this.external.push(hittable);
  }

  /**
   * Урон по площади (осколочная граната). Учитывает падение с расстоянием и
   * прямую видимость — за укрытием манекен не задевает.
   */
  applyExplosion(
    center: Vector3,
    damage: number,
    radius: number,
    visible: (point: Vector3) => boolean
  ): { hits: number; kills: number } {
    let hits = 0;
    let kills = 0;
    const probe = new Vector3();

    for (const target of [...this.dummies, ...this.external]) {
      if (target.dead) continue;
      target.getCenter(probe);

      const dist = Vector3.Distance(center, probe);
      if (dist > radius) continue;
      if (!visible(probe)) continue;

      const falloff = 1 - dist / radius;
      const result = target.applyHit(damage * falloff * falloff, "chest");
      if (result.ignored) continue;
      hits++;
      if (result.killed) kills++;
    }

    for (const p of this.plates) {
      if (Vector3.Distance(center, p.pivot.position) <= radius) p.applyHit(damage * 0.4);
    }

    return { hits, kills };
  }

  /** В режиме дуэли мишени полигона убираются с арены. */
  setVisible(visible: boolean): void {
    for (const d of this.dummies) d.root.setEnabled(visible);
    for (const p of this.plates) p.pivot.setEnabled(visible);
  }

  update(dt: number): void {
    for (const d of this.dummies) d.update(dt);
    for (const p of this.plates) p.update(dt);
  }

  resetAll(): void {
    for (const d of this.dummies) d.reset();
    for (const p of this.plates) p.reset();
  }
}
