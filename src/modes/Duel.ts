import { AbstractMesh, Ray, Scene, Vector3 } from "@babylonjs/core";
import { Character, ENEMY_PALETTE, type CharacterState } from "../characters/Character";
import { clamp01, damp, randRange } from "../core/MathUtil";
import type { AudioManager } from "../fx/AudioManager";
import type { Player } from "../player/Player";
import type { HitContext, HitResult, HitZone, IHittable } from "../world/Targets";

const BOT_HEALTH = 100;
const PLAYER_HEALTH = 100;

/** Дистанция, которую бот старается держать. */
const PREFERRED_MIN = 12;
const PREFERRED_MAX = 24;
const MOVE_SPEED = 3.2;
const GRAVITY = 19.5;

/** Стрельба: очередь, паузы и точность. */
const BURST_MIN = 3;
const BURST_MAX = 6;
const SHOT_INTERVAL = 0.11;
const BURST_PAUSE_MIN = 0.5;
const BURST_PAUSE_MAX = 1.4;
const MAG_SIZE = 30;
const RELOAD_TIME = 2.6;
const BOT_DAMAGE = 13;
/** Радиус «попадания» по корпусу игрока, м. */
const PLAYER_HIT_RADIUS = 0.42;

export type DuelPhase = "countdown" | "fight" | "roundOver";

export interface DuelCallbacks {
  onPlayerDamaged: (damage: number, fromDirection: Vector3) => void;
  onBotKilled: () => void;
}

/**
 * Противник в дуэли: держит дистанцию, стрейфит, приседает и стреляет
 * очередями. Попадание считается аналитически — насколько луч с разбросом
 * прошёл от центра корпуса игрока.
 */
export class DuelBot implements IHittable {
  readonly character: Character;

  private health = BOT_HEALTH;
  private deathTimer = 0;

  private readonly position = new Vector3();
  private facing = 0;
  private speedRatio = 0;
  private crouchT = 0;

  private crouchTarget = 0;
  private strafeDir = Math.random() < 0.5 ? -1 : 1;
  private strafeTimer = randRange(0.8, 2);
  private crouchTimer = randRange(2, 5);
  private verticalVelocity = 0;
  private airborne = false;

  private magazine = MAG_SIZE;
  private reloadTimer = 0;
  private burstLeft = 0;
  private shotTimer = 0;
  private burstPause = randRange(0.4, 1.2);
  /** Задержка реакции после появления цели в поле зрения. */
  private reaction = 0;

  private readonly state: CharacterState = {
    speed: 0,
    crouch: 0,
    grounded: true,
    verticalVelocity: 0,
    lookPitch: 0,
    lean: 0,
    death: 0,
  };

  private readonly eye = new Vector3();
  private readonly toPlayer = new Vector3();
  private readonly aim = new Vector3();
  private readonly right = new Vector3();
  private readonly closest = new Vector3();
  private readonly ray = new Ray(new Vector3(), new Vector3(), 1);

  constructor(
    private readonly scene: Scene,
    private readonly audio: AudioManager,
    private readonly callbacks: DuelCallbacks
  ) {
    this.character = new Character(scene, ENEMY_PALETTE, { holdWeapon: true, namePrefix: "duelbot" });
    this.character.setHitOwner(this);
  }

  get dead(): boolean {
    return this.health <= 0;
  }

  get healthRatio(): number {
    return clamp01(this.health / BOT_HEALTH);
  }

  getCenter(out: Vector3): Vector3 {
    return out.copyFrom(this.position).addInPlaceFromFloats(0, 1.05, 0);
  }

  applyHit(damage: number, zone: HitZone, hit?: HitContext): HitResult {
    if (this.dead) return { damage: 0, zone, killed: false, ignored: true };

    this.health -= damage;
    const killed = this.health <= 0;
    if (killed) {
      const velocity = new Vector3(0, this.verticalVelocity, 0);
      const impulse = hit ? hit.direction.scale(hit.force) : new Vector3(0, 1, 0);
      const point = hit ? hit.point : this.position.add(new Vector3(0, 1.2, 0));
      this.character.startRagdoll(velocity, impulse, point);
      this.callbacks.onBotKilled();
    }
    return { damage, zone, killed, ignored: false };
  }

