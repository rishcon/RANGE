import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3, type AssetContainer } from "@babylonjs/core";
import { buildClassicM4 } from "./ClassicM4";
import { buildG18 } from "./G18";
import { buildImportedSniper, buildBayonet } from "./ImportedArsenal";
import { buildTacticalHands } from "./TacticalHands";

/** Слой рендера вьюмодели: очищает буфер глубины, поэтому ствол не режется стенами. */
export const VIEWMODEL_LAYER = 1;

/**
 * Общий масштаб всех вьюмоделей. Мир рендерится с широким FOV, и оружие в
 * натуральную величину занимало бы пол-экрана — как и в других шутерах, его
 * уменьшают. Масштаб единый, иначе руки пришлось бы подгонять под каждый ствол.
 */
export const VM_SCALE = 0.78;

export interface Pose {
  pos: Vector3;
  rot: Vector3;
}

export interface WeaponPoses {
  hip: Pose;
  ads: Pose;
  sprint: Pose;
  reload: Pose;
}

/** Точка крепления кисти или предплечья в координатах модели. */
export interface HandAnchor {
  pos: Vector3;
  rot: Vector3;
}

export interface HandSetup {
  /** Держать оружие ригой рук из GLB вместо процедурных кистей. */
  rig?: boolean;
  style?: "tactical";
  grip?: "horizontal";
  right: HandAnchor | null;
  rightForearm: HandAnchor | null;
  left: HandAnchor | null;
  leftForearm: HandAnchor | null;
}

export interface WeaponModel {
  /** Узел с геометрией: масштаб и вынос вперёд уже применены. */
  body: TransformNode;
  meshes: Mesh[];
  poses: WeaponPoses;
  muzzle: TransformNode;
  ejectPort: TransformNode;
  magazine: Mesh | null;
  bolt: Mesh | null;
  /** Bolt-action handle centre, relative to the bolt's mechanical pivot. */
  manualBolt?: { handle: Vector3; travel: number; liftAngle: number };
  /** Separate charging handle, when supplied by an imported model. */
  chargingHandle?: Mesh;
  hands: HandSetup;
  /**
   * Центр прицельной марки в координатах геометрии (до масштаба `body`). По
   * нему прицеливание каждый кадр доводит ригу так, чтобы марка легла ровно в
   * центр кадра — подбирать позу прицеливания руками больше не нужно.
   */
  sight?: Vector3;
  /**
   * Куда вывести оружие на бедре — точка в метрах от глаза. По умолчанию это
   * `HIP_SIGHT`, подобранная под винтовку: она сама закрывает собой предплечья.
   * Мелкие стволы их не закрывают, поэтому их держат дальше и ниже — иначе в
   * кадре видны одни руки поперёк экрана.
   */
  hipTarget?: Vector3;
  /** Прятать модель при полном прицеливании (оптический прицел). */
  hideOnAds: boolean;
}

export type WeaponModelKind = "rifle" | "sniper" | "pistol" | "knife" | "frag" | "smoke" | "flash";

/** Кэш материалов вьюмоделей — один набор на всё оружие. */
export class ModelFactory {
  private readonly mats = new Map<string, StandardMaterial>();

  constructor(private readonly scene: Scene, readonly rifleAsset: AssetContainer, readonly pistolAsset: AssetContainer,
    readonly sniperAsset: AssetContainer, readonly knifeAsset: AssetContainer) {}

