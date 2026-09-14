import { Matrix, Quaternion, TransformNode, Vector3 } from "@babylonjs/core";

/** Индексы точек рига. Порядок важен — по нему строятся связи. */
export const RB = {
  head: 0,
  neck: 1,
  chest: 2,
  hips: 3,
  shoulderL: 4,
  elbowL: 5,
  handL: 6,
  shoulderR: 7,
  elbowR: 8,
  handR: 9,
  hipL: 10,
  kneeL: 11,
  footL: 12,
  hipR: 13,
  kneeR: 14,
  footR: 15,
} as const;

export const RB_COUNT = 16;

interface Particle {
  pos: Vector3;
  prev: Vector3;
  radius: number;
}

interface Link {
  a: number;
  b: number;
  length: number;
  /** 1 — жёсткая кость, меньше — мягкая стяжка корпуса. */
  stiffness: number;
}

/** Связи скелета: кости плюс стяжки, удерживающие корпус от складывания. */
const LINKS: Array<[number, number, number]> = [
  // позвоночник и голова
  [RB.head, RB.neck, 1],
  [RB.neck, RB.chest, 1],
  [RB.chest, RB.hips, 1],
  // руки
  [RB.chest, RB.shoulderL, 1],
  [RB.shoulderL, RB.elbowL, 1],
  [RB.elbowL, RB.handL, 1],
  [RB.chest, RB.shoulderR, 1],
  [RB.shoulderR, RB.elbowR, 1],
  [RB.elbowR, RB.handR, 1],
  // ноги
  [RB.hips, RB.hipL, 1],
  [RB.hipL, RB.kneeL, 1],
  [RB.kneeL, RB.footL, 1],
  [RB.hips, RB.hipR, 1],
  [RB.hipR, RB.kneeR, 1],
  [RB.kneeR, RB.footR, 1],
  // каркас корпуса: без него грудь и таз складываются в точку
  [RB.shoulderL, RB.shoulderR, 0.9],
  [RB.hipL, RB.hipR, 0.9],
  [RB.shoulderL, RB.hips, 0.55],
  [RB.shoulderR, RB.hips, 0.55],
  [RB.chest, RB.hipL, 0.5],
  [RB.chest, RB.hipR, 0.5],
  // голова не должна ложиться на грудь
  [RB.head, RB.chest, 0.35],
  // локти и колени не выворачиваются полностью
  [RB.shoulderL, RB.handL, 0.12],
  [RB.shoulderR, RB.handR, 0.12],
  [RB.hipL, RB.footL, 0.12],
  [RB.hipR, RB.footR, 0.12],
];

const GRAVITY = -17;
/** Затухание скорости за секунду — тело не катается бесконечно. */
const DAMPING = 0.55;
const GROUND_FRICTION = 0.72;
const ITERATIONS = 7;

const DOWN = new Vector3(0, -1, 0);
/** Шея и голова растут вверх, поэтому для них ось другая. */
const UP = new Vector3(0, 1, 0);

/**
 * Верлет-рэгдолл поверх процедурного скелета.
 *
 * Точки рига связаны ограничениями по длине костей, положение интегрируется
 * методом Верле, после чего узлы скелета расставляются по точкам. Полноценный
 * физдвижок ради падающих тел тянуть не нужно — здесь хватает 16 частиц.
 */
export class Ragdoll {
  private readonly particles: Particle[] = [];
  private readonly links: Link[] = [];
  private readonly tmp = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly tmpMatrix = Matrix.Identity();

  /** Пока false, симуляция не идёт. */
  active = false;
  /** Уровень пола под телом. */
  groundY = 0;

  constructor() {
    for (let i = 0; i < RB_COUNT; i++) {
      this.particles.push({ pos: new Vector3(), prev: new Vector3(), radius: 0.11 });
    }
    // Голова и таз крупнее — они первыми ложатся на землю.
    this.particles[RB.head]!.radius = 0.13;
    this.particles[RB.hips]!.radius = 0.15;
    this.particles[RB.chest]!.radius = 0.16;
  }

  /**
   * Запускает симуляцию из текущей позы скелета.
   * `points` — мировые позиции суставов в порядке RB.
   */
  start(points: Vector3[], velocity: Vector3, impulse: Vector3, impulsePoint: Vector3): void {
    for (let i = 0; i < RB_COUNT; i++) {
      const p = this.particles[i]!;
      p.pos.copyFrom(points[i]!);
      // Инерция движения тела переносится в рэгдолл: бегущий боец падает вперёд.
      p.prev.copyFrom(points[i]!).subtractInPlace(velocity.scale(1 / 60));
    }

    // Длины костей берём из фактической позы — так тело не «дёргается» на старте.
    this.links.length = 0;
    for (const [a, b, stiffness] of LINKS) {
      this.links.push({ a, b, length: Vector3.Distance(points[a]!, points[b]!), stiffness });
    }

    this.addImpulse(impulse, impulsePoint);
    this.active = true;
  }