  spawn(at: Vector3, lookAt: Vector3): void {
    this.health = BOT_HEALTH;
    this.deathTimer = 0;
    this.position.copyFrom(at);
    this.magazine = MAG_SIZE;
    this.reloadTimer = 0;
    this.burstLeft = 0;
    this.burstPause = randRange(0.3, 0.8);
    this.reaction = randRange(0.25, 0.5);
    this.speedRatio = 0;
    this.crouchT = 0;
    this.crouchTarget = 0;
    this.verticalVelocity = 0;
    this.airborne = false;

    this.toPlayer.copyFrom(lookAt).subtractInPlace(at);
    this.facing = Math.atan2(this.toPlayer.x, this.toPlayer.z);

    this.character.reset();
    this.character.setEnabled(true);
    this.character.root.position.copyFrom(this.position);
    this.character.root.rotation.y = this.facing;
  }

  setEnabled(enabled: boolean): void {
    this.character.setEnabled(enabled);
  }

  update(dt: number, player: Player, playerAlive: boolean): void {
    if (this.dead) {
      this.deathTimer += dt;
      this.state.death = 1;
      this.character.groundY = 0;
      this.character.update(dt, this.state);
      return;
    }

    const playerCenter = this.toPlayer.copyFrom(player.position).addInPlaceFromFloats(0, 1.0, 0);
    this.eye.copyFrom(this.position).addInPlaceFromFloats(0, 1.45 - this.crouchT * 0.45, 0);

    const visible = playerAlive && this.hasLineOfSight(playerCenter);
    this.updateAiming(dt, playerCenter, visible);
    this.updateMovement(dt, playerCenter, visible);
    this.updateShooting(dt, player, playerCenter, visible);

    this.state.speed = this.speedRatio;
    this.state.crouch = this.crouchT;
    this.state.crouchDrop = this.crouchT * 0.42;
    this.state.grounded = !this.airborne;
    this.state.verticalVelocity = this.verticalVelocity;
    this.state.death = 0;

    this.character.groundY = 0;
    this.character.root.position.copyFrom(this.position);
    this.character.root.rotation.y = this.facing;
    this.character.update(dt, this.state);
  }

  // -------------------------------------------------------------- поведение

  private hasLineOfSight(target: Vector3): boolean {
    this.aim.copyFrom(target).subtractInPlace(this.eye);
    const dist = this.aim.length();
    if (dist < 0.2) return true;
    this.ray.origin.copyFrom(this.eye);
    this.ray.direction.copyFrom(this.aim).scaleInPlace(1 / dist);
    this.ray.length = dist - 0.3;
    const hit = this.scene.pickWithRay(this.ray, DuelBot.solidPredicate);
    return !hit?.hit;
  }

  private updateAiming(dt: number, playerCenter: Vector3, visible: boolean): void {
    if (!visible) {
      this.reaction = randRange(0.2, 0.45);
      return;
    }
    this.reaction = Math.max(0, this.reaction - dt);

    // Доворот к цели ограничен по скорости — бот не «телепортирует» прицел.
    const target = Math.atan2(playerCenter.x - this.position.x, playerCenter.z - this.position.z);
    let delta = target - this.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxTurn = 4.5 * dt;
    this.facing += Math.max(-maxTurn, Math.min(maxTurn, delta));

    const dy = playerCenter.y - this.eye.y;
    const flat = Math.hypot(playerCenter.x - this.position.x, playerCenter.z - this.position.z);
    this.state.lookPitch = -Math.atan2(dy, Math.max(flat, 0.1));
  }

  private updateMovement(dt: number, playerCenter: Vector3, visible: boolean): void {
    const dx = playerCenter.x - this.position.x;
    const dz = playerCenter.z - this.position.z;
    const dist = Math.hypot(dx, dz) || 1;

    // Вперёд к игроку и вбок от него.
    const fx = dx / dist;
    const fz = dz / dist;
    this.right.set(fz, 0, -fx);

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = randRange(0.7, 1.8);
      this.strafeDir = -this.strafeDir;
    }

