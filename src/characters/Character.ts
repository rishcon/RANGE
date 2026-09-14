import { Color3, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { clamp, clamp01, damp, lerp, randRange } from "../core/MathUtil";
import { RB, RB_COUNT, Ragdoll } from "./Ragdoll";

/** Зона поражения части тела. */
export type BodyZone = "head" | "chest" | "limb";

export interface CharacterPalette {
  uniform: Color3;
  gear: Color3;
  skin: Color3;
  boots: Color3;
}

export const SOLDIER_PALETTE: CharacterPalette = {
  uniform: new Color3(0.27, 0.29, 0.2),
  gear: new Color3(0.12, 0.13, 0.13),
  skin: new Color3(0.58, 0.43, 0.33),
  boots: new Color3(0.13, 0.12, 0.11),
};

export const ENEMY_PALETTE: CharacterPalette = {
  uniform: new Color3(0.33, 0.22, 0.18),
  gear: new Color3(0.14, 0.13, 0.12),
  skin: new Color3(0.55, 0.4, 0.31),
  boots: new Color3(0.11, 0.1, 0.1),
};

export interface CharacterState {
  /** Горизонтальная скорость относительно бега, 0..1. */
  speed: number;
  /** Степень приседа, 0..1 — влияет на наклон корпуса и разведение ног. */
  crouch: number;
  /**
   * Насколько опустить таз, метры. Если задано, угол в коленях считается
   * обратно из этой величины — так тело садится ровно вместе с камерой.
   */
  crouchDrop?: number;
  grounded: boolean;
  /** Вертикальная скорость — по ней различаются взлёт и падение. */
  verticalVelocity: number;
  /** Наклон взгляда: торс и голова доворачиваются вслед. */
  lookPitch: number;
  /** Наклон корпуса вбок (Q/E), радианы. */
  lean: number;
  /** 0 — жив, 1 — полностью упал. */
  death: number;
}

/** Длины сегментов, м. Сумма даёт рост около 1.78. */
const SEG = {
  shin: 0.44,
  thigh: 0.44,
  hipHeight: 0.9,
  pelvisToChest: 0.26,
  chestToNeck: 0.26,
  neck: 0.08,
  upperArm: 0.28,
  lowerArm: 0.26,
};

/**
 * Процедурная модель человека: иерархия суставов из примитивов и анимации
 * без единого файла-ассета.
 *
 * Приседание считается аналитически: если бедро повернуть на угол `A`, а колено
 * на `-2A`, стопа остаётся ровно под тазом, а таз опускается на
 * `2·L·(1−cos A)`. Поэтому ноги не «уезжают» из-под персонажа без IK.
 */
export class Character {
  readonly root: TransformNode;
  readonly meshes: Mesh[] = [];

  /** Узел падения: отдельный от корня, чтобы разворот тела не смешивался с yaw. */
  private readonly fallPivot: TransformNode;
  private readonly hips: TransformNode;
  private readonly spine: TransformNode;
  private readonly chest: TransformNode;
  private readonly neck: TransformNode;
  private readonly headNode: TransformNode;
  private readonly thigh: [TransformNode, TransformNode];
  private readonly knee: [TransformNode, TransformNode];
  private readonly ankle: [TransformNode, TransformNode];
  private readonly shoulder: [TransformNode, TransformNode];
  private readonly elbow: [TransformNode, TransformNode];
  /** Части, которые прячутся в виде от первого лица. */
  private readonly firstPersonHidden: Mesh[] = [];

  /** Меши-ориентиры: по ним берутся мировые точки кистей и головы. */
  private headMesh: Mesh | null = null;
  private readonly handMesh: [Mesh | null, Mesh | null] = [null, null];

  private readonly ragdoll = new Ragdoll();
  private readonly ragdollPoints: Vector3[] = [];
  /** Исходные родители и локальные позиции — для возврата скелета в иерархию. */
  private readonly detached: Array<{ node: TransformNode; parent: TransformNode; pos: Vector3 }> = [];

  private stridePhase = Math.random() * Math.PI * 2;
  private currentCrouch = 0;
  private airT = 0;
  private breath = Math.random() * 6;
  /** Направление падения при смерти — своё у каждого персонажа. */
  private readonly fallDir = Math.random() * Math.PI * 2;
  private readonly weaponHolder: TransformNode | null = null;

  constructor(
    private readonly scene: Scene,
    palette: CharacterPalette,
    options: { holdWeapon?: boolean; namePrefix?: string } = {}
  ) {
    const prefix = options.namePrefix ?? "char";
    const uniform = this.material(`${prefix}-uniform`, palette.uniform, 0.05, 16);
    const gear = this.material(`${prefix}-gear`, palette.gear, 0.12, 24);
    const skin = this.material(`${prefix}-skin`, palette.skin, 0.08, 20);
    const boots = this.material(`${prefix}-boots`, palette.boots, 0.14, 26);

    this.root = new TransformNode(`${prefix}-root`, scene);

    // ---------------------------------------------------------------- корпус
    this.fallPivot = new TransformNode(`${prefix}-fall`, scene);
    this.fallPivot.parent = this.root;
    this.hips = this.joint("hips", this.fallPivot, 0, SEG.hipHeight, 0);
    this.part("pelvis", MeshBuilder.CreateBox("pelvis", { width: 0.32, height: 0.2, depth: 0.22 }, scene), uniform, this.hips, 0, -0.02, 0, "chest");

    this.spine = this.joint("spine", this.hips, 0, 0.08, 0);
    this.part("torso", MeshBuilder.CreateBox("torso", { width: 0.36, height: 0.3, depth: 0.23 }, scene), uniform, this.spine, 0, 0.09, 0, "chest");

    this.chest = this.joint("chest", this.spine, 0, SEG.pelvisToChest - 0.08, 0);
    this.part("chest", MeshBuilder.CreateBox("chest", { width: 0.42, height: 0.28, depth: 0.25 }, scene), uniform, this.chest, 0, 0.12, 0, "chest");
    // Разгрузка поверх груди — силуэт сразу читается как военный.
    this.part("rig", MeshBuilder.CreateBox("rig", { width: 0.37, height: 0.24, depth: 0.28 }, scene), gear, this.chest, 0, 0.11, 0.01, "chest");

    this.neck = this.joint("neck", this.chest, 0, SEG.chestToNeck, 0);
    this.part("neck", MeshBuilder.CreateCylinder("neck", { diameter: 0.11, height: 0.09, tessellation: 8 }, scene), skin, this.neck, 0, 0.04, 0, "head");

    this.headNode = this.joint("head", this.neck, 0, SEG.neck, 0);
    this.headMesh = this.part(
      "head",
      MeshBuilder.CreateSphere("head", { diameter: 0.23, segments: 10 }, scene),
      skin,
      this.headNode,
      0,
      0.09,
      0,
      "head"
    );
    const helmet = MeshBuilder.CreateSphere("helmet", { diameter: 0.26, segments: 10, slice: 0.62 }, scene);
    this.part("helmet", helmet, gear, this.headNode, 0, 0.06, -0.005, "head");

    // ------------------------------------------------------------------ руки
    this.shoulder = [
      this.joint("shoulder-l", this.chest, -0.22, SEG.chestToNeck - 0.05, 0),
      this.joint("shoulder-r", this.chest, 0.22, SEG.chestToNeck - 0.05, 0),
    ];
    this.elbow = [this.joint("elbow-l", this.shoulder[0], 0, -SEG.upperArm, 0), this.joint("elbow-r", this.shoulder[1], 0, -SEG.upperArm, 0)];

    for (const side of [0, 1] as const) {
      const s = side === 0 ? "l" : "r";
      this.part(`upper-arm-${s}`, this.capsule(`upper-arm-${s}`, 0.115, SEG.upperArm), uniform, this.shoulder[side], 0, -SEG.upperArm / 2, 0, "limb");
      this.part(`lower-arm-${s}`, this.capsule(`lower-arm-${s}`, 0.1, SEG.lowerArm), uniform, this.elbow[side], 0, -SEG.lowerArm / 2, 0, "limb");
      this.handMesh[side] = this.part(
        `hand-${s}`,
        MeshBuilder.CreateBox(`hand-${s}`, { width: 0.085, height: 0.11, depth: 0.07 }, scene),
        gear,
        this.elbow[side],
        0,
        -SEG.lowerArm - 0.04,
        0,
        "limb"
      );
    }

    // ------------------------------------------------------------------ ноги
    this.thigh = [this.joint("thigh-l", this.hips, -0.1, -0.04, 0), this.joint("thigh-r", this.hips, 0.1, -0.04, 0)];
    this.knee = [this.joint("knee-l", this.thigh[0], 0, -SEG.thigh, 0), this.joint("knee-r", this.thigh[1], 0, -SEG.thigh, 0)];
    this.ankle = [this.joint("ankle-l", this.knee[0], 0, -SEG.shin, 0), this.joint("ankle-r", this.knee[1], 0, -SEG.shin, 0)];

    for (const side of [0, 1] as const) {
      const s = side === 0 ? "l" : "r";
      this.part(`thigh-${s}`, this.capsule(`thigh-${s}`, 0.17, SEG.thigh), uniform, this.thigh[side], 0, -SEG.thigh / 2, 0, "limb");
      this.part(`shin-${s}`, this.capsule(`shin-${s}`, 0.14, SEG.shin), uniform, this.knee[side], 0, -SEG.shin / 2, 0, "limb");
      this.part(
        `boot-${s}`,
        MeshBuilder.CreateBox(`boot-${s}`, { width: 0.12, height: 0.1, depth: 0.27 }, scene),
        boots,
        this.ankle[side],
        0,
        0.04,
        0.05,
        "limb"
      );
    }

    // ---------------------------------------------------------------- оружие
    if (options.holdWeapon) {
      // Держатель висит на груди, а не на локте: при креплении к предплечью
      // ствол разворачивается вместе с ним и смотрит вверх-назад.
      this.weaponHolder = this.joint("weapon", this.chest, 0.15, 0.11, 0.14);
      const body = MeshBuilder.CreateBox("nme-weapon", { width: 0.06, height: 0.09, depth: 0.5 }, scene);
      this.part("weapon-body", body, gear, this.weaponHolder, 0, 0.02, 0.14, "limb");
      const mag = MeshBuilder.CreateBox("nme-weapon-mag", { width: 0.04, height: 0.16, depth: 0.07 }, scene);
      this.part("weapon-mag", mag, gear, this.weaponHolder, 0, -0.08, 0.06, "limb");
      const stock = MeshBuilder.CreateBox("nme-weapon-stock", { width: 0.05, height: 0.08, depth: 0.16 }, scene);
      this.part("weapon-stock", stock, gear, this.weaponHolder, 0, 0.01, -0.14, "limb");
    }

    for (let i = 0; i < RB_COUNT; i++) this.ragdollPoints.push(new Vector3());

    // В виде от первого лица прячем только то, что реально перекрывает камеру:
    // голову с шеей и руки (их заменяет вьюмодель оружия). Грудь и разгрузку
    // оставляем — без них взгляд вниз упирается в плоский срез торса.
    this.firstPersonHidden.push(...this.meshes.filter((m) => /^(head|helmet|neck)$|-arm-|^hand-/.test(m.name)));
  }

  // -------------------------------------------------------------- построение

  private material(name: string, color: Color3, specular: number, power: number): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(specular, specular, specular);
    m.specularPower = power;
    return m;
  }

  private capsule(name: string, diameter: number, height: number): Mesh {
    return MeshBuilder.CreateCapsule(name, { radius: diameter / 2, height, tessellation: 8, subdivisions: 1 }, this.scene);
  }

  private joint(name: string, parent: TransformNode, x: number, y: number, z: number): TransformNode {
    const node = new TransformNode(name, this.scene);
    node.parent = parent;
    node.position.set(x, y, z);
    return node;
  }

  private part(
    name: string,
    mesh: Mesh,
    mat: StandardMaterial,
    parent: TransformNode,
    x: number,
    y: number,
    z: number,
    zone: BodyZone
  ): Mesh {
    mesh.name = name;
    mesh.parent = parent;
    mesh.position.set(x, y, z);
    mesh.material = mat;
    mesh.checkCollisions = false;
    mesh.receiveShadows = true;
    mesh.metadata = { surface: "dummy", zone };
    this.meshes.push(mesh);
    return mesh;
  }

  /** Проставить владельца для системы попаданий. */
  setHitOwner(owner: unknown): void {
    for (const m of this.meshes) {
      const meta = m.metadata as { surface: string; zone: BodyZone };
      m.metadata = { ...meta, hittable: owner };
    }
  }

  /** В виде от первого лица прячем всё, что перекрывало бы камеру. */
  setFirstPerson(hidden: boolean): void {
    for (const m of this.firstPersonHidden) m.isVisible = !hidden;
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  get headWorldY(): number {
    return this.headNode.getAbsolutePosition().y;
  }

  // ------------------------------------------------------------------ рэгдолл

  get isRagdollActive(): boolean {
    return this.ragdoll.active;
  }

  /**
   * Переводит тело в рэгдолл: кости снимаются с иерархии, дальше их позиции
   * задаёт верлет-симуляция. Импульс от попадания раскидывает ближайшие суставы.
   */
  startRagdoll(velocity: Vector3, impulse: Vector3, hitPoint: Vector3): void {
    if (this.ragdoll.active) return;

    // Мировые матрицы должны быть свежими — точки берутся именно из них.
    this.root.computeWorldMatrix(true);
    for (const node of this.root.getChildTransformNodes(false)) node.computeWorldMatrix(true);

    const pts = this.ragdollPoints;
    pts[RB.hips]!.copyFrom(this.hips.getAbsolutePosition());
    pts[RB.chest]!.copyFrom(this.chest.getAbsolutePosition());
    pts[RB.neck]!.copyFrom(this.neck.getAbsolutePosition());
    pts[RB.head]!.copyFrom((this.headMesh ?? this.headNode).getAbsolutePosition());
    pts[RB.shoulderL]!.copyFrom(this.shoulder[0].getAbsolutePosition());
    pts[RB.shoulderR]!.copyFrom(this.shoulder[1].getAbsolutePosition());
    pts[RB.elbowL]!.copyFrom(this.elbow[0].getAbsolutePosition());
    pts[RB.elbowR]!.copyFrom(this.elbow[1].getAbsolutePosition());
    pts[RB.handL]!.copyFrom((this.handMesh[0] ?? this.elbow[0]).getAbsolutePosition());
    pts[RB.handR]!.copyFrom((this.handMesh[1] ?? this.elbow[1]).getAbsolutePosition());
    pts[RB.hipL]!.copyFrom(this.thigh[0].getAbsolutePosition());
    pts[RB.hipR]!.copyFrom(this.thigh[1].getAbsolutePosition());
    pts[RB.kneeL]!.copyFrom(this.knee[0].getAbsolutePosition());
    pts[RB.kneeR]!.copyFrom(this.knee[1].getAbsolutePosition());
    pts[RB.footL]!.copyFrom(this.ankle[0].getAbsolutePosition());
    pts[RB.footR]!.copyFrom(this.ankle[1].getAbsolutePosition());

    // Снимаем с иерархии всё, чем будет управлять симуляция. Стопы и грудь
    // остаются на своих родителях — они двигаются вместе с голенью и тазом.
    this.detach(this.hips);
    this.detach(this.neck);
    this.detach(this.shoulder[0]);
    this.detach(this.shoulder[1]);
    this.detach(this.elbow[0]);
    this.detach(this.elbow[1]);
    this.detach(this.thigh[0]);
    this.detach(this.thigh[1]);
    this.detach(this.knee[0]);
    this.detach(this.knee[1]);

    // Остаточные углы анимации обнуляем, иначе они складываются с рэгдоллом.
    this.spine.rotation.setAll(0);
    this.chest.rotation.setAll(0);
    this.headNode.rotation.setAll(0);
    this.ankle[0].rotation.setAll(0);
    this.ankle[1].rotation.setAll(0);

    this.ragdoll.groundY = this.groundY;
    this.ragdoll.start(pts, velocity, impulse, hitPoint);
  }

  private detach(node: TransformNode): void {
    const parent = node.parent as TransformNode | null;
    if (!parent) return;
    this.detached.push({ node, parent, pos: node.position.clone() });
    node.setParent(null);
  }

  /** Мировая позиция точки рига — по ней камера смерти следит за телом. */
  getRagdollPoint(index: number, out: Vector3): Vector3 {
    return out.copyFrom(this.ragdoll.getPoint(index));
  }

  private applyRagdoll(): void {
    const r = this.ragdoll;
    r.alignTorso(this.hips, RB.hips, RB.chest, RB.shoulderL, RB.shoulderR);
    r.alignBone(this.neck, RB.neck, RB.head, true);
    r.alignBone(this.shoulder[0], RB.shoulderL, RB.elbowL);
    r.alignBone(this.elbow[0], RB.elbowL, RB.handL);
    r.alignBone(this.shoulder[1], RB.shoulderR, RB.elbowR);
    r.alignBone(this.elbow[1], RB.elbowR, RB.handR);
    r.alignBone(this.thigh[0], RB.hipL, RB.kneeL);
    r.alignBone(this.knee[0], RB.kneeL, RB.footL);
    r.alignBone(this.thigh[1], RB.hipR, RB.kneeR);
    r.alignBone(this.knee[1], RB.kneeR, RB.footR);
  }

  // ----------------------------------------------------------------- анимация

  update(dt: number, state: CharacterState): void {
    if (this.ragdoll.active) {
      this.ragdoll.groundY = this.groundY;
      this.ragdoll.update(dt);
      this.applyRagdoll();
      return;
    }

    const death = clamp01(state.death);
    this.breath += dt;

    if (death > 0) {
      this.animateDeath(dt, death);
      return;
    }

    const crouchTarget = clamp01(state.crouch);
    this.currentCrouch = damp(this.currentCrouch, crouchTarget, 12, dt);
    this.airT = damp(this.airT, state.grounded ? 0 : 1, 10, dt);

    const speed = clamp01(state.speed);
    // Фаза шага привязана к скорости: чем быстрее, тем чаще переставляются ноги.
    this.stridePhase += dt * lerp(5.5, 11, speed) * (speed > 0.02 ? 1 : 0);

    this.animateLegs(speed, state);
    this.animateSpine(speed, state);
    this.animateArms(speed, state);
  }

  /**
   * Ноги: приседание аналитическое (бедро A, колено −2A, стопа A), поверх него
   * накладывается шаг и поза в воздухе.
   */
  private animateLegs(speed: number, state: CharacterState): void {
    // Присед: просадка 2·L·(1−cos A). Если владелец задал нужную просадку
    // явно, решаем уравнение в обратную сторону и получаем угол в коленях.
    const legSpan = 2 * SEG.thigh;
    const drop = state.crouchDrop !== undefined ? Math.min(state.crouchDrop, legSpan * 0.9) : legSpan * (1 - Math.cos(this.currentCrouch * 0.95));
    const crouchAngle = Math.acos(clamp(1 - drop / legSpan, -1, 1));

    // В воздухе ноги подбираются (взлёт) или вытягиваются вниз (падение).
    const rising = clamp01(state.verticalVelocity / 5);
    const falling = clamp01(-state.verticalVelocity / 6);
    const airThigh = this.airT * (rising * 0.75 - falling * 0.2);
    const airKnee = this.airT * (rising * 1.3 + falling * 0.35);

    // Покачивание таза на шаге.
    const bob = Math.abs(Math.sin(this.stridePhase)) * 0.035 * speed;
    this.hips.position.y = SEG.hipHeight - drop - bob;

    for (const side of [0, 1] as const) {
      const dir = side === 0 ? 0 : Math.PI;
      const p = this.stridePhase + dir;
      const swing = Math.sin(p) * lerp(0.28, 0.62, speed) * speed;
      // Колено сгибается в фазе переноса ноги.
      const bend = Math.max(0, -Math.sin(p - 0.7)) * lerp(0.5, 1.15, speed) * speed;

      this.thigh[side].rotation.x = crouchAngle + swing + airThigh;
      this.knee[side].rotation.x = -2 * crouchAngle - bend - airKnee;
      this.ankle[side].rotation.x = crouchAngle + bend * 0.35 - swing * 0.2;
      // Лёгкий развод стоп наружу.
      this.thigh[side].rotation.z = (side === 0 ? 1 : -1) * (0.05 + this.currentCrouch * 0.16);
    }
  }

  private animateSpine(speed: number, state: CharacterState): void {
    // На бегу корпус наклоняется вперёд, в приседе — сильнее.
    const lean = speed * 0.16 + this.currentCrouch * 0.22;
    const breathe = Math.sin(this.breath * 1.4) * 0.012 * (1 - speed);

    this.spine.rotation.x = lean * 0.45 + breathe;
    this.chest.rotation.x = lean * 0.55;
    // Контрвращение корпуса на шаге — иначе походка выглядит «деревянной».
    this.chest.rotation.y = -Math.sin(this.stridePhase) * 0.12 * speed;
    this.hips.rotation.y = Math.sin(this.stridePhase) * 0.08 * speed;

    this.spine.rotation.z = state.lean * 0.45;
    this.chest.rotation.z = state.lean * 0.35;

    // Голова компенсирует наклон корпуса и смотрит туда же, куда игрок.
    const pitch = clamp(state.lookPitch, -0.9, 0.9);
    this.neck.rotation.x = pitch * 0.35 - lean * 0.5;
    this.headNode.rotation.x = pitch * 0.5 - lean * 0.4;
  }

  private animateArms(speed: number, state: CharacterState): void {
    if (this.weaponHolder) {
      // Боевая стойка: правая рука на рукоятке, левая вытянута к цевью,
      // ствол доворачивается по взгляду.
      const sway = Math.sin(this.stridePhase) * 0.08 * speed;
      const pitch = clamp(state.lookPitch, -0.8, 0.8);

      this.weaponHolder.rotation.set(pitch, -0.12, 0);

      this.shoulder[1].rotation.set(-0.55 + pitch * 0.5 + sway * 0.3, -0.25, 0.32);
      this.elbow[1].rotation.set(-1.35, 0, 0);
      this.shoulder[0].rotation.set(-0.78 + pitch * 0.5 - sway * 0.3, 0.35, 0.82);
      this.elbow[0].rotation.set(-0.5, 0, 0);
      return;
    }

    // Свободные руки: маятник в противофазе ногам.
    for (const side of [0, 1] as const) {
      const dir = side === 0 ? Math.PI : 0;
      const p = this.stridePhase + dir;
      const swing = Math.sin(p) * lerp(0.25, 0.55, speed) * speed;
      const air = this.airT * 0.5;

      this.shoulder[side].rotation.x = -swing - air;
      this.shoulder[side].rotation.z = (side === 0 ? 1 : -1) * (0.12 + this.currentCrouch * 0.1);
      this.elbow[side].rotation.x = -0.25 - Math.max(0, swing) * 0.8 - this.currentCrouch * 0.5 - air;
    }
  }

  /**
   * Смерть в три фазы: отшатывание от попадания, оседание на подломившихся
   * ногах и заваливание на землю в случайную сторону.
   */
  private animateDeath(dt: number, death: number): void {
    const collapse = clamp01((death - 0.12) / 0.55);
    const fall = clamp01((death - 0.3) / 0.7);
    const impact = clamp01(death / 0.12) * (1 - collapse);

    // Ноги подламываются, таз идёт к земле.
    const knee = lerp(0, 1.9, collapse);
    this.hips.position.y = damp(this.hips.position.y, SEG.hipHeight - 2 * SEG.thigh * (1 - Math.cos(knee * 0.5)) - fall * 0.18, 9, dt);

    for (const side of [0, 1] as const) {
      const skew = side === 0 ? 1 : -1;
      this.thigh[side].rotation.x = damp(this.thigh[side].rotation.x, knee * 0.5 + fall * 0.25 * skew, 8, dt);
      this.knee[side].rotation.x = damp(this.knee[side].rotation.x, -knee, 8, dt);
      this.ankle[side].rotation.x = damp(this.ankle[side].rotation.x, knee * 0.35, 8, dt);
      this.thigh[side].rotation.z = damp(this.thigh[side].rotation.z, skew * (0.1 + fall * 0.22), 8, dt);
    }

    // Корпус сначала отшатывается, затем обмякает.
    this.spine.rotation.x = damp(this.spine.rotation.x, -impact * 0.5 + collapse * 0.35, 8, dt);
    this.chest.rotation.x = damp(this.chest.rotation.x, -impact * 0.35 + collapse * 0.3, 8, dt);
    this.neck.rotation.x = damp(this.neck.rotation.x, impact * 0.6 + collapse * 0.55, 7, dt);
    this.headNode.rotation.x = damp(this.headNode.rotation.x, collapse * 0.4, 7, dt);

    // Руки безвольно уходят вниз и в стороны.
    for (const side of [0, 1] as const) {
      const skew = side === 0 ? 1 : -1;
      this.shoulder[side].rotation.x = damp(this.shoulder[side].rotation.x, -impact * 1.6 + collapse * 0.35, 7, dt);
      this.shoulder[side].rotation.z = damp(this.shoulder[side].rotation.z, skew * (0.2 + fall * 0.55), 7, dt);
      this.elbow[side].rotation.x = damp(this.elbow[side].rotation.x, -0.2 - collapse * 0.5, 7, dt);
    }

    // Падение — поворот вокруг ОДНОЙ горизонтальной оси: складывать углы
    // Эйлера нельзя, тело закручивается «винтом» вместо того, чтобы лечь.
    const angle = fall * fall * 1.55;
    this.fallAxis.set(Math.cos(this.fallDir), 0, -Math.sin(this.fallDir));
    this.fallPivot.rotationQuaternion = Quaternion.RotationAxis(this.fallAxis, angle);
    // Лежащее тело приподнято на толщину туловища, иначе тонет в земле.
    this.fallPivot.position.y = fall * 0.14;
    this.root.position.y = this.groundY;
  }

  /** Горизонтальная ось, вокруг которой заваливается тело. */
  private readonly fallAxis = new Vector3();

  /** Уровень земли под персонажем — задаётся владельцем. */
  groundY = 0;

  reset(): void {
    // Возвращаем кости на свои места в иерархии.
    this.ragdoll.stop();
    for (let i = this.detached.length - 1; i >= 0; i--) {
      const entry = this.detached[i]!;
      entry.node.setParent(entry.parent);
      entry.node.rotationQuaternion = null;
      entry.node.position.copyFrom(entry.pos);
      entry.node.rotation.setAll(0);
    }
    this.detached.length = 0;

    this.stridePhase = randRange(0, Math.PI * 2);
    this.currentCrouch = 0;
    this.airT = 0;
    this.root.rotation.set(0, this.root.rotation.y, 0);
    this.root.position.y = this.groundY;
    this.fallPivot.rotationQuaternion = null;
    this.fallPivot.rotation.set(0, 0, 0);
    this.fallPivot.position.y = 0;
    this.hips.position.y = SEG.hipHeight;
    for (const node of [...this.thigh, ...this.knee, ...this.ankle, ...this.shoulder, ...this.elbow]) {
      node.rotation.set(0, 0, 0);
    }
    this.spine.rotation.set(0, 0, 0);
    this.chest.rotation.set(0, 0, 0);
    this.neck.rotation.set(0, 0, 0);
    this.headNode.rotation.set(0, 0, 0);
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}
