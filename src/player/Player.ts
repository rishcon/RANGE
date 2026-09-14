import { FreeCamera, Ray, Scene, Vector3 } from "@babylonjs/core";
import { CAMERA, PLAYER, WORLD } from "../core/Config";
import { clamp, clamp01, damp, lerp, spring } from "../core/MathUtil";
import type { InputManager } from "../input/InputManager";
import { CharacterBody } from "../physics/CharacterBody";
import { settings } from "../core/Settings";
import type { ViewPunch } from "../weapons/Recoil";

export type Stance = "stand" | "crouch";

export interface PlayerEvents {
  onFootstep?: (running: boolean, crouching: boolean) => void;
  onJump?: () => void;
  onLand?: (impactSpeed: number) => void;
}

/** Внешние поправки прицела (отдача оружия) — складываются с углами игрока. */
export interface AimOffset {
  pitch: number;
  yaw: number;
}

export interface PlayerUpdateContext {
  /** 0..1 — степень прицеливания, влияет на скорость, чувствительность и тряску. */
  adsT: number;
  /** Смещение прицела от отдачи — влияет и на камеру, и на полёт пули. */
  recoil: AimOffset;
  /** Тряска камеры — только визуальная, на точку попадания не влияет. */
  viewPunch: ViewPunch;
  /** Оружие может запретить бег (например, во время выстрела). */
  allowSprint: boolean;
}

/**
 * Игрок: углы обзора, перемещение, стойки, наклоны и вся анимация камеры.
 * Физику перемещения делегирует CharacterBody, стрельбу — оружию.
 */
export class Player {
  readonly camera: FreeCamera;
  readonly body: CharacterBody;

  yaw = WORLD.spawnYaw;
  pitch = 0;

  stance: Stance = "stand";
  sprinting = false;

  /** Последняя дельта мыши за кадр — нужна вьюмодели для инерции ствола. */
  readonly mouseDelta = { x: 0, y: 0 };

  private viewHeight = PLAYER.standHeight - PLAYER.eyeDrop;
  private colliderHeight = PLAYER.standHeight;

  private leanT = 0;
  private leanTarget = 0;

  private bobPhase = 0;
  private stepAccum = 0;
  private breathPhase = Math.random() * 10;

  private dipValue = 0;
  private dipVelocity = 0;

  private strafeTilt = 0;
  private coyote = 0;
  private jumpBuffer = 0;

  private horizSpeed = 0;

  /**
   * «Боевые» углы: база игрока плюс смещение от отдачи, без тряски, покачивания
   * и дыхания. Пуля летит именно по ним — визуальные эффекты не должны
   * влиять на попадание.
   */
  private aimYaw = 0;
  private aimPitch = 0;

  private readonly wishDir = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly horiz = new Vector3();
  private readonly camOffset = new Vector3();
  private readonly tmpForward = new Vector3();
  private readonly tmpRight = new Vector3();
  private readonly leanRay = new Ray(new Vector3(), new Vector3(), 1);

  constructor(
    private readonly scene: Scene,
    private readonly events: PlayerEvents = {}
  ) {
    this.body = new CharacterBody(
      scene,
      new Vector3(WORLD.spawn.x, WORLD.spawn.y, WORLD.spawn.z),
      PLAYER.radius,
      PLAYER.standHeight
    );

    this.camera = new FreeCamera("player-camera", new Vector3(0, this.viewHeight, 0), scene);
    this.camera.minZ = CAMERA.near;
    this.camera.maxZ = CAMERA.far;
    this.camera.rotation.set(0, this.yaw, 0);
    this.camera.inertia = 0;
    this.camera.speed = 0;
    // Управление камерой полностью ручное — встроенные контроллеры не нужны.
    this.camera.inputs.clear();
  }

  // ------------------------------------------------------------------ доступ

  get position(): Vector3 {
    return this.body.position;
  }

  get grounded(): boolean {
    return this.body.grounded;
  }

  get eyeHeight(): number {
    return this.viewHeight;
  }

  /** 0..1 — текущая горизонтальная скорость относительно бега. */
  get speedRatio(): number {
    return clamp01(this.horizSpeed / PLAYER.sprintSpeed);
  }

  get isMoving(): boolean {
    return this.horizSpeed > 0.35;
  }

  get crouching(): boolean {
    return this.stance === "crouch";
  }