    // Присед — это остановка за укрытием, а не ходьба вприсядку: садится он
    // только когда дистанция уже устраивает.
    const wantsDistance = dist > PREFERRED_MAX || dist < PREFERRED_MIN;
    this.crouchTimer -= dt;
    if (this.crouchTimer <= 0) {
      this.crouchTimer = randRange(2.5, 6);
      this.crouchTarget = this.crouchTarget > 0.5 ? 0 : 1;
    }
    if (wantsDistance) this.crouchTarget = 0;
    this.crouchT = damp(this.crouchT, this.crouchTarget, 7, dt);

    // Подходим, если далеко, и отступаем, если игрок слишком близко.
    let approach = 0;
    if (dist > PREFERRED_MAX) approach = 1;
    else if (dist < PREFERRED_MIN) approach = -1;

    // Сидя боец не перемещается — только доворачивается и стреляет.
    const settled = this.crouchT > 0.35;
    const strafe = visible && !settled ? this.strafeDir : 0;
    if (settled) approach = 0;
    const speed = MOVE_SPEED;

    const vx = (fx * approach + this.right.x * strafe) * speed;
    const vz = (fz * approach + this.right.z * strafe) * speed;

    // Простое разрешение столкновений: пробуем шагнуть, при упоре — вдоль стены.
    this.tryMove(vx * dt, vz * dt);

    this.speedRatio = damp(this.speedRatio, Math.min(1, Math.hypot(vx, vz) / MOVE_SPEED), 6, dt);

    if (this.airborne) {
      this.verticalVelocity -= GRAVITY * dt;
      this.position.y += this.verticalVelocity * dt;
      if (this.position.y <= 0) {
        this.position.y = 0;
        this.verticalVelocity = 0;
        this.airborne = false;
      }
    }
  }

  private tryMove(dx: number, dz: number): void {
    const step = 0.45;
    this.ray.origin.copyFrom(this.position).addInPlaceFromFloats(0, 0.9, 0);
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return;

    this.ray.direction.set(dx / len, 0, dz / len);
    this.ray.length = len + step;
    const hit = this.scene.pickWithRay(this.ray, DuelBot.solidPredicate);
    if (hit?.hit) {
      // Упёрлись — скользим вдоль препятствия.
      this.position.x += dz * 0.5;
      this.position.z -= dx * 0.5;
      return;
    }
    this.position.x += dx;
    this.position.z += dz;
  }

  private updateShooting(dt: number, player: Player, playerCenter: Vector3, visible: boolean): void {
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.magazine = MAG_SIZE;
      return;
    }
    if (this.magazine <= 0) {
      this.reloadTimer = RELOAD_TIME;
      this.audio.magOut();
      return;
    }

    if (!visible || this.reaction > 0) return;

    if (this.burstLeft > 0) {
      this.shotTimer -= dt;
      if (this.shotTimer <= 0) {
        this.shotTimer = SHOT_INTERVAL;
        this.burstLeft--;
        this.fire(player, playerCenter);
        if (this.burstLeft === 0) this.burstPause = randRange(BURST_PAUSE_MIN, BURST_PAUSE_MAX);
      }
      return;
    }

    this.burstPause -= dt;
    if (this.burstPause <= 0) {
      this.burstLeft = Math.round(randRange(BURST_MIN, BURST_MAX));
      this.shotTimer = 0;
    }
  }

  private fire(player: Player, playerCenter: Vector3): void {
    this.magazine--;
    this.audio.shot("rifle");

    this.aim.copyFrom(playerCenter).subtractInPlace(this.eye);
    const distance = this.aim.length();
    this.aim.scaleInPlace(1 / Math.max(distance, 0.001));

    // Разброс растёт с дистанцией и когда цель движется.
    const moving = player.speedRatio;
    const spreadRad = (0.022 + distance * 0.0016 + moving * 0.03) * randRange(0.5, 1.5);
    const ax = randRange(-1, 1) * spreadRad;
    const ay = randRange(-1, 1) * spreadRad;

    this.right.set(this.aim.z, 0, -this.aim.x).normalize();
    const shot = this.aim.add(this.right.scale(ax)).addInPlaceFromFloats(0, ay, 0).normalize();

    // Ближайшее сближение луча с центром корпуса — это и есть проверка попадания.
    const t = Vector3.Dot(playerCenter.subtract(this.eye), shot);
    this.closest.copyFrom(this.eye).addInPlace(shot.scale(t));
    const miss = Vector3.Distance(this.closest, playerCenter);

    if (miss <= PLAYER_HIT_RADIUS && t > 0) {
      this.callbacks.onPlayerDamaged(BOT_DAMAGE, shot);
    }
  }

  private static solidPredicate(mesh: AbstractMesh): boolean {
    return mesh.checkCollisions && mesh.isEnabled();
  }
}

