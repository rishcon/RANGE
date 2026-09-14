import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";

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
  hands: HandSetup;
  /** Прятать модель при полном прицеливании (оптический прицел). */
  hideOnAds: boolean;
}

export type WeaponModelKind = "rifle" | "sniper" | "pistol" | "knife" | "frag" | "smoke" | "flash";

/** Кэш материалов вьюмоделей — один набор на всё оружие. */
export class ModelFactory {
  private readonly mats = new Map<string, StandardMaterial>();

  constructor(private readonly scene: Scene) {}

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
  const body = makeBody(scene, root, 0.34);
  const b = new Builder(scene, body);
  /** Линия прицела = центр линзы коллиматора. */
  const sight = 0.105;

  b.add(b.box("lower", 0.05, 0.072, 0.24), f.polymer, 0, 0.006, 0.06);
  b.add(b.box("upper", 0.048, 0.048, 0.3), f.metal, 0, 0.043, 0.1);
  b.add(b.box("handguard", 0.052, 0.052, 0.25), f.polymer, 0, 0.041, 0.31);

  const barrel = b.cyl("barrel", 0.0165, 0.3);
  barrel.rotation.x = Math.PI / 2;
  b.add(barrel, f.steel, 0, 0.041, 0.5);
  const brake = b.cyl("brake", 0.027, 0.055);
  brake.rotation.x = Math.PI / 2;
  b.add(brake, f.steel, 0, 0.041, 0.63);
  b.add(b.box("gas", 0.024, 0.03, 0.05), f.steel, 0, 0.062, 0.45);

  const tube = b.cyl("tube", 0.032, 0.16);
  tube.rotation.x = Math.PI / 2;
  b.add(tube, f.metal, 0, 0.028, -0.12);
  b.add(b.box("stock", 0.042, 0.062, 0.16), f.polymer, 0, 0.012, -0.16);
  b.add(b.box("butt", 0.046, 0.085, 0.026), f.polymer, 0, 0.002, -0.245);

  const grip = b.box("grip", 0.032, 0.115, 0.05);
  grip.rotation.x = -0.32;
  b.add(grip, f.polymer, 0, -0.075, -0.025);

  const magazine = b.box("magazine", 0.028, 0.17, 0.07);
  magazine.rotation.x = 0.16;
  b.add(magazine, f.polymer, 0, -0.095, 0.075);

  const bolt = b.add(b.box("bolt", 0.044, 0.018, 0.055), f.steel, 0, 0.07, -0.02);

  // Коллиматор на планке: открытая рамка и полупрозрачная линза.
  // Марку рисует HUD — так точка всегда ровно в центре экрана.
  b.add(b.box("optic-mount", 0.032, 0.028, 0.08), f.metal, 0, 0.075, 0.115);
  b.add(b.box("optic-bottom", 0.052, 0.007, 0.076), f.metal, 0, sight - 0.028, 0.115);
  b.add(b.box("optic-top", 0.052, 0.009, 0.076), f.metal, 0, sight + 0.03, 0.115);
  for (const dx of [-0.024, 0.024]) {
    b.add(b.box("optic-side", 0.006, 0.062, 0.076), f.metal, dx, sight, 0.115);
  }
  b.add(b.box("optic-hood", 0.052, 0.014, 0.012), f.metal, 0, sight + 0.024, 0.158);
  b.add(b.box("optic-lens", 0.044, 0.05, 0.003), f.lens, 0, sight, 0.148);
  // Складная мушка на газблоке — просто деталь силуэта.
  b.add(b.box("front-post", 0.004, 0.016, 0.005), f.metal, 0, 0.084, 0.545);

  return {
    body,
    meshes: b.meshes,
    muzzle: b.node("muzzle", 0, 0.041, 0.665),
    ejectPort: b.node("eject", 0.035, 0.055, 0.02),
    magazine,
    bolt,
    hideOnAds: false,
    poses: {
      hip: pose(0.125, -0.132, 0.175, 0.015, -0.05, 0.035),
      ads: pose(0, -sight * VM_SCALE, 0.02, 0, 0, 0),
      sprint: pose(0.145, -0.17, 0.15, 0.05, 0.55, 0.32),
      reload: pose(0.06, -0.108, 0.15, -0.05, -0.42, -0.3),
    },
    hands: {
      right: anchor(0.004, -0.072, -0.026, -0.32, 0, 0),
      rightForearm: anchor(0.028, -0.115, -0.022, 0.55, -0.1, 0.6),
      left: anchor(0, 0.03, 0.315, 0.12, 0, 0),
      leftForearm: anchor(-0.036, -0.025, 0.265, 0.5, 0.15, -0.65),
    },
  };
}

// --------------------------------------------------------------- снайперская