  material(name: string, color: Color3, specular: number, power: number): StandardMaterial {
    const cached = this.mats.get(name);
    if (cached) return cached;
    const m = new StandardMaterial(`vm-${name}`, this.scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(specular, specular, specular);
    m.specularPower = power;
    m.maxSimultaneousLights = 4;
    this.mats.set(name, m);
    return m;
  }

  get metal(): StandardMaterial {
    return this.material("metal", new Color3(0.2, 0.21, 0.225), 0.55, 64);
  }
  get polymer(): StandardMaterial {
    return this.material("polymer", new Color3(0.125, 0.13, 0.14), 0.16, 20);
  }
  get steel(): StandardMaterial {
    return this.material("steel", new Color3(0.28, 0.29, 0.31), 0.7, 96);
  }
  get glove(): StandardMaterial {
    // Перчатка заметно светлее оружия — иначе кисти сливаются с чёрным корпусом.
    return this.material("glove", new Color3(0.4, 0.4, 0.41), 0.2, 28);
  }
  get sleeve(): StandardMaterial {
    return this.material("sleeve", new Color3(0.36, 0.38, 0.27), 0.05, 12);
  }
  get blade(): StandardMaterial {
    return this.material("blade", new Color3(0.6, 0.62, 0.66), 0.9, 128);
  }
  get glass(): StandardMaterial {
    return this.material("glass", new Color3(0.08, 0.12, 0.16), 0.95, 160);
  }
  get olive(): StandardMaterial {
    return this.material("olive", new Color3(0.16, 0.2, 0.13), 0.1, 18);
  }
  get grenadeGrey(): StandardMaterial {
    return this.material("gren-grey", new Color3(0.22, 0.23, 0.24), 0.2, 26);
  }
  get grenadeBlack(): StandardMaterial {
    return this.material("gren-black", new Color3(0.1, 0.1, 0.11), 0.25, 30);
  }
  /** Стекло коллиматора: полупрозрачное, с лёгким синеватым отливом. */
  get lens(): StandardMaterial {
    const m = this.material("lens", new Color3(0.08, 0.14, 0.18), 0.9, 200);
    m.alpha = 0.32;
    m.emissiveColor = new Color3(0.04, 0.1, 0.14);
    m.backFaceCulling = false;
    return m;
  }
  /** Кожа: используется для открытых участков кисти. */
  get skin(): StandardMaterial {
    return this.material("skin", new Color3(0.68, 0.5, 0.38), 0.14, 28);
  }
}

/** Хелпер сборки: регистрирует меш в слое вьюмодели и в списке частей. */
class Builder {
  readonly meshes: Mesh[] = [];

  constructor(
    readonly scene: Scene,
    readonly parent: TransformNode
  ) {}

  add(mesh: Mesh, mat: StandardMaterial, x: number, y: number, z: number, parent?: TransformNode): Mesh {
    mesh.name = `vm-${mesh.name}`;
    mesh.parent = parent ?? this.parent;
    mesh.position.set(x, y, z);
    mesh.material = mat;
    mesh.renderingGroupId = VIEWMODEL_LAYER;
    mesh.isPickable = false;
    mesh.checkCollisions = false;
    mesh.receiveShadows = false;
    mesh.applyFog = false;
    this.meshes.push(mesh);
    return mesh;
  }

  box(name: string, w: number, h: number, d: number): Mesh {
    return MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
  }

  cyl(name: string, diameter: number, height: number, tess = 12): Mesh {
    return MeshBuilder.CreateCylinder(name, { diameter, height, tessellation: tess }, this.scene);
  }

