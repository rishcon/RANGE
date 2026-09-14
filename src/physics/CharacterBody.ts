import { AbstractMesh, Mesh, MeshBuilder, Ray, Scene, Vector3 } from "@babylonjs/core";

/**
 * Кинематическая капсула игрока.
 *
 * Движение решается встроенной системой коллизий Babylon (`moveWithCollisions`
 * по эллипсоиду) — этого достаточно для полигона и не тянет Havok/Ammo.
 * Гравитация, определение земли и подъём на низкие препятствия — здесь.
 */
export class CharacterBody {
  readonly collider: Mesh;
  readonly velocity = new Vector3(0, 0, 0);

  grounded = false;
  /** Нормаль поверхности под ногами (для будущих уклонов). */
  readonly groundNormal = new Vector3(0, 1, 0);
  /** Вертикальная скорость в момент касания земли — для "приседания" камеры. */
  lastLandingSpeed = 0;

  private height: number;
  private readonly radius: number;
  private readonly stepHeight = 0.38;
  private wasGrounded = true;
  /** Вертикальное движение вниз было заблокировано столкновением в этом кадре. */
  private blockedDown = false;

  private readonly tmpBefore = new Vector3();
  private readonly tmpDesired = new Vector3();
  private readonly tmpHoriz = new Vector3();
  private readonly rayOrigin = new Vector3();
  private readonly downRay = new Ray(new Vector3(), new Vector3(0, -1, 0), 1);
  private readonly upRay = new Ray(new Vector3(), new Vector3(0, 1, 0), 1);

  constructor(
    private readonly scene: Scene,
    start: Vector3,
    radius: number,
    height: number
  ) {
    this.radius = radius;
    this.height = height;

    this.collider = MeshBuilder.CreateBox("player-collider", { width: radius * 2, height, depth: radius * 2 }, scene);
    this.collider.position.copyFrom(start);
    this.collider.isVisible = false;
    this.collider.isPickable = false;
    this.collider.checkCollisions = false;
    this.applyEllipsoid();
  }

  /** Позиция ступней (низ капсулы). */
  get position(): Vector3 {
    return this.collider.position;
  }

  get currentHeight(): number {
    return this.height;
  }

  setHeight(h: number): void {
    this.height = h;
    this.applyEllipsoid();
  }

  /** Хватает ли места над головой, чтобы встать до высоты `h`. */
  hasHeadroom(h: number): boolean {
    this.rayOrigin.copyFrom(this.position);
    this.rayOrigin.y += this.height - 0.05;
    this.upRay.origin = this.rayOrigin;
    this.upRay.direction.set(0, 1, 0);
    this.upRay.length = Math.max(0.01, h - this.height + 0.1);
    const hit = this.scene.pickWithRay(this.upRay, CharacterBody.solidPredicate);
    return !hit?.hit;
  }

  teleport(pos: Vector3): void {
    this.collider.position.copyFrom(pos);
    this.collider.computeWorldMatrix(true);
    this.velocity.setAll(0);
    this.grounded = true;
    this.wasGrounded = true;
  }

  /** Интегрирование скорости с разрешением коллизий. */
  integrate(dt: number): void {
    // moveWithCollisions отталкивается от АБСОЛЮТНОЙ позиции из мировой матрицы.
    // Если её не пересчитать, движок посчитает смещение от устаревшей точки —
    // особенно заметно при нескольких перемещениях подряд (шаг на препятствие).
    this.collider.computeWorldMatrix(true);
    this.tmpBefore.copyFrom(this.position);
    this.tmpDesired.copyFrom(this.velocity).scaleInPlace(dt);

    this.collider.moveWithCollisions(this.tmpDesired);

    const movedY = this.position.y - this.tmpBefore.y;
    const movedX = this.position.x - this.tmpBefore.x;
    const movedZ = this.position.z - this.tmpBefore.z;

    // Упёрлись в потолок или пол по вертикали — гасим вертикальную скорость.
    this.blockedDown = false;
    if (Math.abs(movedY) < Math.abs(this.tmpDesired.y) * 0.5) {
      if (this.tmpDesired.y > 0) {
        this.velocity.y = Math.min(this.velocity.y, 0);
      } else if (this.tmpDesired.y < 0) {
        this.velocity.y = Math.max(this.velocity.y, 0);
        this.blockedDown = true;
      }
    }

    // Подъём на низкие препятствия (ящики, мешки): пробуем шаг вверх-вперёд-вниз.
    const wantHoriz = Math.hypot(this.tmpDesired.x, this.tmpDesired.z);
    const gotHoriz = Math.hypot(movedX, movedZ);
    if (this.grounded && wantHoriz > 0.001 && gotHoriz < wantHoriz * 0.7) {
      this.tryStepUp(this.tmpDesired.x, this.tmpDesired.z, wantHoriz, gotHoriz);
    }

    this.updateGround();
  }

  private tryStepUp(dx: number, dz: number, wantHoriz: number, gotHoriz: number): void {
    const savedX = this.position.x;
    const savedY = this.position.y;
    const savedZ = this.position.z;

    // Вверх -> вперёд -> вниз, каждый шаг с актуальной мировой матрицей.
    this.tmpHoriz.set(0, this.stepHeight, 0);
    this.collider.computeWorldMatrix(true);
    this.collider.moveWithCollisions(this.tmpHoriz);

    this.tmpHoriz.set(dx, 0, dz);
    this.collider.computeWorldMatrix(true);
    this.collider.moveWithCollisions(this.tmpHoriz);

    this.tmpHoriz.set(0, -this.stepHeight - 0.02, 0);
    this.collider.computeWorldMatrix(true);
    this.collider.moveWithCollisions(this.tmpHoriz);

    const newHoriz = Math.hypot(this.position.x - savedX, this.position.z - savedZ);
    const climbed = this.position.y - savedY;
    const ok = newHoriz > gotHoriz + 0.001 && climbed <= this.stepHeight + 0.01 && newHoriz <= wantHoriz + 0.01;
    if (!ok) this.position.set(savedX, savedY, savedZ);
  }

  private updateGround(): void {
    this.rayOrigin.copyFrom(this.position);
    this.rayOrigin.y += 0.2;
    this.downRay.origin = this.rayOrigin;
    this.downRay.direction.set(0, -1, 0);
    this.downRay.length = 0.5;

    const hit = this.scene.pickWithRay(this.downRay, CharacterBody.solidPredicate);
    // Один центральный луч промахивается мимо края платформы, на которой игрок
    // ещё стоит (эллипсоид шире луча), поэтому учитываем и упор вниз по коллизии.
    const rayFloor = !!hit?.hit && hit.distance <= 0.28 && this.velocity.y <= 0.35;
    const onFloor = rayFloor || this.blockedDown;

    if (onFloor) {
      const n = hit?.getNormal(true, true);
      if (n) this.groundNormal.copyFrom(n);
      if (!this.wasGrounded) this.lastLandingSpeed = -this.velocity.y;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.lastLandingSpeed = 0;
    }

    this.wasGrounded = onFloor;
    this.grounded = onFloor;
  }

  dispose(): void {
    this.collider.dispose();
  }

  private applyEllipsoid(): void {
    const half = this.height / 2;
    this.collider.ellipsoid.set(this.radius, half, this.radius);
    this.collider.ellipsoidOffset.set(0, half, 0);
  }

  /** Столкновения только с геометрией уровня (у манекенов checkCollisions = false). */
  private static solidPredicate(mesh: AbstractMesh): boolean {
    return mesh.checkCollisions && mesh.isEnabled();
  }
}