function buildSniper(scene: Scene, root: TransformNode, f: ModelFactory): WeaponModel {
  const body = makeBody(scene, root, 0.33);
  const b = new Builder(scene, body);
  /** Центр оптики — по нему выставляется поза прицеливания. */
  const optic = 0.125;

  b.add(b.box("receiver", 0.055, 0.08, 0.34), f.metal, 0, 0.02, 0.06);
  b.add(b.box("chassis", 0.06, 0.05, 0.2), f.olive, 0, -0.03, 0.16);

  const barrel = b.cyl("barrel", 0.026, 0.52, 14);
  barrel.rotation.x = Math.PI / 2;
  b.add(barrel, f.steel, 0, 0.028, 0.5);
  const brake = b.cyl("brake", 0.038, 0.08, 14);
  brake.rotation.x = Math.PI / 2;
  b.add(brake, f.steel, 0, 0.028, 0.79);

  // Приклад с щекой — характерный силуэт снайперской винтовки.
  b.add(b.box("stock", 0.05, 0.085, 0.3), f.olive, 0, -0.01, -0.25);
  b.add(b.box("cheek", 0.05, 0.045, 0.17), f.olive, 0, 0.055, -0.21);
  b.add(b.box("butt", 0.055, 0.12, 0.03), f.polymer, 0, -0.02, -0.41);

  const grip = b.box("grip", 0.034, 0.12, 0.055);
  grip.rotation.x = -0.3;
  b.add(grip, f.polymer, 0, -0.085, -0.055);

  const magazine = b.box("magazine", 0.032, 0.095, 0.09);
  b.add(magazine, f.metal, 0, -0.075, 0.11);

  // Оптика: труба, окуляр, объектив и кольца крепления.
  const scope = b.cyl("scope", 0.05, 0.3, 16);
  scope.rotation.x = Math.PI / 2;
  b.add(scope, f.metal, 0, optic, 0.13);
  const ocular = b.cyl("ocular", 0.068, 0.05, 16);
  ocular.rotation.x = Math.PI / 2;
  b.add(ocular, f.metal, 0, optic, -0.04);
  const objective = b.cyl("objective", 0.074, 0.055, 16);
  objective.rotation.x = Math.PI / 2;
  b.add(objective, f.metal, 0, optic, 0.3);
  const lens = b.cyl("lens", 0.064, 0.006, 16);
  lens.rotation.x = Math.PI / 2;
  b.add(lens, f.glass, 0, optic, 0.327);
  for (const z of [0.02, 0.24]) {
    b.add(b.box("ring", 0.03, 0.055, 0.022), f.metal, 0, optic - 0.04, z);
  }

  // Рукоятка затвора справа.
  const boltStem = b.cyl("bolt", 0.013, 0.07, 10);
  boltStem.rotation.z = Math.PI / 2;
  const bolt = b.add(boltStem, f.steel, 0.045, 0.035, -0.03);
  const knob = MeshBuilder.CreateSphere("bolt-knob", { diameter: 0.024, segments: 8 }, scene);
  b.add(knob, f.steel, 0.082, 0.035, -0.03);

  return {
    body,
    meshes: b.meshes,
    muzzle: b.node("muzzle", 0, 0.028, 0.84),
    ejectPort: b.node("eject", 0.04, 0.045, 0.0),
    magazine,
    bolt,
    hideOnAds: true,
    poses: {
      hip: pose(0.12, -0.15, 0.14, 0.015, -0.045, 0.03),
      ads: pose(0, -optic * VM_SCALE, 0.0, 0, 0, 0),
      sprint: pose(0.135, -0.16, 0.14, 0.06, 0.55, 0.32),
      reload: pose(0.06, -0.12, 0.12, -0.05, -0.42, -0.3),
    },
    hands: {
      right: anchor(0.004, -0.082, -0.058, -0.3, 0, 0),
      rightForearm: anchor(0.03, -0.125, -0.055, 0.55, -0.1, 0.6),
      left: anchor(0, -0.03, 0.29, 0.12, 0, 0),
      leftForearm: anchor(-0.038, -0.07, 0.24, 0.5, 0.15, -0.65),
    },
  };
}

// ------------------------------------------------------------------ пистолет