  node(name: string, x: number, y: number, z: number): TransformNode {
    const n = new TransformNode(`vm-${name}`, this.scene);
    n.parent = this.parent;
    n.position.set(x, y, z);
    return n;
  }
}

function pose(px: number, py: number, pz: number, rx: number, ry: number, rz: number): Pose {
  return { pos: new Vector3(px, py, pz), rot: new Vector3(rx, ry, rz) };
}

function anchor(px: number, py: number, pz: number, rx: number, ry: number, rz: number): HandAnchor {
  return { pos: new Vector3(px, py, pz), rot: new Vector3(rx, ry, rz) };
}

function makeBody(scene: Scene, root: TransformNode, forward: number): TransformNode {
  const body = new TransformNode("vm-body", scene);
  body.parent = root;
  // Модель смещена вперёд: иначе её задняя часть упирается в камеру и
  // занимает половину экрана.
  body.position.z = forward;
  body.scaling.setAll(VM_SCALE);
  return body;
}

// ---------------------------------------------------------------- штурмовая

function buildRifle(scene: Scene, root: TransformNode, f: ModelFactory): WeaponModel {
  return buildClassicM4(scene, root, f.rifleAsset);
}

// --------------------------------------------------------------- снайперская


// ------------------------------------------------------------------ пистолет

function buildPistol(scene: Scene, root: TransformNode, f: ModelFactory): WeaponModel {
  return buildG18(scene, root, f.pistolAsset);
}

// ----------------------------------------------------------------------- нож


// ------------------------------------------------------------------ гранаты

function buildGrenade(scene: Scene, root: TransformNode, f: ModelFactory, kind: "frag" | "smoke" | "flash"): WeaponModel {
  const body = makeBody(scene, root, 0.26);
  const b = new Builder(scene, body);

  if (kind === "frag") {
    const shell = MeshBuilder.CreateSphere("gren-body", { diameter: 0.082, segments: 10 }, scene);
    shell.scaling.set(1, 1.12, 1);
    b.add(shell, f.olive, 0, 0, 0);
    // Насечки корпуса.
    for (let i = 0; i < 3; i++) {
      const ring = MeshBuilder.CreateTorus(`gren-ring`, { diameter: 0.084, thickness: 0.005, tessellation: 12 }, scene);
      ring.rotation.x = Math.PI / 2;
      b.add(ring, f.grenadeBlack, 0, -0.02 + i * 0.02, 0);
    }
  } else {
    const can = b.cyl("gren-body", 0.062, 0.135, 14);
    b.add(can, kind === "smoke" ? f.olive : f.grenadeGrey, 0, 0, 0);
    b.add(b.cyl("gren-cap", 0.05, 0.02, 14), f.grenadeBlack, 0, 0.072, 0);
    for (let i = 0; i < 4; i++) {
      const hole = b.cyl("gren-vent", 0.012, 0.026, 8);
      hole.rotation.x = Math.PI / 2;
      b.add(hole, f.grenadeBlack, 0, 0.05, 0.02 + i * 0.001);
    }
  }

  // Скоба и кольцо — общие для всех типов.
  b.add(b.box("gren-lever", 0.012, 0.08, 0.01), f.metal, 0.03, 0.02, 0);
  const ring = MeshBuilder.CreateTorus("gren-pin", { diameter: 0.03, thickness: 0.004, tessellation: 10 }, scene);
  ring.rotation.z = Math.PI / 2;
  b.add(ring, f.metal, 0.038, 0.06, 0);

  return {
    body,
    meshes: b.meshes,
    muzzle: b.node("throw", 0, 0, 0.04),
    ejectPort: b.node("eject", 0, 0, 0),
    magazine: null,
    bolt: null,
    hideOnAds: false,
    // Позы пересчитаны относительно хвата риги: место в кадре задаёт она.
    poses: {
      hip: pose(0, 0, 0, 0, 0, 0),
      // "Прицеливание" — замах у плеча перед броском.
      ads: pose(0.035, 0.105, -0.1, -0.65, -0.15, 0.1),
      sprint: pose(0.035, -0.065, -0.05, 0.15, 0.7, 0.2),
      reload: pose(0.005, -0.025, -0.01, 0.08, 0, 0),
    },
    hipTarget: new Vector3(0.05, -0.1, 0.46),
    hands: {
      rig: true,
      right: anchor(0.002, -0.03, -0.03, -0.1, 0, 0),
      rightForearm: anchor(0.024, -0.08, -0.05, 0.55, -0.1, 0.55),
      left: null,
      leftForearm: null,
    },
  };
}

/** Собрать модель по типу оружия. */
export function createWeaponModel(
  kind: WeaponModelKind,
  scene: Scene,
  root: TransformNode,
  factory: ModelFactory
): WeaponModel {
  switch (kind) {
    case "rifle":
      return buildRifle(scene, root, factory);
    case "sniper":
      return buildImportedSniper(scene, root, factory.sniperAsset);
    case "pistol":
      return buildPistol(scene, root, factory);
    case "knife":
      return buildBayonet(scene, root, factory.knifeAsset);
    default:
      return buildGrenade(scene, root, factory, kind);
  }
}

/**
 * Руки строятся одинаково для всего оружия — отличаются только точки хвата.
 * Правая обхватывает рукоятку, левая — цевьё; предплечья уходят вниз и в
 * стороны за нижнюю кромку кадра.
 */
export function buildHands(
  scene: Scene,
  f: ModelFactory,
  hands: HandSetup,
  leftArm: TransformNode,
  rightArm: TransformNode
): Mesh[] {
  if (hands.style === "tactical") return buildTacticalHands(scene, f, hands, leftArm, rightArm);
  const meshes: Mesh[] = [];
  const glove = f.glove;
  const sleeve = f.sleeve;

  /**
   * Палец из двух фаланг: проксимальная идёт от костяшки, дистальная
   * загибается внутрь — за счёт этого кисть действительно обхватывает деталь,
   * а не выглядит набором брусков.
   */
  const skin = f.skin;
  const finger = (
    b: Builder,
    parent: TransformNode,
    name: string,
    pos: Vector3,
    baseRot: Vector3,
    axis: "z" | "x",
    length: number,
    width: number,
    curl: number
  ): void => {
    const root = new TransformNode(`vm-${name}`, scene);
    root.parent = parent;
    root.position.copyFrom(pos);
    root.rotation.copyFrom(baseRot);

    const half = length * 0.5;
    if (axis === "z") {
      b.add(b.box(`${name}-prox`, width, width * 0.92, length), glove, 0, 0, half, root);
      const tip = new TransformNode(`vm-${name}-tip`, scene);
      tip.parent = root;
      tip.position.set(0, 0, length);
      tip.rotation.x = curl;
      b.add(b.box(`${name}-dist`, width * 0.92, width * 0.86, length * 0.82), skin, 0, 0, length * 0.41, tip);
    } else {
      b.add(b.box(`${name}-prox`, length, width * 0.92, width), glove, half, 0, 0, root);
      const tip = new TransformNode(`vm-${name}-tip`, scene);
      tip.parent = root;
      tip.position.set(length, 0, 0);
      tip.rotation.z = curl;
      b.add(b.box(`${name}-dist`, length * 0.82, width * 0.86, width * 0.92), skin, length * 0.41, 0, 0, tip);
    }
  };

  const attach = (
    parent: TransformNode,
    handAnchor: HandAnchor | null,
    foreAnchor: HandAnchor | null,
    side: "left" | "right"
  ): void => {
    if (!handAnchor) return;
    const b = new Builder(scene, parent);

    const hand = new TransformNode(`vm-${side}-hand`, scene);
    hand.parent = parent;
    hand.position.copyFrom(handAnchor.pos);
    hand.rotation.copyFrom(handAnchor.rot);

    if (side === "right") {
      // Ладонь обхватывает рукоятку: основание, костяшки и подушечка.
      b.add(b.box("r-palm", 0.058, 0.1, 0.046), glove, 0, 0, -0.03, hand);
      b.add(b.box("r-knuckles", 0.062, 0.034, 0.042), glove, 0, 0.034, 0.002, hand);
      b.add(b.box("r-heel", 0.056, 0.056, 0.044), glove, -0.002, -0.03, -0.024, hand);

      for (let i = 0; i < 4; i++) {
        finger(
          b,
          hand,
          `r-finger${i}`,
          new Vector3(0, 0.028 - i * 0.0225, 0.006),
          new Vector3(0.08 + i * 0.03, 0, 0),
          "z",
          0.032,
          0.052 - i * 0.004,
          1.25 - i * 0.06
        );
      }
      // Большой палец ложится на рукоятку слева.
      finger(
        b,
        hand,
        "r-thumb",
        new Vector3(-0.032, 0.016, -0.012),
        new Vector3(0.1, 0.75, -0.3),
        "z",
        0.032,
        0.03,
        0.85
      );
      b.add(b.box("r-wrist", 0.056, 0.062, 0.05), glove, 0, -0.018, -0.062, hand);
    } else {
      // Левая кисть держит цевьё сбоку, пальцы перекинуты сверху.
      b.add(b.box("l-palm", 0.05, 0.088, 0.112), glove, -0.05, -0.008, 0, hand);
      b.add(b.box("l-knuckles", 0.04, 0.036, 0.104), glove, -0.034, 0.03, 0.002, hand);

      for (let i = 0; i < 4; i++) {
        finger(
          b,
          hand,
          `l-finger${i}`,
          new Vector3(-0.032, 0.046, 0.034 - i * 0.025),
          new Vector3(0, 0, -0.16 - i * 0.04),
          "x",
          0.038,
          0.032,
          -1.15 + i * 0.05
        );
      }
      finger(
        b,
        hand,
        "l-thumb",
        new Vector3(-0.05, -0.028, 0.03),
        new Vector3(-0.45, 0, 0.2),
        "z",
        0.03,
        0.028,
        0.6
      );
      b.add(b.box("l-wrist", 0.05, 0.058, 0.058), glove, -0.046, -0.034, -0.056, hand);
    }

    if (foreAnchor) {
      const fore = new TransformNode(`vm-${side}-forearm`, scene);
      fore.parent = parent;
      fore.position.copyFrom(foreAnchor.pos);
      fore.rotation.copyFrom(foreAnchor.rot);
      // Предплечье сужается к запястью, дальше — рукав и обшлаг.
      b.add(
        MeshBuilder.CreateCylinder(
          `${side}-forearm`,
          { diameterTop: 0.05, diameterBottom: 0.076, height: 0.2, tessellation: 14 },
          scene
        ),
        glove,
        0,
        -0.1,
        0,
        fore
      );
      b.add(
        MeshBuilder.CreateCylinder(
          `${side}-cuff`,
          { diameterTop: 0.082, diameterBottom: 0.086, height: 0.035, tessellation: 14 },
          scene
        ),
        sleeve,
        0,
        -0.204,
        0,
        fore
      );
      b.add(
        MeshBuilder.CreateCylinder(
          `${side}-sleeve`,
          { diameterTop: 0.084, diameterBottom: 0.1, height: 0.28, tessellation: 14 },
          scene
        ),
        sleeve,
        0,
        -0.36,
        0,
        fore
      );
    }

    meshes.push(...b.meshes);
  };

  attach(rightArm, hands.right, hands.rightForearm, "right");
  attach(leftArm, hands.left, hands.leftForearm, "left");
  return meshes;
}
