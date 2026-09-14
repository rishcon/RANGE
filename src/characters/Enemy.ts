import { Mesh, Scene, Vector3 } from "@babylonjs/core";
import { clamp01, damp, randRange } from "../core/MathUtil";
import type { HitContext, HitResult, HitZone, IHittable } from "../world/Targets";
import { Character, ENEMY_PALETTE, type CharacterState } from "./Character";

const MAX_HEALTH = 100;
const RESPAWN_DELAY = 7;
const DEATH_DURATION = 1.25;
const WALK_SPEED = 1.9;
const GRAVITY = 19.5;

type Behaviour = "walk" | "stand" | "crouch";

/**
 * Боец на полигоне: ходит по маршруту, приседает, подпрыгивает и падает
 * от попаданий. Стрельбы по игроку нет — это живая мишень, а не бой.
 */
export class Enemy implements IHittable {
  readonly character: Character;

  private health = MAX_HEALTH;
  private deathT = 0;
  private deadTimer = 0;

  private behaviour: Behaviour = "walk";
  private behaviourTimer = randRange(1.5, 5);
  private crouchT = 0;
  private facing: number;
  private speedRatio = 0;

  private readonly position = new Vector3();
  private readonly from: Vector3;
  private readonly to: Vector3;
  private travel = 0;
  private direction = 1;

  private verticalVelocity = 0;
  private airborne = false;
  private jumpCooldown = randRange(4, 10);

  private readonly state: CharacterState = {
    speed: 0,
    crouch: 0,
    grounded: true,
    verticalVelocity: 0,
    lookPitch: 0,
    lean: 0,
    death: 0,
  };

  constructor(scene: Scene, from: Vector3, to: Vector3) {
    this.from = from.clone();
    this.to = to.clone();
    this.position.copyFrom(from);
    this.facing = Math.atan2(to.x - from.x, to.z - from.z);

    this.character = new Character(scene, ENEMY_PALETTE, { holdWeapon: true, namePrefix: "enemy" });
    this.character.setHitOwner(this);
    this.character.root.position.copyFrom(this.position);
    this.character.root.rotation.y = this.facing;
  }

  get dead(): boolean {
    return this.deathT > 0;
  }

  /** Центр массы — по нему считается урон от взрыва. */
  getCenter(out: Vector3): Vector3 {
    return out.copyFrom(this.position).addInPlaceFromFloats(0, 1.05, 0);
  }

  applyHit(damage: number, zone: HitZone, hit?: HitContext): HitResult {
    if (this.dead) return { damage: 0, zone, killed: false, ignored: true };

    this.health -= damage;
    const killed = this.health <= 0;
    if (killed) {
      this.deathT = 0.0001;
      this.deadTimer = RESPAWN_DELAY;
      this.verticalVelocity = 0;
      this.airborne = false;
      this.collapse(hit);
    }
    return { damage, zone, killed, ignored: false };
  }

  /** Переход в рэгдолл: тело подхватывает и собственную скорость, и импульс пули. */
  private collapse(hit?: HitContext): void {
    const velocity = this.to
      .subtract(this.from)
      .normalize()
      .scaleInPlace(this.direction * WALK_SPEED * this.speedRatio);
    velocity.y = this.verticalVelocity;

    const impulse = hit ? hit.direction.scale(hit.force) : new Vector3(0, 1, 0);
    const point = hit ? hit.point : this.position.add(new Vector3(0, 1.2, 0));
    this.character.startRagdoll(velocity, impulse, point);
  }

  update(dt: number, playerPos: Vector3): void {
    if (this.dead) {
      this.updateDeath(dt);
      // Телом управляет рэгдолл — корень двигать больше нельзя.
      this.state.death = clamp01(this.deathT);
      this.character.groundY = 0;
      this.character.update(dt, this.state);
      return;
    }

    {
      this.updateBehaviour(dt);
      this.updateMovement(dt);
      this.updateFacing(dt, playerPos);
    }

    this.state.speed = this.speedRatio;
    this.state.crouch = this.crouchT;
    this.state.grounded = !this.airborne;
    this.state.verticalVelocity = this.verticalVelocity;
    this.state.death = clamp01(this.deathT);

    this.character.groundY = 0;
    this.character.root.position.copyFrom(this.position);
    this.character.root.rotation.y = this.facing;
    this.character.update(dt, this.state);
  }

  // ---------------------------------------------------------------- поведение

