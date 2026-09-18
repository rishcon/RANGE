import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { clamp, clamp01, damp, lerp, randRange } from "../core/MathUtil";
import { RB, RB_COUNT, Ragdoll } from "./Ragdoll";
import { humanContour, uniformTexture } from "./HumanGeometry";
import { SkinnedBody, type JointMap } from "./SkinnedBody";
import type { AssetContainer } from "@babylonjs/core";

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

  /** Готовая модель поверх процедурного скелета; без неё видно примитивы. */
  private skin: SkinnedBody | null = null;

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

    const clothDetail = this.material(`${prefix}-cloth-detail`, palette.uniform.scale(0.72), 0.025, 12);
    const eyeWhite = this.material(`${prefix}-eyes`, new Color3(0.55, 0.53, 0.47), 0.2, 48);
    const faceDetail = this.material(`${prefix}-face-detail`, palette.skin.scale(0.48), 0.025, 12);
    uniform.diffuseTexture = uniformTexture(scene, `${prefix}-fabric`, true);
    clothDetail.diffuseTexture = uniform.diffuseTexture;
    gear.diffuseTexture = uniformTexture(scene, `${prefix}-nylon`, false);

    const oval = (name: string, parent: TransformNode, mat: StandardMaterial,
      x: number, y: number, z: number, w: number, h: number, d: number, zone: BodyZone = "limb") => {
      const mesh = MeshBuilder.CreateSphere(name, { diameter: 1, segments: 16 }, scene);
      mesh.scaling.set(w, h, d);
      return this.part(name, mesh, mat, parent, x, y, z, zone);
    };
    const contour = (name: string, parent: TransformNode, mat: StandardMaterial,
      rings: Array<[number, number, number, number?]>, zone: BodyZone = "limb") =>
      this.part(name, humanContour(scene, name, rings), mat, parent, 0, 0, 0, zone);

    this.fallPivot = new TransformNode(`${prefix}-fall`, scene);
    this.fallPivot.parent = this.root;
    this.hips = this.joint("hips", this.fallPivot, 0, SEG.hipHeight, 0);
    contour("pelvis", this.hips, uniform, [
      [-0.15, 0.12, 0.09], [-0.08, 0.17, 0.115], [0.015, 0.16, 0.115], [0.09, 0.145, 0.10],
    ], "chest");
    this.spine = this.joint("spine", this.hips, 0, 0.08, 0);
    contour("torso", this.spine, uniform, [
      [-0.03, 0.145, 0.105], [0.04, 0.15, 0.11], [0.14, 0.165, 0.118], [0.25, 0.185, 0.12],
    ], "chest");
    this.chest = this.joint("chest", this.spine, 0, SEG.pelvisToChest - 0.08, 0);
    contour("chest", this.chest, uniform, [
      [-0.055, 0.165, 0.115], [0.05, 0.195, 0.13], [0.15, 0.205, 0.13],
      [0.215, 0.19, 0.11], [0.26, 0.07, 0.075],
    ], "chest");
    contour("rig", this.chest, gear, [
      [-0.055, 0.16, 0.128], [-0.025, 0.182, 0.142], [0.14, 0.183, 0.145],
      [0.205, 0.137, 0.132],
    ], "chest");
    for (const side of [-1, 1]) {
      oval("vest-strap", this.chest, clothDetail, side * 0.115, 0.225, 0.035, 0.058, 0.065, 0.235, "chest");
      oval("belt-pouch", this.hips, gear, side * 0.155, -0.005, 0.025, 0.075, 0.13, 0.14, "chest");
      for (let i = 0; i < 2; i++) {
        oval("mag-pouch", this.chest, clothDetail, side * (0.043 + i * 0.072), 0.045, 0.136, 0.069, 0.15, 0.062, "chest");
        oval("pouch-flap", this.chest, gear, side * (0.043 + i * 0.072), 0.095, 0.164, 0.063, 0.038, 0.018, "chest");
      }
    }
    contour("belt", this.hips, gear, [[0.012, 0.168, 0.122], [0.05, 0.163, 0.119]], "chest");
    oval("belt-buckle", this.hips, boots, 0, 0.032, 0.122, 0.052, 0.035, 0.018, "chest");

    this.neck = this.joint("neck", this.chest, 0, SEG.chestToNeck, 0);
    contour("neck", this.neck, skin, [[-0.025, 0.062, 0.055], [0.04, 0.05, 0.049], [0.095, 0.055, 0.052]], "head");
    this.headNode = this.joint("head", this.neck, 0, SEG.neck, 0);
    this.headMesh = oval("head", this.headNode, skin, 0, 0.102, 0, 0.165, 0.225, 0.195, "head");
    contour("jaw", this.headNode, skin, [
      [0.005, 0.04, 0.043, 0.025], [0.025, 0.058, 0.066, 0.022],
      [0.07, 0.073, 0.076, 0.012], [0.105, 0.077, 0.079, 0.008],
    ], "head");
    oval("nose", this.headNode, skin, 0, 0.084, 0.099, 0.029, 0.052, 0.042, "head");
    oval("mouth", this.headNode, faceDetail, 0, 0.045, 0.089, 0.047, 0.008, 0.009, "head");
    oval("lower-lip", this.headNode, skin, 0, 0.039, 0.088, 0.044, 0.009, 0.012, "head");
    for (const side of [-1, 1]) {
      oval("ear", this.headNode, skin, side * 0.083, 0.083, 0, 0.028, 0.057, 0.03, "head");
      oval("eye-socket", this.headNode, faceDetail, side * 0.033, 0.114, 0.087, 0.036, 0.019, 0.018, "head");
      oval("eye", this.headNode, eyeWhite, side * 0.033, 0.114, 0.095, 0.027, 0.011, 0.009, "head");
      oval("iris", this.headNode, gear, side * 0.033, 0.114, 0.1, 0.01, 0.01, 0.005, "head");
      oval("eyebrow", this.headNode, faceDetail, side * 0.033, 0.13, 0.087, 0.041, 0.008, 0.015, "head");
      oval("helmet-strap", this.headNode, gear, side * 0.069, 0.037, 0.024, 0.012, 0.091, 0.014, "head");
    }
    const helmet = MeshBuilder.CreateSphere("helmet", { diameter: 1, segments: 20, slice: 0.47 }, scene);
    helmet.scaling.set(0.202, 0.238, 0.235);
    this.part("helmet", helmet, clothDetail, this.headNode, 0, 0.12, -0.012, "head");
    const rim = MeshBuilder.CreateTorus("helmet-rim", { diameter: 0.202, thickness: 0.011, tessellation: 28 }, scene);
    rim.scaling.z = 1.16;
    this.part("helmet-rim", rim, gear, this.headNode, 0, 0.133, -0.012, "head");

    this.shoulder = [
      this.joint("shoulder-l", this.chest, -0.205, SEG.chestToNeck - 0.05, 0),
      this.joint("shoulder-r", this.chest, 0.205, SEG.chestToNeck - 0.05, 0),
    ];
    this.elbow = [this.joint("elbow-l", this.shoulder[0], 0, -SEG.upperArm, 0), this.joint("elbow-r", this.shoulder[1], 0, -SEG.upperArm, 0)];
    for (const side of [0, 1] as const) {
      const s = side === 0 ? "l" : "r";
      contour(`upper-arm-${s}`, this.shoulder[side], uniform, [
        [-0.30, 0.049, 0.052], [-0.235, 0.055, 0.058], [-0.12, 0.069, 0.073],
        [-0.035, 0.072, 0.072], [0.045, 0.037, 0.043],
      ]);
      contour(`lower-arm-${s}`, this.elbow[side], uniform, [
        [-0.275, 0.033, 0.031], [-0.22, 0.037, 0.038], [-0.12, 0.053, 0.057],
        [-0.03, 0.052, 0.052], [0.018, 0.042, 0.042],
      ]);
      oval(`elbow-pad-${s}`, this.elbow[side], gear, 0, -0.025, -0.045, 0.084, 0.10, 0.038);
      contour(`cuff-${s}`, this.elbow[side], clothDetail, [[-0.266, 0.038, 0.036], [-0.226, 0.041, 0.038]]);
      this.handMesh[side] = oval(`hand-${s}`, this.elbow[side], gear, 0, -SEG.lowerArm - 0.041, 0, 0.071, 0.10, 0.047);
      for (let finger = 0; finger < 4; finger++) {
        oval(`finger-${s}`, this.elbow[side], gear, -0.025 + finger * 0.016, -SEG.lowerArm - 0.086, 0.013, 0.017, 0.058 - Math.abs(finger - 1) * 0.005, 0.026);
      }
      oval(`thumb-${s}`, this.elbow[side], gear, (side === 0 ? 1 : -1) * 0.034, -SEG.lowerArm - 0.034, 0.024, 0.027, 0.057, 0.03);
    }

    this.thigh = [this.joint("thigh-l", this.hips, -0.095, -0.04, 0), this.joint("thigh-r", this.hips, 0.095, -0.04, 0)];
    this.knee = [this.joint("knee-l", this.thigh[0], 0, -SEG.thigh, 0), this.joint("knee-r", this.thigh[1], 0, -SEG.thigh, 0)];
    this.ankle = [this.joint("ankle-l", this.knee[0], 0, -SEG.shin, 0), this.joint("ankle-r", this.knee[1], 0, -SEG.shin, 0)];
    for (const side of [0, 1] as const) {
      const s = side === 0 ? "l" : "r";
      contour(`thigh-${s}`, this.thigh[side], uniform, [
        [-0.46, 0.061, 0.066], [-0.37, 0.067, 0.076], [-0.23, 0.084, 0.091],
        [-0.10, 0.093, 0.106], [0.025, 0.077, 0.092],
      ]);
      contour(`shin-${s}`, this.knee[side], uniform, [
        [-0.45, 0.046, 0.048], [-0.32, 0.051, 0.057], [-0.19, 0.072, 0.079, -0.01],
        [-0.065, 0.068, 0.07], [0.023, 0.06, 0.064],
      ]);
      oval(`knee-pad-${s}`, this.knee[side], gear, 0, -0.012, 0.059, 0.115, 0.14, 0.046);
      oval(`cargo-pocket-${s}`, this.thigh[side], clothDetail, (side === 0 ? -1 : 1) * 0.083, -0.19, 0, 0.037, 0.16, 0.13);
      contour(`boot-shaft-${s}`, this.ankle[side], boots, [[0.02, 0.06, 0.066], [0.10, 0.057, 0.058], [0.22, 0.057, 0.059]]);
      oval(`boot-${s}`, this.ankle[side], boots, 0, 0.055, 0.053, 0.127, 0.13, 0.267);
      oval(`boot-sole-${s}`, this.ankle[side], gear, 0, 0.022, 0.053, 0.135, 0.036, 0.275);
      for (let i = 0; i < 4; i++) oval("boot-lace", this.ankle[side], clothDetail, 0, 0.103 + i * 0.018, 0.057, 0.072, 0.009, 0.014);
    }

    if (options.holdWeapon) {
      this.weaponHolder = this.joint("weapon", this.chest, 0.13, 0.1, 0.16);
      const receiver = MeshBuilder.CreateBox("weapon-body", { width: 0.054, height: 0.072, depth: 0.28 }, scene);
      this.part("weapon-body", receiver, gear, this.weaponHolder, 0, 0.025, 0.16, "limb");
      const barrel = MeshBuilder.CreateCylinder("weapon-barrel", { diameter: 0.022, height: 0.3, tessellation: 12 }, scene);
      barrel.rotation.x = Math.PI / 2;
      this.part("weapon-barrel", barrel, boots, this.weaponHolder, 0, 0.034, 0.43, "limb");
      oval("weapon-stock", this.weaponHolder, gear, 0, -0.007, -0.075, 0.052, 0.12, 0.24);
      const magazine = MeshBuilder.CreateBox("weapon-mag", { width: 0.031, height: 0.14, depth: 0.075 }, scene);
      this.part("weapon-mag", magazine, gear, this.weaponHolder, 0, -0.071, 0.13, "limb");
      oval("weapon-grip", this.weaponHolder, gear, 0, -0.062, 0.013, 0.04, 0.115, 0.058);
    }

    // Collapse static details sharing a bone/material into one draw call. Keep
    // the head/palm landmarks separate for the existing ragdoll solver.
    const groups = new Map<string, Mesh[]>();
    for (const mesh of this.meshes) {
      if (mesh === this.headMesh || this.handMesh.includes(mesh)) continue;
      const key = `${mesh.parent!.uniqueId}:${mesh.material!.uniqueId}:${mesh.metadata.zone}`;
      const group = groups.get(key) ?? []; group.push(mesh); groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const parent = group[0]!.parent as TransformNode, metadata = group[0]!.metadata;
      const merged = Mesh.MergeMeshes(group, true, true)!;
      merged.name = group[0]!.name + "-detail";
      merged.setParent(parent); merged.metadata = metadata; merged.receiveShadows = true;
      for (const mesh of group) this.meshes.splice(this.meshes.indexOf(mesh), 1);
      this.meshes.push(merged);
    }
    for (let i = 0; i < RB_COUNT; i++) this.ragdollPoints.push(new Vector3());
    this.firstPersonHidden.push(...this.meshes.filter(m =>
      m.isDescendantOf(this.neck) || this.shoulder.some(node => m.isDescendantOf(node))));
  }
  // -------------------------------------------------------------- построение

  private material(name: string, color: Color3, specular: number, power: number): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.ambientColor = Color3.White();
    m.specularColor = new Color3(specular, specular, specular);
    m.specularPower = power;
    return m;
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

  /**
   * Надеть на процедурный скелет готовую модель из GLB. Примитивы остаются
   * зонами поражения, но больше не рисуются: попадания считаются по ним, а
   * видно бойца из файла.
   */
  attachSkin(asset: AssetContainer, prefix: string): SkinnedBody {
    const joints: JointMap = {
      hips: this.hips, spine: this.spine, chest: this.chest, neck: this.neck, head: this.headNode,
      shoulderL: this.shoulder[0], elbowL: this.elbow[0],
      shoulderR: this.shoulder[1], elbowR: this.elbow[1],
      thighL: this.thigh[0], kneeL: this.knee[0], ankleL: this.ankle[0],
      thighR: this.thigh[1], kneeR: this.knee[1], ankleR: this.ankle[1],
    };
    const skin = new SkinnedBody(this.scene, asset, this.root, joints, prefix);
    this.withTPose(() => skin.bind());
    this.skin = skin;

    for (const mesh of this.meshes) {
      mesh.isVisible = false;
      const meta = (mesh.metadata ?? {}) as Record<string, unknown>;
      mesh.metadata = { ...meta, hitProxy: true };
    }
    return skin;
  }

  get skinMeshes(): readonly Mesh[] {
    return this.skin?.meshes ?? [];
  }

  /**
   * Временно развести руки в стороны. Модель из GLB привязана в Т-позе, а наш
   * скелет в покое стоит руки по швам — сравнивать их надо в одной позе, иначе
   * поправка получится с вывернутыми плечами.
   */
  private withTPose(fn: () => void): void {
    const nodes = [
      this.hips, this.spine, this.chest, this.neck, this.headNode,
      ...this.thigh, ...this.knee, ...this.ankle, ...this.shoulder, ...this.elbow,
    ];
    const saved = nodes.map(node => ({
      quat: node.rotationQuaternion?.clone() ?? null,
      rot: node.rotation.clone(),
      pos: node.position.clone(),
    }));
    const savedRoot = this.fallPivot.rotation.clone();

    for (const node of nodes) {
      node.rotationQuaternion = null;
      node.rotation.setAll(0);
    }
    this.fallPivot.rotation.setAll(0);
    this.hips.position.set(0, SEG.hipHeight, 0);
    this.shoulder[0].rotation.z = -Math.PI / 2;
    this.shoulder[1].rotation.z = Math.PI / 2;

    fn();

    nodes.forEach((node, i) => {
      const s = saved[i]!;
      node.rotationQuaternion = s.quat;
      node.rotation.copyFrom(s.rot);
      node.position.copyFrom(s.pos);
    });
    this.fallPivot.rotation.copyFrom(savedRoot);
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
      this.skin?.sync();
      return;
    }

    const death = clamp01(state.death);
    this.breath += dt;

    if (death > 0) {
      this.animateDeath(dt, death);
      this.skin?.sync();
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
    this.skin?.sync();
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

      this.weaponHolder.rotation.z = sway * 0.15;
      this.fitWeaponArm(1, new Vector3(0, -0.055, 0.013));
      this.fitWeaponArm(0, new Vector3(-0.015, -0.008, 0.28));
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

  /** Two-bone reach in chest space: palms stay on the weapon while elbows
   * bend down/outward. Joint lengths remain compatible with the ragdoll. */
  private fitWeaponArm(side: 0 | 1, grip: Vector3): void {
    const holder = this.weaponHolder!;
    const rotation = Quaternion.FromEulerVector(holder.rotation);
    const target = Vector3.TransformCoordinates(grip, Matrix.Compose(Vector3.One(), rotation, holder.position));
    const shoulder = this.shoulder[side], elbow = this.elbow[side];
    const delta = target.subtract(shoulder.position);
    const upper = SEG.upperArm, lower = SEG.lowerArm + 0.041;
    const distance = clamp(delta.length(), 0.08, upper + lower - 0.004);
    const axis = delta.normalize();
    const pole = new Vector3(side === 0 ? -0.45 : 0.45, -1, -0.15);
    const bend = pole.subtract(axis.scale(Vector3.Dot(pole, axis))).normalize();
    const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    const upperDirection = axis.scale(along).addInPlace(bend.scale(height));
    const elbowPoint = shoulder.position.add(upperDirection);
    const q = Quaternion.FromUnitVectorsToRef(new Vector3(0, -1, 0), upperDirection.normalize(), new Quaternion());
    shoulder.rotationQuaternion = q;
    const inverse = Matrix.Invert(Matrix.FromQuaternionToRef(q, new Matrix()));
    const lowerLocal = Vector3.TransformNormal(target.subtract(elbowPoint).normalize(), inverse).normalize();
    elbow.rotationQuaternion = Quaternion.FromUnitVectorsToRef(new Vector3(0, -1, 0), lowerLocal, new Quaternion());
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
      node.rotationQuaternion = null;
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
