import {
  type AssetContainer,
  LoadAssetContainerAsync,
  Matrix,
  Mesh,
  PBRMaterial,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import enemyUrl from "../../enemy.glb?url";

/**
 * Модель собрана в сантиметрах и без узла-переходника: таз в привязке стоит на
 * 90.1 единицы, то есть ровно на нашей высоте таза 0.9 м после деления на сто.
 * Без этого боец получается стометровым и разносит границы карты теней —
 * сцена уходит в черноту.
 */
const MODEL_SCALE = 0.01;

export function loadEnemyBody(scene: Scene): Promise<AssetContainer> {
  return LoadAssetContainerAsync(enemyUrl, scene, { pluginExtension: ".glb" });
}

/** Наш сустав -> кость в `enemy.glb`. Порядок важен: от таза к конечностям. */
export const BONE_MAP: Array<[JointName, string]> = [
  ["hips", "hips_00"],
  ["spine", "spine_011"],
  ["chest", "chest_012"],
  ["neck", "neck_061"],
  ["head", "head_062"],
  ["shoulderL", "L_arm_014"],
  ["elbowL", "L_elbow_015"],
  ["shoulderR", "R_arm_038"],
  ["elbowR", "R_elbow_039"],
  ["thighL", "L_leg_01"],
  ["kneeL", "L_knee_02"],
  ["ankleL", "L_ankle_03"],
  ["thighR", "R_leg_06"],
  ["kneeR", "R_knee_07"],
  ["ankleR", "R_ankle_08"],
];

export type JointName =
  | "hips" | "spine" | "chest" | "neck" | "head"
  | "shoulderL" | "elbowL" | "shoulderR" | "elbowR"
  | "thighL" | "kneeL" | "ankleL" | "thighR" | "kneeR" | "ankleR";

export type JointMap = Record<JointName, TransformNode>;

interface Link {
  joint: TransformNode;
  bone: TransformNode;
  /** Постоянная поправка: кость-в-локальных-координатах-сустава. */
  offset: Matrix;
}

/**
 * Готовая модель бойца поверх нашего процедурного скелета.
 *
 * Анимации из GLB не используются: в файле один склеенный клип на 13.8 с, а
 * нам нужны ходьба, присед, смерть и рэгдолл, которые уже есть в `Character`.
 * Поэтому модель работает как «шкура»: каждый кадр кости GLB получают позу
 * наших суставов.
 *
 * Скелеты сходятся не сразу — у нашего руки в покое опущены, а модель
 * привязана в Т-позе. Поэтому поправка снимается не с позы покоя, а с
 * Т-позы: наш скелет разводят руками в стороны, сравнивают с привязкой и
 * запоминают разницу. Дальше поза переносится один в один.
 */
export class SkinnedBody {
  readonly meshes: Mesh[] = [];
  private readonly links: Link[] = [];
  private readonly root: TransformNode;

  private readonly world = new Matrix();
  private readonly local = new Matrix();
  private readonly invParent = new Matrix();
  private readonly tmpPos = new Vector3();
  private readonly tmpScale = new Vector3();
  private readonly tmpQuat = new Quaternion();

  constructor(scene: Scene, asset: AssetContainer, parent: TransformNode, joints: JointMap, prefix: string) {
    const copy = asset.instantiateModelsToScene(name => `${prefix}-${name}`, false, { doNotInstantiate: true });
    // Клип из файла нам не нужен — позой управляет наш скелет.
    for (const group of copy.animationGroups) group.dispose();

    this.root = new TransformNode(`${prefix}-skin`, scene);
    this.root.parent = parent;
    this.root.scaling.setAll(MODEL_SCALE);
    for (const node of copy.rootNodes) {
      if (node instanceof TransformNode) node.parent = this.root;
    }

    for (const node of copy.rootNodes) {
      for (const mesh of node.getChildMeshes()) {
        if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
        mesh.isPickable = false;
        mesh.checkCollisions = false;
        mesh.receiveShadows = true;
        // Габарит скиннед-меша считается по привязке; без этого боец пропадает
        // из кадра, когда его поза выходит за исходный габарит.
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.metadata = { surface: "dummy" };
        if (mesh.material instanceof PBRMaterial && mesh.material.albedoTexture) {
          mesh.material.emissiveTexture = mesh.material.albedoTexture;
          mesh.material.emissiveColor.set(0.12, 0.12, 0.12);
        }
        this.meshes.push(mesh);
      }
    }

    const byName = new Map<string, TransformNode>();
    for (const node of copy.rootNodes) {
      for (const child of node.getDescendants(false)) {
        if (child instanceof TransformNode) byName.set(child.name, child);
      }
    }

    for (const [name, bone] of BONE_MAP) {
      const node = byName.get(`${prefix}-${bone}`) ?? byName.get(bone);
      if (!node) throw new Error(`В enemy.glb нет кости ${bone}`);
      this.links.push({ joint: joints[name], bone: node, offset: new Matrix() });
    }
  }

  /**
   * Снять поправку между скелетами. Вызывать, когда наш скелет уже приведён к
   * Т-позе — так обе привязки описывают одну и ту же позу.
   */
  bind(): void {
    this.root.computeWorldMatrix(true);
    for (const link of this.links) {
      link.joint.computeWorldMatrix(true);
      link.bone.computeWorldMatrix(true);
      link.joint.getWorldMatrix().invertToRef(this.invParent);
      link.bone.getWorldMatrix().multiplyToRef(this.invParent, link.offset);
    }
  }

  /** Перенести позу нашего скелета на кости модели. */
  sync(): void {
    for (const link of this.links) {
      link.joint.computeWorldMatrix(true);
      link.offset.multiplyToRef(link.joint.getWorldMatrix(), this.world);

      const parent = link.bone.parent as TransformNode | null;
      if (parent) {
        parent.computeWorldMatrix(true);
        parent.getWorldMatrix().invertToRef(this.invParent);
        this.world.multiplyToRef(this.invParent, this.local);
      } else {
        this.local.copyFrom(this.world);
      }

      this.local.decompose(this.tmpScale, this.tmpQuat, this.tmpPos);
      link.bone.position.copyFrom(this.tmpPos);
      if (!link.bone.rotationQuaternion) link.bone.rotationQuaternion = new Quaternion();
      link.bone.rotationQuaternion.copyFrom(this.tmpQuat);
      link.bone.scaling.copyFrom(this.tmpScale);
      link.bone.computeWorldMatrix(true);
    }
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}