  private updateBehaviour(dt: number): void {
    this.behaviourTimer -= dt;
    if (this.behaviourTimer <= 0) {
      // Простая смена занятий: походил — постоял — присел — снова пошёл.
      const roll = Math.random();
      if (roll < 0.5) {
        this.behaviour = "walk";
        this.behaviourTimer = randRange(3, 7);
      } else if (roll < 0.78) {
        this.behaviour = "crouch";
        this.behaviourTimer = randRange(2, 4.5);
      } else {
        this.behaviour = "stand";
        this.behaviourTimer = randRange(1.5, 3.5);
      }
    }

    const wantCrouch = this.behaviour === "crouch" ? 1 : 0;
    this.crouchT = damp(this.crouchT, wantCrouch, 6, dt);

    // Прыжки — редкие и только стоя на ногах.
    this.jumpCooldown -= dt;
    if (this.jumpCooldown <= 0 && !this.airborne && this.behaviour !== "crouch") {
      this.jumpCooldown = randRange(5, 12);
      this.verticalVelocity = 5.6;
      this.airborne = true;
    }
  }

  private updateMovement(dt: number): void {
    // Вертикаль: прыжок и приземление.
    if (this.airborne) {
      this.verticalVelocity -= GRAVITY * dt;
      this.position.y += this.verticalVelocity * dt;
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.verticalVelocity = 0;
        this.airborne = false;
      }
    }

    const moving = this.behaviour === "walk" && !this.airborne;
    const targetSpeed = moving ? 1 : 0;
    this.speedRatio = damp(this.speedRatio, targetSpeed, 5, dt);

    if (this.speedRatio > 0.02) {
      const length = Vector3.Distance(this.from, this.to);
      if (length > 0.1) {
        this.travel += this.direction * WALK_SPEED * this.speedRatio * dt;
        if (this.travel >= length) {
          this.travel = length;
          this.direction = -1;
        } else if (this.travel <= 0) {
          this.travel = 0;
          this.direction = 1;
        }
        const t = this.travel / length;
        const y = this.position.y;
        Vector3.LerpToRef(this.from, this.to, t, this.position);
        this.position.y = y;
      }
    }
  }

  private updateFacing(dt: number, playerPos: Vector3): void {
    // Вблизи боец разворачивается к игроку, иначе смотрит по маршруту.
    const toPlayer = playerPos.subtract(this.position);
    toPlayer.y = 0;
    const distance = toPlayer.length();

    let target: number;
    if (distance < 18 && distance > 0.5) {
      target = Math.atan2(toPlayer.x, toPlayer.z);
    } else {
      const path = this.to.subtract(this.from).scaleInPlace(this.direction);
      target = Math.atan2(path.x, path.z);
    }

    // Кратчайший путь по кругу, иначе боец крутится на 350° вместо 10°.
    let delta = target - this.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.facing += delta * (1 - Math.exp(-6 * dt));
  }

  private updateDeath(dt: number): void {
    this.deathT = Math.min(1, this.deathT + dt / DEATH_DURATION);
    this.speedRatio = 0;
    this.crouchT = 0;

    this.deadTimer -= dt;
    if (this.deadTimer <= 0) this.respawn();
  }

  private respawn(): void {
    this.health = MAX_HEALTH;
    this.deathT = 0;
    this.position.y = 0;
    this.verticalVelocity = 0;
    this.airborne = false;
    this.behaviour = "walk";
    this.behaviourTimer = randRange(2, 5);
    this.jumpCooldown = randRange(4, 10);
    this.character.reset();
  }

  reset(): void {
    this.travel = 0;
    this.direction = 1;
    this.position.copyFrom(this.from);
    this.respawn();
  }

  dispose(): void {
    this.character.dispose();
  }
}

/** Расстановка бойцов и их обновление. */
export class EnemyManager {
  private readonly enemies: Enemy[] = [];

  constructor(scene: Scene) {
    // Маршруты вдоль дорожек полигона: бойцы ходят поперёк линии огня.
    const routes: Array<[Vector3, Vector3]> = [
      [new Vector3(-7.5, 0, 21), new Vector3(-2.5, 0, 21)],
      [new Vector3(3, 0, 27), new Vector3(9, 0, 27)],
      [new Vector3(-12, 0, 33), new Vector3(-6, 0, 33)],
      [new Vector3(6, 0, 38), new Vector3(13, 0, 38)],
      [new Vector3(-3, 0, 45), new Vector3(4, 0, 45)],
      [new Vector3(-15, 0, 50), new Vector3(-9, 0, 50)],
      [new Vector3(10, 0, 55), new Vector3(16, 0, 55)],
    ];

    for (const [from, to] of routes) this.enemies.push(new Enemy(scene, from, to));
  }

  get all(): readonly Enemy[] {
    return this.enemies;
  }

  update(dt: number, playerPos: Vector3): void {
    for (const e of this.enemies) e.update(dt, playerPos);
  }

  resetAll(): void {
    for (const e of this.enemies) e.reset();
  }

  forEachMesh(fn: (mesh: Mesh) => void): void {
    for (const e of this.enemies) for (const m of e.character.meshes) fn(m);
  }
}