function buildPistol(scene: Scene, root: TransformNode, f: ModelFactory): WeaponModel {
  const body = makeBody(scene, root, 0.3);
  const b = new Builder(scene, body);
  const sight = 0.055;

  const slide = b.add(b.box("slide", 0.034, 0.044, 0.2), f.metal, 0, 0.03, 0.06);
  b.add(b.box("frame", 0.032, 0.03, 0.16), f.polymer, 0, -0.002, 0.05);
  b.add(b.box("dust-cover", 0.03, 0.02, 0.08), f.polymer, 0, -0.006, 0.11);

  const grip = b.box("grip", 0.034, 0.12, 0.05);
  grip.rotation.x = -0.16;
  b.add(grip, f.polymer, 0, -0.075, -0.024);
  const magazine = b.box("magazine", 0.03, 0.11, 0.044);
  magazine.rotation.x = -0.16;
  b.add(magazine, f.metal, 0, -0.078, -0.022);

  b.add(b.box("guard-front", 0.02, 0.012, 0.026), f.polymer, 0, -0.038, 0.032);
  b.add(b.box("guard-side", 0.02, 0.03, 0.01), f.polymer, 0, -0.028, 0.045);
  b.add(b.box("trigger", 0.008, 0.026, 0.01), f.steel, 0, -0.028, 0.015);

  b.add(b.box("rear-sight", 0.03, 0.011, 0.012), f.steel, 0, sight, -0.024);
  b.add(b.box("front-sight", 0.006, 0.012, 0.008), f.steel, 0, sight, 0.152);

  return {
    body,
    meshes: b.meshes,
    muzzle: b.node("muzzle", 0, 0.03, 0.165),
    ejectPort: b.node("eject", 0.022, 0.042, 0.03),
    magazine,
    bolt: slide,
    hideOnAds: false,
    poses: {
      hip: pose(0.125, -0.125, 0.2, 0.02, -0.06, 0.04),
      ads: pose(0, -sight * VM_SCALE, 0.1, 0, 0, 0),
      sprint: pose(0.14, -0.17, 0.16, 0.08, 0.5, 0.3),
      reload: pose(0.07, -0.14, 0.13, -0.05, -0.4, -0.28),
    },
    hands: {
      // Пистолет держат двумя руками: левая обхватывает правую снизу-слева.
      right: anchor(0.004, -0.074, -0.022, -0.16, 0, 0),
      rightForearm: anchor(0.026, -0.12, -0.02, 0.6, -0.08, 0.5),
      left: anchor(-0.036, -0.086, -0.008, -0.16, 0, 0.34),
      leftForearm: anchor(-0.054, -0.125, -0.006, 0.58, 0.12, -0.5),
    },
  };
}

// ----------------------------------------------------------------------- нож

function buildKnife(scene: Scene, root: TransformNode, f: ModelFactory): WeaponModel {
  const body = makeBody(scene, root, 0.26);
  const b = new Builder(scene, body);

  b.add(b.box("blade", 0.009, 0.036, 0.19), f.blade, 0, 0.022, 0.15);
  // Скос к острию.
  const tip = b.box("blade-tip", 0.009, 0.036, 0.05);
  tip.rotation.x = 0.42;
  b.add(tip, f.blade, 0, 0.014, 0.265);
  b.add(b.box("edge", 0.011, 0.008, 0.17), f.steel, 0, 0.006, 0.14);
  b.add(b.box("guard", 0.034, 0.014, 0.022), f.metal, 0, 0.012, 0.045);
  b.add(b.box("handle", 0.028, 0.034, 0.12), f.polymer, 0, 0.004, -0.03);
  b.add(b.box("pommel", 0.032, 0.038, 0.022), f.metal, 0, 0.004, -0.102);

  return {
    body,
    meshes: b.meshes,
    muzzle: b.node("tip", 0, 0.02, 0.29),
    ejectPort: b.node("eject", 0, 0, 0),
    magazine: null,
    bolt: null,
    hideOnAds: false,
    poses: {
      // "Прицеливание" у ножа — замах для сильного удара.
      hip: pose(0.125, -0.095, 0.28, -0.05, -0.38, 0.3),
      ads: pose(0.155, -0.02, 0.22, -0.6, -0.72, 0.5),
      sprint: pose(0.155, -0.15, 0.22, 0.1, 0.5, 0.35),
      reload: pose(0.125, -0.095, 0.28, -0.05, -0.38, 0.3),
    },
    hands: {
      right: anchor(0.004, -0.008, -0.05, -0.05, 0, 0),
      rightForearm: anchor(0.024, -0.055, -0.075, 0.55, -0.1, 0.55),
      left: null,
      leftForearm: null,
    },
  };
}

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
    poses: {
      hip: pose(0.125, -0.125, 0.25, 0.1, -0.2, 0.1),
      // "Прицеливание" — замах у плеча перед броском.
      ads: pose(0.16, -0.02, 0.15, -0.55, -0.35, 0.2),
      sprint: pose(0.16, -0.19, 0.2, 0.25, 0.5, 0.3),
      reload: pose(0.13, -0.15, 0.24, 0.18, -0.2, 0.1),
    },
    hands: {
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
      return buildSniper(scene, root, factory);
    case "pistol":
      return buildPistol(scene, root, factory);
    case "knife":
      return buildKnife(scene, root, factory);
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