export interface DuelState {
  phase: DuelPhase;
  playerScore: number;
  botScore: number;
  countdown: number;
  message: string;
}

/** Раунды «один на один»: спавн, счёт и перезапуск. */
export class DuelMode {
  readonly bot: DuelBot;

  private phase: DuelPhase = "countdown";
  private timer = 3;
  private playerScore = 0;
  private botScore = 0;
  private message = "";
  private playerHealth = PLAYER_HEALTH;

  private readonly playerSpawn = new Vector3(0, 0.4, 8);
  private readonly botSpawn = new Vector3(0, 0, 38);

  constructor(
    scene: Scene,
    audio: AudioManager,
    private readonly player: Player,
    private readonly hooks: {
      onPlayerHit: (damage: number, direction: Vector3) => void;
      onPlayerDied: (direction: Vector3) => void;
      onRoundStart: () => void;
    }
  ) {
    this.bot = new DuelBot(scene, audio, {
      onPlayerDamaged: (damage, direction) => this.damagePlayer(damage, direction),
      onBotKilled: () => this.endRound(true),
    });
    this.bot.setEnabled(false);
  }

  get active(): boolean {
    return true;
  }

  get state(): DuelState {
    return {
      phase: this.phase,
      playerScore: this.playerScore,
      botScore: this.botScore,
      countdown: Math.max(0, this.timer),
      message: this.message,
    };
  }

  get playerHealthRatio(): number {
    return clamp01(this.playerHealth / PLAYER_HEALTH);
  }

  get botHealthRatio(): number {
    return this.bot.healthRatio;
  }

  get playerAlive(): boolean {
    return this.playerHealth > 0;
  }

  start(): void {
    this.playerScore = 0;
    this.botScore = 0;
    this.beginRound();
  }

  private beginRound(): void {
    this.phase = "countdown";
    this.timer = 3;
    this.message = "";
    this.playerHealth = PLAYER_HEALTH;

    // Сначала поднимаем игрока: камера смерти должна отпустить управление
    // до того, как тело телепортируется на новую позицию.
    this.hooks.onRoundStart();
    this.player.respawn();
    this.player.body.teleport(this.playerSpawn.clone());
    // Разворачиваем игрока к противнику.
    this.player.yaw = Math.atan2(this.botSpawn.x - this.playerSpawn.x, this.botSpawn.z - this.playerSpawn.z);
    this.player.pitch = 0;

    this.bot.spawn(this.botSpawn.clone(), this.playerSpawn);
    this.bot.setEnabled(true);
  }

  private damagePlayer(damage: number, direction: Vector3): void {
    if (this.phase !== "fight" || this.playerHealth <= 0) return;
    this.playerHealth = Math.max(0, this.playerHealth - damage);
    this.hooks.onPlayerHit(damage, direction);
    if (this.playerHealth <= 0) {
      this.hooks.onPlayerDied(direction);
      this.endRound(false);
    }
  }

  private endRound(playerWon: boolean): void {
    if (this.phase === "roundOver") return;
    this.phase = "roundOver";
    this.timer = playerWon ? 3.5 : 5;
    if (playerWon) {
      this.playerScore++;
      this.message = "РАУНД ВЫИГРАН";
    } else {
      this.botScore++;
      this.message = "РАУНД ПРОИГРАН";
    }
  }

  update(dt: number): void {
    switch (this.phase) {
      case "countdown":
        this.timer -= dt;
        this.message = this.timer > 0 ? String(Math.ceil(this.timer)) : "БОЙ";
        if (this.timer <= 0) {
          this.phase = "fight";
          this.message = "";
        }
        break;
      case "roundOver":
        this.timer -= dt;
        if (this.timer <= 0) this.beginRound();
        break;
      default:
        break;
    }

    // Бот стреляет только в фазе боя, но тело докатывается всегда.
    this.bot.update(dt, this.player, this.phase === "fight" && this.playerAlive);
  }

  stop(): void {
    this.bot.setEnabled(false);
  }
}
