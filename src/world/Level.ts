import {
  Color3,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { buildTextures, makeDistanceSign, tiledCopy, type TextureLibrary } from "./Textures";

export type SurfaceKind = "concrete" | "metal" | "wood" | "sand" | "dirt" | "dummy";

interface BoxOptions {
  surface?: SurfaceKind;
  collide?: boolean;
  shadows?: boolean;
  receive?: boolean;
  rotX?: number;
  rotY?: number;
}

/**
 * Геометрия полигона: навес над огневым рубежом, разделители дорожек,
 * укрытия, валы и таблички дистанций. Всё статическое — матрицы замораживаем.
 */
export class Level {
  readonly textures: TextureLibrary;
  readonly shadowGenerator: ShadowGenerator;
  readonly sun: DirectionalLight;

  private readonly materials: Record<string, StandardMaterial> = {};

  private readonly statics: Mesh[] = [];
  private readonly casters: Mesh[] = [];

  constructor(private readonly scene: Scene) {
    this.textures = buildTextures(scene);

    scene.collisionsEnabled = true;
    scene.clearColor = new Color3(0.55, 0.62, 0.68).toColor4(1);
    scene.ambientColor = new Color3(0.17, 0.18, 0.21);

    // Дымка вдаль — полигон длинный, без неё дальние мишени "висят" в пустоте.
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = new Color3(0.63, 0.67, 0.7);
    scene.fogDensity = 0.0026;

    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
    hemi.intensity = 0.38;
    hemi.diffuse = new Color3(0.72, 0.78, 0.88);
    hemi.groundColor = new Color3(0.26, 0.24, 0.21);

    this.sun = new DirectionalLight("sun", new Vector3(-0.55, -1, 0.3), scene);
    this.sun.intensity = 1.55;
    this.sun.diffuse = new Color3(1, 0.95, 0.85);
    this.sun.position = new Vector3(34, 62, -18);
    // ВНИМАНИЕ: shadowMinZ/shadowMaxZ и shadowFrustumSize у направленного света
    // ломают сравнение глубины (тени просто исчезают) — оставляем авторасчёт
    // границ, а размер ортобокса ограничиваем составом кастеров ниже.
    this.sun.autoUpdateExtends = true;

    this.shadowGenerator = new ShadowGenerator(2048, this.sun);
    this.shadowGenerator.usePercentageCloserFiltering = true;
    this.shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    // Bias для направленного света масштабируется глубиной сцены: значения
    // больше ~0.0005 «съедают» тень целиком.
    this.shadowGenerator.bias = 0.0001;
    this.shadowGenerator.normalBias = 0.006;
    this.shadowGenerator.darkness = 0.2;

    this.buildMaterials();
    this.buildSky();
    this.buildGround();
    this.buildFiringLine();
    this.buildLanes();
    this.buildPerimeter();
    this.buildCover();
    this.buildElevatedPlatform();
    this.buildSigns();
  }

  /** Манекены регистрируются как источники теней отдельно. */
  addShadowCaster(mesh: Mesh): void {
    this.shadowGenerator.addShadowCaster(mesh, true);
  }


  setShadowsEnabled(enabled: boolean): void {
    this.shadowGenerator.getShadowMap()!.refreshRate = enabled ? 1 : 0;
    for (const m of this.statics) m.receiveShadows = enabled;
    this.sun.shadowEnabled = enabled;
  }

  // ------------------------------------------------------------- материалы

  private mat(name: string): StandardMaterial {
    const m = this.materials[name];
    if (!m) throw new Error(`Материал не найден: ${name}`);
    return m;
  }

  private scaledTex(tex: DynamicTexture, u: number, v: number): Texture {
    return tiledCopy(tex, this.scene, u, v);
  }

  private makeMat(
    name: string,
    tex: Texture,
    opts: { specular?: number; power?: number; tint?: Color3 } = {}
  ): StandardMaterial {
    const m = new StandardMaterial(`mat-${name}`, this.scene);
    m.diffuseTexture = tex;
    m.diffuseColor = opts.tint ?? new Color3(1, 1, 1);
    const s = opts.specular ?? 0.04;
    m.specularColor = new Color3(s, s, s);
    m.specularPower = opts.power ?? 24;
    m.ambientColor = new Color3(1, 1, 1);
    this.materials[name] = m;
    return m;
  }

  private buildMaterials(): void {
    const t = this.textures;
    this.makeMat("floor", this.scaledTex(t.concrete, 26, 26), { specular: 0.03 });
    this.makeMat("dirt", this.scaledTex(t.dirt, 30, 30), { specular: 0.01 });
    this.makeMat("asphalt", this.scaledTex(t.asphalt, 10, 10), { specular: 0.02 });
    this.makeMat("wall", this.scaledTex(t.concrete, 6, 2), { specular: 0.03 });
    this.makeMat("wallTall", this.scaledTex(t.concrete, 10, 2.5), { specular: 0.03 });
    this.makeMat("wood", this.scaledTex(t.wood, 2, 2), { specular: 0.06, power: 18 });
    this.makeMat("metal", this.scaledTex(t.metal, 2, 2), { specular: 0.42, power: 64 });
    this.makeMat("metalDark", this.scaledTex(t.metal, 3, 3), {
      specular: 0.3,
      power: 48,
      tint: new Color3(0.45, 0.47, 0.5),
    });
    this.makeMat("sandbag", this.scaledTex(t.sandbag, 1, 1), { specular: 0.02 });
    this.makeMat("berm", this.scaledTex(t.dirt, 12, 4), { specular: 0.01 });
  }

  // ------------------------------------------------------------ примитивы

  private box(
    name: string,
    size: { w: number; h: number; d: number },
    pos: { x: number; y: number; z: number },
    matName: string,
    opts: BoxOptions = {}
  ): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width: size.w, height: size.h, depth: size.d }, this.scene);
    mesh.position.set(pos.x, pos.y, pos.z);
    if (opts.rotX) mesh.rotation.x = opts.rotX;
    if (opts.rotY) mesh.rotation.y = opts.rotY;
    mesh.material = this.mat(matName);
    mesh.checkCollisions = opts.collide ?? true;
    mesh.receiveShadows = opts.receive ?? true;
    mesh.metadata = { surface: opts.surface ?? "concrete" };
    if (opts.shadows ?? true) this.casters.push(mesh);
    this.statics.push(mesh);
    return mesh;
  }

  private cylinder(
    name: string,
    diameter: number,
    height: number,
    pos: { x: number; y: number; z: number },
    matName: string,
    opts: BoxOptions = {}
  ): Mesh {
    const mesh = MeshBuilder.CreateCylinder(name, { diameter, height, tessellation: 18 }, this.scene);
    mesh.position.set(pos.x, pos.y, pos.z);
    if (opts.rotX) mesh.rotation.x = opts.rotX;
    mesh.material = this.mat(matName);
    mesh.checkCollisions = opts.collide ?? true;
    mesh.receiveShadows = opts.receive ?? true;
    mesh.metadata = { surface: opts.surface ?? "metal" };
    if (opts.shadows ?? true) this.casters.push(mesh);
    this.statics.push(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------- мир

  private buildSky(): void {
    // Диаметр меньше дальней плоскости камеры (maxZ), иначе купол отсекается.
    const sky = MeshBuilder.CreateSphere("sky", { diameter: 620, segments: 20, sideOrientation: Mesh.BACKSIDE }, this.scene);
    const mat = new StandardMaterial("mat-sky", this.scene);
    mat.emissiveTexture = tiledCopy(this.textures.sky, this.scene, 1, 1);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    sky.material = mat;
    sky.infiniteDistance = true;
    sky.isPickable = false;
    sky.checkCollisions = false;
    sky.applyFog = false;
    this.materials["sky"] = mat;
  }

  private buildGround(): void {
    const ground = MeshBuilder.CreateGround("ground", { width: 260, height: 260, subdivisions: 4 }, this.scene);
    ground.material = this.mat("floor");
    ground.checkCollisions = true;
    ground.receiveShadows = true;
    ground.metadata = { surface: "concrete" };
    this.statics.push(ground);

    // Грунтовая полоса за огневым рубежом — визуально отделяет зону мишеней.
    const dirt = MeshBuilder.CreateGround("ground-dirt", { width: 46, height: 78, subdivisions: 4 }, this.scene);
    dirt.position.set(0, 0.02, 44);
    dirt.material = this.mat("dirt");
    dirt.checkCollisions = false;
    dirt.receiveShadows = true;
    dirt.metadata = { surface: "dirt" };
    this.statics.push(dirt);
  }

  private buildFiringLine(): void {
    // Бетонная плита под навесом.
    this.box("shed-slab", { w: 28, h: 0.3, d: 12 }, { x: 0, y: 0.15, z: -4 }, "asphalt", {
      shadows: false,
      surface: "concrete",
    });

    // Столбы и крыша.
    for (let i = -2; i <= 2; i++) {
      const x = i * 6.5;
      this.cylinder("post", 0.24, 3.6, { x, y: 1.95, z: -9.2 }, "metalDark");
      this.cylinder("post", 0.24, 3.6, { x, y: 1.95, z: 1.2 }, "metalDark");
    }
    this.box("roof", { w: 28.4, h: 0.22, d: 11.4 }, { x: 0, y: 3.85, z: -4 }, "metalDark", { surface: "metal" });
    // Задняя стенка навеса.
    this.box("shed-back", { w: 28.4, h: 3.6, d: 0.4 }, { x: 0, y: 1.8, z: -9.6 }, "wall");

    // Огневой рубеж: невысокие бетонные тумбы с проходами — удобно для приседа и наклонов.
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      this.box("bench", { w: 1.6, h: 1.05, d: 0.7 }, { x: i * 3.2, y: 0.83, z: 1.0 }, "wall", { surface: "concrete" });
    }
  }

  private buildLanes(): void {
    // Разделители дорожек.
    for (const x of [-9.6, -3.2, 3.2, 9.6]) {
      this.box("lane-wall", { w: 0.35, h: 1.15, d: 16 }, { x, y: 0.58, z: 9 }, "wall");
    }
    // Поперечные отметки на земле.
    for (const z of [10, 25, 50]) {
      const strip = MeshBuilder.CreateGround("lane-mark", { width: 30, height: 0.35 }, this.scene);
      strip.position.set(0, 0.03, z);
      const mat = this.materials["laneMark"] ?? new StandardMaterial("mat-laneMark", this.scene);
      mat.diffuseColor = new Color3(0.85, 0.74, 0.2);
      mat.specularColor = Color3.Black();
      this.materials["laneMark"] = mat;
      strip.material = mat;
      strip.isPickable = false;
      strip.checkCollisions = false;
      this.statics.push(strip);
    }
  }

  private buildPerimeter(): void {
    // Боковые стены.
    // Периметр и вал НЕ кастят тени: их габариты растянули бы ортобокс карты
    // теней на весь полигон, и тени у игрока стали бы мыльными.
    this.box("wall-left", { w: 0.6, h: 6, d: 110 }, { x: -24, y: 3, z: 36 }, "wallTall", { shadows: false });
    this.box("wall-right", { w: 0.6, h: 6, d: 110 }, { x: 24, y: 3, z: 36 }, "wallTall", { shadows: false });
    // Земляной вал-пулеуловитель за мишенями.
    this.box("berm", { w: 50, h: 9, d: 12 }, { x: 0, y: 3.2, z: 86 }, "berm", {
      surface: "dirt",
      rotX: -0.22,
      shadows: false,
    });
    this.box("berm-base", { w: 50, h: 4, d: 8 }, { x: 0, y: 2, z: 80 }, "berm", { surface: "dirt", shadows: false });
  }

  private buildCover(): void {
    // Деревянные ящики (в том числе штабелем — на них можно забраться).
    const crates: Array<[number, number, number]> = [
      [-13, 0.6, 8],
      [-13, 1.8, 8],
      [-11.6, 0.6, 9.4],
      [13.5, 0.6, 12],
      [12.2, 0.6, 13.4],
      [12.2, 1.8, 13.4],
      [-6.5, 0.6, 20],
      [7.5, 0.6, 24],
    ];
    for (const [x, y, z] of crates) {
      this.box("crate", { w: 1.2, h: 1.2, d: 1.2 }, { x, y, z }, "wood", {
        surface: "wood",
        rotY: (Math.random() - 0.5) * 0.4,
      });
    }

    // Бочки.
    for (const [x, z] of [
      [-16, 14],
      [-15.2, 15.6],
      [16.5, 7],
      [4.2, 31],
    ] as Array<[number, number]>) {
      this.cylinder("barrel", 0.62, 0.94, { x, y: 0.47, z }, "metal", { surface: "metal" });
    }

    // Стенки из мешков с песком: видимые мешки + один невидимый коллайдер.
    this.sandbagWall(-18, 6, 4);
    this.sandbagWall(18.5, 18, 4);
    this.sandbagWall(0, 36, 6);

    // Разрушенная стена с проёмами — практика стрельбы из-за укрытия и наклонов.
    const z = 16.5;
    this.box("ruin-a", { w: 3.2, h: 2.6, d: 0.5 }, { x: -7.5, y: 1.3, z }, "wall");
    this.box("ruin-b", { w: 3.2, h: 2.6, d: 0.5 }, { x: 7.5, y: 1.3, z }, "wall");
    this.box("ruin-c", { w: 4.2, h: 1.0, d: 0.5 }, { x: 0, y: 0.5, z }, "wall");
    this.box("ruin-d", { w: 4.2, h: 0.55, d: 0.5 }, { x: 0, y: 2.35, z }, "wall");
  }

  private sandbagWall(x: number, z: number, rows: number): void {
    const bagMat = this.mat("sandbag");
    for (let r = 0; r < rows; r++) {
      const count = 6 - Math.floor(r / 2);
      for (let i = 0; i < count; i++) {
        const bag = MeshBuilder.CreateSphere(`bag`, { diameter: 0.62, segments: 6 }, this.scene);
        bag.scaling.set(1, 0.52, 0.72);
        bag.position.set(x + (i - (count - 1) / 2) * 0.58 + (r % 2) * 0.14, 0.17 + r * 0.28, z);
        bag.rotation.y = (Math.random() - 0.5) * 0.3;
        bag.material = bagMat;
        bag.checkCollisions = false;
        bag.receiveShadows = true;
        bag.metadata = { surface: "sand" };
        this.casters.push(bag);
        this.statics.push(bag);
      }
    }
    // Единый коллайдер вместо 20 отдельных — заметно дешевле для moveWithCollisions.
    const collider = MeshBuilder.CreateBox("bag-collider", { width: 3.6, height: rows * 0.28, depth: 0.8 }, this.scene);
    collider.position.set(x, (rows * 0.28) / 2, z);
    collider.isVisible = false;
    collider.isPickable = false;
    collider.checkCollisions = true;
    this.statics.push(collider);
  }

  private buildElevatedPlatform(): void {
    // Площадка слева + пандус: можно стрелять сверху и отрабатывать прыжки.
    this.box("platform", { w: 7, h: 0.4, d: 7 }, { x: -17, y: 2.2, z: 26 }, "wood", { surface: "wood" });
    for (const [dx, dz] of [
      [-3.2, -3.2],
      [3.2, -3.2],
      [-3.2, 3.2],
      [3.2, 3.2],
    ] as Array<[number, number]>) {
      this.box("platform-leg", { w: 0.35, h: 2.2, d: 0.35 }, { x: -17 + dx, y: 1.1, z: 26 + dz }, "wood", {
        surface: "wood",
      });
    }
    this.box("ramp", { w: 3.2, h: 0.3, d: 8.4 }, { x: -17, y: 1.15, z: 21.2 }, "wood", {
      surface: "wood",
      rotX: -0.3,
    });
    // Перила по краю площадки.
    this.box("rail", { w: 7, h: 0.12, d: 0.12 }, { x: -17, y: 3.3, z: 29.4 }, "metalDark", { surface: "metal" });
    this.box("rail", { w: 0.12, h: 0.12, d: 7 }, { x: -20.4, y: 3.3, z: 26 }, "metalDark", { surface: "metal" });
  }

  private buildSigns(): void {
    for (const dist of [10, 25, 50]) {
      const sign = MeshBuilder.CreatePlane("sign", { width: 1.1, height: 1.1 }, this.scene);
      sign.position.set(-13.5, 1.6, dist);
      sign.rotation.y = -Math.PI / 2 + 0.35;
      const mat = new StandardMaterial(`mat-sign-${dist}`, this.scene);
      mat.diffuseTexture = makeDistanceSign(this.scene, String(dist));
      mat.specularColor = Color3.Black();
      mat.backFaceCulling = false;
      sign.material = mat;
      sign.checkCollisions = false;
      sign.metadata = { surface: "metal" };
      this.materials[`sign${dist}`] = mat;
      this.statics.push(sign);

      this.cylinder("sign-post", 0.1, 1.6, { x: -13.5, y: 0.8, z: dist }, "metalDark", { shadows: false });
    }
  }

  /**
   * Регистрирует статику как источники теней и замораживает всё неподвижное.
   * Заморозка — последним шагом: материалы к этому моменту уже знают о тенях.
   */
  finalize(): void {
    for (const m of this.casters) this.shadowGenerator.addShadowCaster(m, false);
    for (const m of this.statics) m.freezeWorldMatrix();
  }
}
