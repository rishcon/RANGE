import {
  AbstractMesh,
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { randRange } from "../core/MathUtil";
import type { SurfaceKind } from "../world/Level";
import type { TextureLibrary } from "../world/Textures";

const MAX_DECALS = 90;
const TRACER_POOL = 14;
const SHELL_POOL = 18;

interface Tracer {
  mesh: Mesh;
  life: number;
  maxLife: number;
}

interface Shell {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
  life: number;
  resting: boolean;
  /** Звенела ли уже о землю — звук играем один раз. */
  clinked: boolean;
}

/** Попадания, следы, трассеры и вылетающие гильзы. */
export class Effects {
  private readonly decals: Mesh[] = [];
  private readonly decalMaterial: StandardMaterial;

  private readonly dust: ParticleSystem;
  private readonly sparks: ParticleSystem;
  private readonly debris: ParticleSystem;

  private readonly tracers: Tracer[] = [];
  private readonly shells: Shell[] = [];
  private tracerIndex = 0;
  private shellIndex = 0;

  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpMid = new Vector3();

  /** Гильза упала на поверхность — сюда подвешивается звук. */
  onShellLand: ((distance: number) => void) | null = null;

  constructor(
    private readonly scene: Scene,
    textures: TextureLibrary
  ) {
    this.decalMaterial = new StandardMaterial("mat-decal", scene);
    this.decalMaterial.diffuseTexture = textures.bulletHole;
    this.decalMaterial.diffuseTexture.hasAlpha = true;
    this.decalMaterial.useAlphaFromDiffuseTexture = true;
    this.decalMaterial.specularColor = Color3.Black();
    this.decalMaterial.zOffset = -3;
    this.decalMaterial.backFaceCulling = false;

    this.dust = this.makeParticles("fx-dust", textures, {
      color1: new Color4(0.72, 0.68, 0.6, 0.85),
      color2: new Color4(0.55, 0.52, 0.47, 0.6),
      minSize: 0.04,
      maxSize: 0.2,
      minLife: 0.25,
      maxLife: 0.65,
      power: [0.8, 2.6],
      gravity: -5,
      additive: false,
    });

    this.sparks = this.makeParticles("fx-sparks", textures, {
      color1: new Color4(1, 0.85, 0.4, 1),
      color2: new Color4(1, 0.45, 0.1, 1),
      minSize: 0.008,
      maxSize: 0.035,
      minLife: 0.18,
      maxLife: 0.55,
      power: [3, 8],
      gravity: -11,
      additive: true,
    });

    this.debris = this.makeParticles("fx-debris", textures, {
      color1: new Color4(0.45, 0.33, 0.2, 1),
      color2: new Color4(0.3, 0.22, 0.14, 0.9),
      minSize: 0.015,
      maxSize: 0.06,
      minLife: 0.3,
      maxLife: 0.8,
      power: [1.5, 4.5],
      gravity: -13,
      additive: false,
    });

    this.buildTracers();
    this.buildShells();
  }

  // ------------------------------------------------------------- частицы

  private makeParticles(
    name: string,
    textures: TextureLibrary,
    cfg: {
      color1: Color4;
      color2: Color4;
      minSize: number;
      maxSize: number;
      minLife: number;
      maxLife: number;
      power: [number, number];
      gravity: number;
      additive: boolean;
    }
  ): ParticleSystem {
    const ps = new ParticleSystem(name, 400, this.scene);
    ps.particleTexture = textures.particle;
    ps.emitter = new Vector3(0, -100, 0);
    ps.color1 = cfg.color1;
    ps.color2 = cfg.color2;
    ps.colorDead = new Color4(cfg.color2.r, cfg.color2.g, cfg.color2.b, 0);
    ps.minSize = cfg.minSize;
    ps.maxSize = cfg.maxSize;
    ps.minLifeTime = cfg.minLife;
    ps.maxLifeTime = cfg.maxLife;
    ps.emitRate = 0;
    ps.minEmitPower = cfg.power[0];
    ps.maxEmitPower = cfg.power[1];
    ps.gravity = new Vector3(0, cfg.gravity, 0);
    ps.blendMode = cfg.additive ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD;
    ps.minAngularSpeed = -4;
    ps.maxAngularSpeed = 4;
    ps.updateSpeed = 0.014;
    ps.start();
    return ps;
  }

  /** Разовый выброс частиц конусом вдоль нормали. */
  private burst(ps: ParticleSystem, point: Vector3, normal: Vector3, count: number, spread: number): void {
    // Два вектора, ортогональных нормали, задают раствор конуса.
    const t1 = Math.abs(normal.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const tangent = Vector3.Cross(normal, t1).normalize();
    const bitangent = Vector3.Cross(normal, tangent).normalize();

    this.tmpA.copyFrom(normal).addInPlace(tangent.scale(spread)).addInPlace(bitangent.scale(spread));
    this.tmpB.copyFrom(normal).subtractInPlace(tangent.scale(spread)).subtractInPlace(bitangent.scale(spread));

    ps.emitter = point.clone();
    ps.direction1 = this.tmpA.clone();
    ps.direction2 = this.tmpB.clone();
    ps.manualEmitCount = count;
  }

  // ---------------------------------------------------------------- попадание

  impact(point: Vector3, normal: Vector3, mesh: AbstractMesh, surface: SurfaceKind): void {
    switch (surface) {
      case "metal":
        this.burst(this.sparks, point, normal, 14, 0.55);
        this.burst(this.dust, point, normal, 4, 0.4);
        break;
      case "wood":
        this.burst(this.debris, point, normal, 10, 0.5);
        this.burst(this.dust, point, normal, 5, 0.35);
        break;
      case "sand":
      case "dirt":
        this.burst(this.dust, point, normal, 16, 0.6);
        break;
      case "dummy":
        this.burst(this.debris, point, normal, 8, 0.45);
        break;
      default:
        this.burst(this.dust, point, normal, 12, 0.5);
        this.burst(this.sparks, point, normal, 3, 0.6);
    }

    if (surface !== "dummy") this.addDecal(point, normal, mesh);
  }

  private addDecal(point: Vector3, normal: Vector3, mesh: AbstractMesh): void {
    // Декали не клеим на движущиеся/составные мелкие объекты — только на статику.
    if (!(mesh instanceof Mesh)) return;

    const size = randRange(0.1, 0.16);
    let decal: Mesh | null = null;
    try {
      decal = MeshBuilder.CreateDecal(`decal`, mesh, {
        position: point,
        normal,
        size: new Vector3(size, size, size),
        angle: Math.random() * Math.PI * 2,
      });
    } catch {
      // Редкие вырожденные случаи геометрии — просто пропускаем след.
      return;
    }
    if (!decal) return;

    decal.material = this.decalMaterial;
    decal.isPickable = false;
    decal.checkCollisions = false;
    decal.receiveShadows = false;
    decal.setParent(mesh);

    this.decals.push(decal);
    if (this.decals.length > MAX_DECALS) this.decals.shift()?.dispose();
  }

  clearDecals(): void {
    for (const d of this.decals) d.dispose();
    this.decals.length = 0;
  }

  // ---------------------------------------------------------------- трассеры

  private buildTracers(): void {
    const mat = new StandardMaterial("mat-tracer", this.scene);
    mat.emissiveColor = new Color3(1, 0.78, 0.35);
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.alpha = 0.85;
    mat.backFaceCulling = false;

    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = MeshBuilder.CreateBox(`tracer${i}`, { width: 0.022, height: 0.022, depth: 1 }, this.scene);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.isVisible = false;
      mesh.applyFog = false;
      this.tracers.push({ mesh, life: 0, maxLife: 0.06 });
    }
  }

  tracer(from: Vector3, to: Vector3): void {
    const t = this.tracers[this.tracerIndex]!;
    this.tracerIndex = (this.tracerIndex + 1) % this.tracers.length;

    const dist = Vector3.Distance(from, to);
    if (dist < 0.3) return;

    this.tmpMid.copyFrom(from).addInPlace(to).scaleInPlace(0.5);
    t.mesh.position.copyFrom(this.tmpMid);
    t.mesh.lookAt(to);
    t.mesh.scaling.set(1, 1, dist);
    t.mesh.isVisible = true;
    t.life = t.maxLife;
  }

  // ----------------------------------------------------------------- гильзы

  private buildShells(): void {
    const mat = new StandardMaterial("mat-shell", this.scene);
    mat.diffuseColor = new Color3(0.72, 0.56, 0.22);
    mat.specularColor = new Color3(0.6, 0.5, 0.3);
    mat.specularPower = 64;

    for (let i = 0; i < SHELL_POOL; i++) {
      const mesh = MeshBuilder.CreateCylinder(`shell${i}`, { diameter: 0.0095, height: 0.045, tessellation: 6 }, this.scene);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.isVisible = false;
      this.shells.push({
        mesh,
        velocity: new Vector3(),
        spin: new Vector3(),
        life: 0,
        resting: false,
        clinked: false,
      });
    }
  }

  /** `caliber` меняет только размер гильзы: у винтовки она заметно крупнее. */
  ejectShell(position: Vector3, right: Vector3, up: Vector3, forward: Vector3, caliber = "ar15"): void {
    const s = this.shells[this.shellIndex]!;
    this.shellIndex = (this.shellIndex + 1) % this.shells.length;

    const scale = caliber === "sniper" ? 1.5 : caliber === "pistol" ? 0.8 : 1;
    s.mesh.scaling.setAll(scale);
    s.mesh.position.copyFrom(position);
    s.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    s.mesh.isVisible = true;
    // Гильзы лежат подольше — их видно на земле после стрельбы.
    s.life = 12;
    s.resting = false;
    s.clinked = false;

    // Вправо-вверх-чуть назад, как у настоящего окна выброса.
    s.velocity.copyFrom(right).scaleInPlace(randRange(2.1, 3.4));
    s.velocity.addInPlace(up.scale(randRange(1.1, 2.0)));
    s.velocity.addInPlace(forward.scale(randRange(-0.5, 0.3)));
    s.spin.set(randRange(-20, 20), randRange(-20, 20), randRange(-20, 20));
  }

  // ------------------------------------------------------------------- кадр

  update(dt: number): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.mesh.isVisible = false;
      } else {
        const k = t.life / t.maxLife;
        t.mesh.scaling.x = 0.4 + k * 0.6;
        t.mesh.scaling.y = 0.4 + k * 0.6;
      }
    }

    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.isVisible = false;
        continue;
      }
      if (s.resting) continue;

      s.velocity.y -= 19.5 * dt;
      s.mesh.position.addInPlace(this.tmpA.copyFrom(s.velocity).scaleInPlace(dt));
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;

      // Примитивное «дно» — пол полигона; отскок и затухание.
      if (s.mesh.position.y <= 0.01) {
        s.mesh.position.y = 0.01;
        if (!s.clinked) {
          s.clinked = true;
          const cam = this.scene.activeCamera;
          this.onShellLand?.(cam ? Vector3.Distance(s.mesh.position, cam.globalPosition) : 5);
        }
        if (Math.abs(s.velocity.y) < 0.6) {
          s.resting = true;
          s.mesh.rotation.x = Math.PI / 2;
        } else {
          s.velocity.y = -s.velocity.y * 0.35;
          s.velocity.x *= 0.6;
          s.velocity.z *= 0.6;
          s.spin.scaleInPlace(0.5);
        }
      }
    }
  }
}