  /** Импульс от попадания: сильнее всего действует на ближайшие суставы. */
  addImpulse(impulse: Vector3, point: Vector3): void {
    for (const p of this.particles) {
      const dist = Vector3.Distance(p.pos, point);
      const falloff = 1 / (1 + dist * dist * 6);
      p.prev.subtractInPlace(this.tmp.copyFrom(impulse).scaleInPlace(falloff / 60));
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    const step = Math.min(dt, 1 / 45);
    this.integrate(step);
    for (let i = 0; i < ITERATIONS; i++) {
      this.solveLinks();
      this.solveGround();
    }
  }

  private integrate(dt: number): void {
    const damp = Math.exp(-DAMPING * dt);
    const gravity = GRAVITY * dt * dt;

    for (const p of this.particles) {
      const vx = (p.pos.x - p.prev.x) * damp;
      const vy = (p.pos.y - p.prev.y) * damp;
      const vz = (p.pos.z - p.prev.z) * damp;
      p.prev.copyFrom(p.pos);
      p.pos.x += vx;
      p.pos.y += vy + gravity;
      p.pos.z += vz;
    }
  }

  private solveLinks(): void {
    for (const link of this.links) {
      const a = this.particles[link.a]!;
      const b = this.particles[link.b]!;
      this.tmp.copyFrom(b.pos).subtractInPlace(a.pos);
      const dist = this.tmp.length();
      if (dist < 1e-5) continue;

      // Мягкие стяжки только не дают телу складываться, но не растягивают его.
      const diff = (dist - link.length) / dist;
      if (link.stiffness < 1 && dist < link.length) continue;

      this.tmp.scaleInPlace(diff * 0.5 * link.stiffness);
      a.pos.addInPlace(this.tmp);
      b.pos.subtractInPlace(this.tmp);
    }
  }

  private solveGround(): void {
    for (const p of this.particles) {
      const floor = this.groundY + p.radius;
      if (p.pos.y >= floor) continue;
      p.pos.y = floor;
      // Трение о землю: гасим горизонтальное скольжение.
      p.prev.x += (p.pos.x - p.prev.x) * GROUND_FRICTION;
      p.prev.z += (p.pos.z - p.prev.z) * GROUND_FRICTION;
      p.prev.y = p.pos.y;
    }
  }

  getPoint(index: number): Vector3 {
    return this.particles[index]!.pos;
  }

  /** Тело практически остановилось — можно перестать считать физику. */
  get isSettled(): boolean {
    let moved = 0;
    for (const p of this.particles) moved += Vector3.DistanceSquared(p.pos, p.prev);
    return moved < 1e-6;
  }

  // ------------------------------------------------------- перенос на скелет

  /**
   * Ставит узел в точку `from` и направляет его локальную ось −Y к точке `to`.
   * Кости скелета построены «вниз», поэтому выравнивание идёт именно по −Y.
   */
  alignBone(node: TransformNode, from: number, to: number, up = false): void {
    const a = this.particles[from]!.pos;
    const b = this.particles[to]!.pos;
    node.position.copyFrom(a);

    this.tmpA.copyFrom(b).subtractInPlace(a);
    if (this.tmpA.lengthSquared() < 1e-8) return;
    this.tmpA.normalize();

    if (!node.rotationQuaternion) node.rotationQuaternion = Quaternion.Identity();
    Quaternion.FromUnitVectorsToRef(up ? UP : DOWN, this.tmpA, node.rotationQuaternion);
  }

  /**
   * Для корпуса одного направления мало: нужен ещё разворот вокруг оси тела,
   * иначе грудь и таз крутятся произвольно. Второй осью служит линия плеч.
   */
  alignTorso(node: TransformNode, from: number, to: number, sideA: number, sideB: number): void {
    const a = this.particles[from]!.pos;
    const b = this.particles[to]!.pos;
    node.position.copyFrom(a);

    // Локальная +Y тела смотрит от таза к груди.
    this.tmpA.copyFrom(b).subtractInPlace(a);
    if (this.tmpA.lengthSquared() < 1e-8) return;
    this.tmpA.normalize();

    // Ось плеч, ортогонализованная относительно оси тела.
    this.tmpB.copyFrom(this.particles[sideB]!.pos).subtractInPlace(this.particles[sideA]!.pos);
    this.tmpB.subtractInPlace(this.tmpA.scale(Vector3.Dot(this.tmpB, this.tmpA)));
    if (this.tmpB.lengthSquared() < 1e-8) return;
    this.tmpB.normalize();

    const z = Vector3.Cross(this.tmpB, this.tmpA);
    Matrix.FromXYZAxesToRef(this.tmpB, this.tmpA, z, this.tmpMatrix);
    if (!node.rotationQuaternion) node.rotationQuaternion = Quaternion.Identity();
    Quaternion.FromRotationMatrixToRef(this.tmpMatrix, this.tmpQuat);
    node.rotationQuaternion.copyFrom(this.tmpQuat);
  }

  stop(): void {
    this.active = false;
  }
}
