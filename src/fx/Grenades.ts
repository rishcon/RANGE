import {
  AbstractMesh,
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PointLight,
  Ray,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { clamp01, randRange } from "../core/MathUtil";
import type { Player } from "../player/Player";
import type { TargetManager } from "../world/Targets";
import type { TextureLibrary } from "../world/Textures";
import type { GrenadeConfig, GrenadeKind } from "../weapons/WeaponConfig";
import type { AudioManager } from "./AudioManager";
import type { Effects } from "./Effects";

const GRAVITY = 19.5;
const RADIUS = 0.05;
/** Сколько скорости остаётся после удара о поверхность. */
const RESTITUTION = 0.38;
const FRICTION = 0.72;

interface LiveGrenade {
  cfg: GrenadeConfig;
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
  fuse: number;
  bounces: number;
  resting: boolean;
}

interface SmokeCloud {
  system: ParticleSystem;
  life: number;
  stopping: boolean;
}

export interface GrenadeCallbacks {
  /** Ослепление игрока: сила 0..1 и длительность в секундах. */
  onFlash?: (intensity: number, duration: number) => void;
  /** Итог осколочного взрыва для статистики. */
  onFragHits?: (hits: number, kills: number) => void;
}

/**
 * Брошенные гранаты: полёт с отскоками, подрыв и эффекты.
 *
 * Физика намеренно простая — снаряд ведётся рейкастом по направлению движения,
 * этого достаточно для дуг и отскоков от стен полигона.
 */
export class GrenadeSystem {
  private readonly live: LiveGrenade[] = [];
  private readonly clouds: SmokeCloud[] = [];
  private readonly prototypes = new Map<GrenadeKind, Mesh>();

  private readonly explosionFire: ParticleSystem;
  private readonly explosionSmoke: ParticleSystem;
  private readonly explosionLight: PointLight;
  private lightTimer = 0;

  private readonly step = new Vector3();
  private readonly ray = new Ray(new Vector3(), new Vector3(), 1);
  private readonly losRay = new Ray(new Vector3(), new Vector3(), 1);
  private readonly tmp = new Vector3();
  private readonly tmpTarget = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly textures: TextureLibrary,
    private readonly audio: AudioManager,
    private readonly targets: TargetManager,
    private readonly player: Player,
    private readonly effects: Effects,
    private readonly callbacks: GrenadeCallbacks = {}
  ) {
    this.buildPrototypes();

    this.explosionFire = this.makeSystem("fx-boom-fire", 600, {
      color1: new Color4(1, 0.85, 0.35, 1),
      color2: new Color4(1, 0.4, 0.08, 1),
      minSize: 0.2,
      maxSize: 1.1,
      minLife: 0.18,
      maxLife: 0.5,
      power: [6, 18],
      gravity: -2,
      additive: true,
    });
    this.explosionSmoke = this.makeSystem("fx-boom-smoke", 400, {
      color1: new Color4(0.28, 0.27, 0.26, 0.9),
      color2: new Color4(0.15, 0.14, 0.13, 0.7),
      minSize: 0.6,
      maxSize: 2.4,
      minLife: 0.8,
      maxLife: 2,
      power: [1.5, 6],
      gravity: 1.2,
      additive: false,
    });

    this.explosionLight = new PointLight("fx-boom-light", new Vector3(0, -50, 0), scene);
    this.explosionLight.diffuse = new Color3(1, 0.75, 0.4);
    this.explosionLight.intensity = 0;
    this.explosionLight.range = 26;
  }

  // ------------------------------------------------------------- заготовки

  private buildPrototypes(): void {
    const olive = new StandardMaterial("mat-gren-olive", this.scene);
    olive.diffuseColor = new Color3(0.16, 0.2, 0.13);
    olive.specularColor = new Color3(0.1, 0.1, 0.1);

    const grey = new StandardMaterial("mat-gren-grey", this.scene);
    grey.diffuseColor = new Color3(0.24, 0.25, 0.26);
    grey.specularColor = new Color3(0.2, 0.2, 0.2);

    const frag = MeshBuilder.CreateSphere("thrown-frag", { diameter: 0.085, segments: 8 }, this.scene);
    frag.scaling.set(1, 1.15, 1);
    frag.material = olive;

    const smoke = MeshBuilder.CreateCylinder("thrown-smoke", { diameter: 0.062, height: 0.14, tessellation: 10 }, this.scene);
    smoke.material = olive;

    const flash = MeshBuilder.CreateCylinder("thrown-flash", { diameter: 0.062, height: 0.14, tessellation: 10 }, this.scene);
    flash.material = grey;

    for (const [kind, mesh] of [
      ["frag", frag],
      ["smoke", smoke],
      ["flash", flash],
    ] as Array<[GrenadeKind, Mesh]>) {
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.setEnabled(false);
      this.prototypes.set(kind, mesh);
    }
  }

  private makeSystem(
    name: string,
    capacity: number,
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
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = this.textures.particle;
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
    ps.direction1 = new Vector3(-1, -1, -1);
    ps.direction2 = new Vector3(1, 1, 1);
    ps.minAngularSpeed = -3;
    ps.maxAngularSpeed = 3;
    ps.updateSpeed = 0.016;
    ps.start();
    return ps;
  }

  // ----------------------------------------------------------------- бросок

  spawn(cfg: GrenadeConfig, position: Vector3, direction: Vector3, speed: number, inherit: Vector3 | null): void {
    const proto = this.prototypes.get(cfg.kind);
    if (!proto) return;

    const mesh = proto.clone(`gren-${cfg.kind}`);
    mesh.setEnabled(true);
    mesh.isVisible = true;
    mesh.position.copyFrom(position);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);

    const velocity = direction.scale(speed);
    if (inherit) velocity.addInPlace(inherit);

    this.live.push({
      cfg,
      mesh,
      velocity,
      spin: new Vector3(randRange(-10, 10), randRange(-10, 10), randRange(-10, 10)),
      fuse: cfg.fuse,
      bounces: 0,
      resting: false,
    });
  }

  // -------------------------------------------------------------------- кадр

  update(dt: number): void {
    this.updateFlight(dt);
    this.updateClouds(dt);

    if (this.lightTimer > 0) {
      this.lightTimer = Math.max(0, this.lightTimer - dt);
      this.explosionLight.intensity = (this.lightTimer / 0.25) * 30;
      if (this.lightTimer <= 0) this.explosionLight.intensity = 0;
    }
  }

  private updateFlight(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const g = this.live[i]!;
      g.fuse -= dt;

      if (!g.resting) {
        g.velocity.y -= GRAVITY * dt;
        this.step.copyFrom(g.velocity).scaleInPlace(dt);
        const travel = this.step.length();

        if (travel > 1e-5) {
          this.ray.origin.copyFrom(g.mesh.position);
          this.ray.direction.copyFrom(this.step).normalize();
          this.ray.length = travel + RADIUS;

          const hit = this.scene.pickWithRay(this.ray, GrenadeSystem.solidPredicate);
          if (hit?.hit && hit.pickedPoint) {
            const normal = hit.getNormal(true, true) ?? Vector3.Up();
            // Ставим гранату вплотную к поверхности и отражаем скорость.
            g.mesh.position.copyFrom(hit.pickedPoint).addInPlace(normal.scale(RADIUS));
            const dot = Vector3.Dot(g.velocity, normal);
            g.velocity.subtractInPlace(normal.scale(2 * dot));
            g.velocity.scaleInPlace(RESTITUTION);
            g.velocity.x *= FRICTION;
            g.velocity.z *= FRICTION;
            g.spin.scaleInPlace(0.6);
            g.bounces++;
            if (g.bounces < 6 && g.velocity.length() > 1.2) {
              this.audio.grenadeBounce(Vector3.Distance(g.mesh.position, this.player.camera.globalPosition));
            }
            if (g.velocity.length() < 0.55) {
              g.resting = true;
              g.velocity.setAll(0);
            }
          } else {
            g.mesh.position.addInPlace(this.step);
          }
        }

        g.mesh.rotation.x += g.spin.x * dt;
        g.mesh.rotation.y += g.spin.y * dt;
        g.mesh.rotation.z += g.spin.z * dt;
      }

      if (g.fuse <= 0) {
        this.detonate(g);
        g.mesh.dispose();
        this.live.splice(i, 1);
      }
    }
  }

  // ----------------------------------------------------------------- подрыв

  private detonate(g: LiveGrenade): void {
    const point = g.mesh.position.clone();
    const distance = Vector3.Distance(point, this.player.camera.globalPosition);

    switch (g.cfg.kind) {
      case "frag":
        this.explode(point, g.cfg, distance);
        break;
      case "smoke":
        this.spawnSmoke(point, g.cfg);
        this.audio.smokePop(distance);
        break;
      case "flash":
        this.flashBang(point, g.cfg, distance);
        break;
    }
  }

  private explode(point: Vector3, cfg: GrenadeConfig, distance: number): void {
    this.explosionFire.emitter = point.clone();
    this.explosionFire.manualEmitCount = 160;
    this.explosionSmoke.emitter = point.clone();
    this.explosionSmoke.manualEmitCount = 90;

    this.explosionLight.position.copyFrom(point);
    this.lightTimer = 0.25;
    this.explosionLight.intensity = 30;

    this.audio.explosion(distance);

    // Копоть на ближайшей поверхности под эпицентром.
    this.losRay.origin.copyFrom(point);
    this.losRay.direction.set(0, -1, 0);
    this.losRay.length = 2.5;
    const ground = this.scene.pickWithRay(this.losRay, GrenadeSystem.solidPredicate);
    if (ground?.hit && ground.pickedPoint && ground.pickedMesh) {
      const normal = ground.getNormal(true, true) ?? Vector3.Up();
      this.effects.impact(ground.pickedPoint, normal, ground.pickedMesh, "dirt");
    }

    const result = this.targets.applyExplosion(point, cfg.damage, cfg.damageRadius, (target) =>
      this.hasLineOfSight(point, target)
    );
    if (result.hits > 0) this.callbacks.onFragHits?.(result.hits, result.kills);
  }

  private spawnSmoke(point: Vector3, cfg: GrenadeConfig): void {
    const ps = new ParticleSystem(`fx-smoke-${Date.now()}`, 700, this.scene);
    ps.particleTexture = this.textures.particle;
    ps.emitter = point.add(new Vector3(0, 0.35, 0));
    ps.createSphereEmitter(cfg.smokeRadius * 0.55, 0.6);
    ps.color1 = new Color4(0.86, 0.87, 0.88, 0.85);
    ps.color2 = new Color4(0.68, 0.7, 0.72, 0.8);
    ps.colorDead = new Color4(0.7, 0.72, 0.74, 0);
    ps.minSize = cfg.smokeRadius * 0.7;
    ps.maxSize = cfg.smokeRadius * 1.25;
    ps.minLifeTime = 4;
    ps.maxLifeTime = 7;
    ps.emitRate = 90;
    ps.minEmitPower = 0.1;
    ps.maxEmitPower = 0.7;
    ps.gravity = new Vector3(0, 0.25, 0);
    ps.minAngularSpeed = -0.5;
    ps.maxAngularSpeed = 0.5;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.updateSpeed = 0.016;
    ps.start();

    this.clouds.push({ system: ps, life: cfg.smokeDuration, stopping: false });
  }

  private updateClouds(dt: number): void {
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i]!;
      c.life -= dt;
      if (!c.stopping && c.life <= 0) {
        // Перестаём испускать и даём облаку рассеяться естественно.
        c.system.stop();
        c.stopping = true;
        c.life = 8;
      } else if (c.stopping && c.life <= 0) {
        c.system.dispose();
        this.clouds.splice(i, 1);
      }
    }
  }

  /**
   * Сила ослепления: ближе, прямее в лицо и без препятствий — ярче.
   * Ровно та же логика, что в тактических шутерах.
   */
  private flashBang(point: Vector3, cfg: GrenadeConfig, distance: number): void {
    this.explosionFire.emitter = point.clone();
    this.explosionFire.manualEmitCount = 70;
    this.explosionLight.position.copyFrom(point);
    this.explosionLight.intensity = 40;
    this.lightTimer = 0.2;

    this.audio.flashBang(distance);

    const eye = this.player.camera.globalPosition;
    const visible = this.hasLineOfSight(point, eye);
    const falloff = clamp01(1 - distance / cfg.flashRadius);

    let intensity = 0;
    if (visible && falloff > 0) {
      this.player.getAimForward(this.tmp);
      this.tmpTarget.copyFrom(point).subtractInPlace(eye).normalize();
      const facing = Vector3.Dot(this.tmp, this.tmpTarget); // 1 — смотрим прямо на вспышку
      // За спиной (facing < -0.2) эффект почти нулевой.
      const angleFactor = clamp01((facing + 0.35) / 1.35);
      intensity = clamp01(falloff * 0.55 + falloff * angleFactor * 0.75);
    }

    if (intensity > 0.02) {
      const duration = cfg.flashDuration * intensity;
      this.callbacks.onFlash?.(intensity, duration);
      this.audio.deafen(duration * 0.8, intensity);
    }
  }

  private hasLineOfSight(from: Vector3, to: Vector3): boolean {
    this.tmp.copyFrom(to).subtractInPlace(from);
    const dist = this.tmp.length();
    if (dist < 0.05) return true;
    this.losRay.origin.copyFrom(from);
    this.losRay.direction.copyFrom(this.tmp).scaleInPlace(1 / dist);
    this.losRay.length = dist - 0.1;
    const hit = this.scene.pickWithRay(this.losRay, GrenadeSystem.solidPredicate);
    return !hit?.hit;
  }

  clear(): void {
    for (const g of this.live) g.mesh.dispose();
    this.live.length = 0;
    for (const c of this.clouds) c.system.dispose();
    this.clouds.length = 0;
    this.explosionLight.intensity = 0;
    this.lightTimer = 0;
  }

  /** Препятствия для полёта и проверки видимости — только геометрия уровня. */
  private static solidPredicate(mesh: AbstractMesh): boolean {
    return mesh.checkCollisions && mesh.isEnabled();
  }
}