  get leanAmount(): number {
    return this.leanT;
  }

  /** Направление выстрела (без тряски камеры и покачивания). */
  getAimForward(out: Vector3): Vector3 {
    const cp = Math.cos(this.aimPitch);
    return out.set(Math.sin(this.aimYaw) * cp, -Math.sin(this.aimPitch), Math.cos(this.aimYaw) * cp).normalize();
  }

  /** Правый вектор прицела — база для конуса разброса. */
  getAimRight(out: Vector3): Vector3 {
    return out.set(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw));
  }

  /** Верхний вектор прицела (ортогонален forward и right). */
  getAimUp(out: Vector3): Vector3 {
    this.getAimForward(this.tmpForward);
    this.getAimRight(this.tmpRight);
    return Vector3.CrossToRef(this.tmpForward, this.tmpRight, out).normalize();
  }

  respawn(): void {
    this.body.teleport(new Vector3(WORLD.spawn.x, WORLD.spawn.y, WORLD.spawn.z));
    this.yaw = WORLD.spawnYaw;
    this.pitch = 0;
    this.leanT = 0;
    this.stance = "stand";
    this.colliderHeight = PLAYER.standHeight;
    this.body.setHeight(PLAYER.standHeight);
  }

  // ------------------------------------------------------------------- кадр

  update(dt: number, input: InputManager, ctx: PlayerUpdateContext): void {
    this.applyLook(dt, input, ctx);
    this.updateStance(dt, input, ctx);
    this.updateMovement(dt, input, ctx);
    this.updateLean(dt, input);
    this.updateCamera(dt, ctx);
  }

  // ------------------------------------------------------------------ взгляд

  private applyLook(dt: number, input: InputManager, ctx: PlayerUpdateContext): void {
    const d = input.consumeMouseDelta();
    this.mouseDelta.x = d.x;
    this.mouseDelta.y = d.y;

    const s = settings.current;
    // При прицеливании чувствительность падает — иначе микродоводка невозможна.
    const sens = s.sensitivity * 0.0022 * lerp(1, s.adsSensMul, ctx.adsT);

    this.yaw += d.x * sens;
    this.pitch += d.y * sens * (s.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -PLAYER.pitchLimit, PLAYER.pitchLimit);

    // Держим yaw в пределах ±2π, чтобы не терять точность на длинной сессии.
    if (this.yaw > Math.PI * 2) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI * 2) this.yaw += Math.PI * 2;

    void dt;
  }

  // ------------------------------------------------------------------ стойка

  private updateStance(dt: number, input: InputManager, ctx: PlayerUpdateContext): void {
    const wantCrouch = input.isDown("crouch");
    if (wantCrouch) {
      this.stance = "crouch";
    } else if (this.stance === "crouch" && this.body.hasHeadroom(PLAYER.standHeight)) {
      this.stance = "stand";
    }

    const targetHeight = this.stance === "crouch" ? PLAYER.crouchHeight : PLAYER.standHeight;
    this.colliderHeight = damp(this.colliderHeight, targetHeight, PLAYER.stanceLerp, dt);
    if (Math.abs(this.colliderHeight - targetHeight) < 0.002) this.colliderHeight = targetHeight;
    this.body.setHeight(this.colliderHeight);

    const axis = input.moveAxis();
    this.sprinting =
      ctx.allowSprint &&
      input.isDown("sprint") &&
      axis.y > 0.1 &&
      this.stance === "stand" &&
      ctx.adsT < 0.25 &&
      this.horizSpeed > 0.6;
  }

  // --------------------------------------------------------------- движение

  private updateMovement(dt: number, input: InputManager, ctx: PlayerUpdateContext): void {
    const axis = input.moveAxis();
    const vel = this.body.velocity;

    // Горизонтальные базисные векторы из одного только yaw — наклон камеры
    // и отдача не должны влиять на направление ходьбы.
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    this.forward.set(sy, 0, cy);
    this.right.set(cy, 0, -sy);

    this.wishDir.set(
      this.forward.x * axis.y + this.right.x * axis.x,
      0,
      this.forward.z * axis.y + this.right.z * axis.x
    );
    const wishLen = this.wishDir.length();
    if (wishLen > 0.0001) this.wishDir.scaleInPlace(1 / wishLen);

    // Целевая скорость: стойка -> бег -> прицеливание -> направление.
    let targetSpeed = this.stance === "crouch" ? PLAYER.crouchSpeed : PLAYER.walkSpeed;
    if (this.sprinting) targetSpeed = PLAYER.sprintSpeed;
    targetSpeed *= lerp(1, PLAYER.adsSpeedMul, ctx.adsT);
    if (axis.y < -0.1) targetSpeed *= PLAYER.backwardMul;
    else if (Math.abs(axis.x) > 0.6 && Math.abs(axis.y) < 0.4) targetSpeed *= PLAYER.strafeMul;
    targetSpeed *= wishLen > 0 ? Math.min(1, wishLen) : 0;

    this.horiz.set(vel.x, 0, vel.z);

    if (this.body.grounded) {
      // Трение — только когда нет ввода или скорость выше целевой.
      const speed = this.horiz.length();
      if (speed > 0.0001) {
        const control = Math.max(speed, 1.2);
        const drop = control * PLAYER.frictionGround * dt;
        const scale = Math.max(0, speed - drop) / speed;
        this.horiz.scaleInPlace(scale);
      }
      this.accelerate(targetSpeed, PLAYER.accelGround, dt);
    } else {
      this.accelerate(targetSpeed, PLAYER.accelAir, dt);
      this.horiz.scaleInPlace(Math.max(0, 1 - PLAYER.frictionAir * dt));
    }

    vel.x = this.horiz.x;
    vel.z = this.horiz.z;
    this.horizSpeed = Math.hypot(vel.x, vel.z);

    // Прыжок с "койот-таймом" и буфером нажатия.
    this.coyote = this.body.grounded ? PLAYER.coyoteTime : Math.max(0, this.coyote - dt);
    this.jumpBuffer = input.wasPressed("jump") ? PLAYER.jumpBuffer : Math.max(0, this.jumpBuffer - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      vel.y = PLAYER.jumpVelocity * (this.stance === "crouch" ? 0.78 : 1);
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.events.onJump?.();
    }

    vel.y -= PLAYER.gravity * dt;
    vel.y = Math.max(vel.y, -60);

    const wasGrounded = this.body.grounded;
    this.body.integrate(dt);

    if (!wasGrounded && this.body.grounded && this.body.lastLandingSpeed > 2.5) {
      const impact = this.body.lastLandingSpeed;
      this.dipVelocity -= Math.min(impact * 0.09, CAMERA.landDipMax * 5);
      this.events.onLand?.(impact);
    }

    this.updateFootsteps(dt);
  }

  private accelerate(targetSpeed: number, accel: number, dt: number): void {
    if (targetSpeed <= 0) return;
    const current = this.horiz.x * this.wishDir.x + this.horiz.z * this.wishDir.z;
    const add = targetSpeed - current;
    if (add <= 0) return;
    const amount = Math.min(accel * dt, add);
    this.horiz.x += this.wishDir.x * amount;
    this.horiz.z += this.wishDir.z * amount;
  }

  private updateFootsteps(dt: number): void {
    if (!this.body.grounded || this.horizSpeed < 0.6) {
      // Небольшой "долг" оставляем, чтобы первый шаг после остановки был не сразу.
      this.stepAccum = Math.min(this.stepAccum, PLAYER.stepDistance * 0.6);
      return;
    }
    this.stepAccum += this.horizSpeed * dt;
    const interval = this.sprinting ? PLAYER.sprintStepDistance : PLAYER.stepDistance;
    const scaled = this.crouching ? interval * 1.35 : interval;
    if (this.stepAccum >= scaled) {
      this.stepAccum -= scaled;
      this.events.onFootstep?.(this.sprinting, this.crouching);
    }
  }

  // ------------------------------------------------------------------ наклон

  private updateLean(dt: number, input: InputManager): void {
    this.leanTarget = input.leanAxis();

    // Не даём "просунуть" голову сквозь стену: упираемся лучом вбок.
    if (this.leanTarget !== 0) {
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      this.leanRay.origin.copyFrom(this.body.position);
      this.leanRay.origin.y += this.viewHeight;
      this.leanRay.direction.set(cy * this.leanTarget, 0, -sy * this.leanTarget);
      this.leanRay.length = PLAYER.leanOffset + PLAYER.radius;
      const hit = this.scene.pickWithRay(this.leanRay, (m) => m.checkCollisions && m.isEnabled());
      if (hit?.hit) {
        const room = Math.max(0, hit.distance - PLAYER.radius * 0.8);
        this.leanTarget *= clamp01(room / PLAYER.leanOffset);
      }
    }

    // В прыжке и на бегу наклон подавляем — так делают почти все тактические шутеры.
    if (!this.body.grounded || this.sprinting) this.leanTarget *= 0.25;

    this.leanT = damp(this.leanT, this.leanTarget, PLAYER.leanSpeed, dt);
    if (Math.abs(this.leanT) < 0.001) this.leanT = 0;
  }

  // ------------------------------------------------------------------ камера

  private updateCamera(dt: number, ctx: PlayerUpdateContext): void {
    this.viewHeight = this.colliderHeight - PLAYER.eyeDrop;

    const bobEnabled = settings.current.viewBob;
    const moveRatio = clamp01(this.horizSpeed / PLAYER.walkSpeed);
    const bobScale = bobEnabled ? moveRatio * (this.body.grounded ? 1 : 0.15) * lerp(1, 0.25, ctx.adsT) : 0;

    // Фаза качания привязана к пройденному пути, а не ко времени —
    // тогда шаг и качание всегда совпадают.
    this.bobPhase += this.horizSpeed * dt * 3.1;
    this.breathPhase += dt * 1.35;

    const bobY = -Math.abs(Math.sin(this.bobPhase)) * CAMERA.bobAmount * bobScale;
    const bobX = Math.sin(this.bobPhase * 0.5) * CAMERA.bobAmount * 0.8 * bobScale;
    const bobRoll = Math.sin(this.bobPhase * 0.5) * CAMERA.bobRoll * bobScale;
    const bobPitch = Math.sin(this.bobPhase * 2) * CAMERA.bobRoll * 0.35 * bobScale;

    // Дыхание: заметно только когда стоим и особенно при прицеливании.
    const idle = (1 - moveRatio) * lerp(1, 1.8, ctx.adsT);
    const breathY = Math.sin(this.breathPhase) * CAMERA.breathAmount * idle;
    const breathPitch = Math.sin(this.breathPhase * 0.77) * 0.0012 * idle;
    const breathYaw = Math.sin(this.breathPhase * 0.53 + 1.1) * 0.0016 * idle;

    // Просадка после приземления — критически задемпфированная пружина.
    const [dv, dvel] = spring(this.dipValue, this.dipVelocity, 0, 170, 22, dt);
    this.dipValue = clamp(dv, -CAMERA.landDipMax, CAMERA.landDipMax);
    this.dipVelocity = dvel;

    // Лёгкий крен при стрейфе.
    const strafeInput = this.horiz.x * Math.cos(this.yaw) - this.horiz.z * Math.sin(this.yaw);
    const strafeNorm = clamp(strafeInput / PLAYER.walkSpeed, -1, 1);
    this.strafeTilt = damp(this.strafeTilt, -strafeNorm * CAMERA.strafeTilt, 7, dt);

    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const leanShift = this.leanT * PLAYER.leanOffset;

    this.camOffset.set(
      this.body.position.x + cy * leanShift + bobX * cy,
      this.body.position.y + this.viewHeight + bobY + breathY + this.dipValue - Math.abs(this.leanT) * 0.06,
      this.body.position.z - sy * leanShift - bobX * sy
    );
    this.camera.position.copyFrom(this.camOffset);

    // Боевые углы фиксируем до наложения визуальных эффектов.
    this.aimPitch = clamp(this.pitch + ctx.recoil.pitch, -PLAYER.pitchLimit, PLAYER.pitchLimit);
    this.aimYaw = this.yaw + ctx.recoil.yaw;

    // Крен отрицательный: наклон вправо визуально поворачивает мир против
    // часовой стрелки, как при наклоне головы.
    this.camera.rotation.set(
      this.aimPitch + ctx.viewPunch.pitch + bobPitch + breathPitch,
      this.aimYaw + ctx.viewPunch.yaw + breathYaw,
      -this.leanT * PLAYER.maxLean + this.strafeTilt + bobRoll + ctx.viewPunch.roll
    );
  }

  dispose(): void {
    this.body.dispose();
    this.camera.dispose();
  }
}
