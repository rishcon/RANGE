import {
  type AnimationGroup,
  type AssetContainer,
  LoadAssetContainerAsync,
  Matrix,
  Mesh,
  type Node,
  PBRMaterial,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import armsUrl from "../../fps_arms_saiga_animations_remake.glb?url";
import { VIEWMODEL_LAYER, type WeaponModel } from "./models";
import { clamp01, damp } from "../core/MathUtil";

export function loadFpsArms(scene: Scene): Promise<AssetContainer> {
  return LoadAssetContainerAsync(armsUrl, scene, { pluginExtension: ".glb" });
}

/** Клипы из GLB. Имена внутри файла — `Rig|Saiga_<...>`. */
const CLIPS = {
  idle: "Rig|Saiga_Idle",
  walk: "Rig|Saiga_Walk",
  run: "Rig|Saiga_Run",
  fire: "Rig|Saiga_Fire",
  reloadFast: "Rig|Saiga_Reload_Fast",
  reloadFull: "Rig|Saiga_Reload_Full",
} as const;

export type ArmsClip = keyof typeof CLIPS;

/** Кость головы: по ней рига выравнивается относительно камеры. */
const HEAD_BONE = "Head_Cam_014";
/** Кость правой кисти: по ней ствол садится в руку. */
const HAND_R_BONE = "Hand_R_037";
/** Кость оружия из исходной модели — по ней берётся крен ствола. */
const WEAPON_BONE = "Saiga_058";


/**
 * Масштаб риги. Подобран так, чтобы расстояние между кистями совпало с хватом
 * наших стволов (рукоятка -> цевьё), собранных в масштабе VM_SCALE.
 */
const RIG_SCALE = 0.216;

/**
 * Куда ставится прицельная марка оружия на бедре — в системе координат
 * вьюмодели, то есть прямо в метрах от глаза.
 *
 * Одной поправкой для всей риги обойтись нельзя: автор ставил камеру вплотную
 * к кистям и под заметно более узкий угол обзора, чем наши 63° по вертикали (в
 * авторском кадре оружие занимает пол-экрана — проверено на самой «Сайге» из
 * файла), а наши стволы вдобавок разной длины. Поэтому ригу двигаем не на
 * фиксированную величину, а ровно настолько, чтобы марка каждого ствола легла
 * в одну и ту же точку кадра: см. `solveHipOffset`.
 *
 * Значение выбрано так, чтобы у M4 приклад — он уходит на 0.29 м назад от
 * рукоятки — остался за ближней плоскостью. Стоит отодвинуть ригу дальше, и он
 * вылезает перед камерой и занимает четверть кадра: именно это и выглядело как
 * «оружие не на месте».
 */
const HIP_SIGHT = new Vector3(0.015, 0, 0.285);

/**
 * Кость кисти стоит в запястье, а хват модели описан по ладони. Этот вектор
 * (в осях оружия) переносит одно в другое — иначе ствол уезжает назад в кулак.
 */
const WRIST_TO_PALM = new Vector3(0, 0, 0);

/**
 * Окно внутри клипа `Reload_Full`, в котором правая кисть уходит с рукоятки на
 * рукоятку взведения, дёргает её и возвращается — то есть ровно передёргивание
 * затвора. Отдельного клипа на это в файле нет, но в полной перезарядке ручное
 * взведение есть, и делает его именно правая рука. Границы сняты по смещению
 * кости `IK_Hand_Cntrl_R_036`: всплеск приходится на 2.75..4.22 с из 4.32 с.
 */
const BOLT_CLIP_FROM = 0.63;
const BOLT_CLIP_TO = 0.98;

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);

export interface ArmsContext {
  /** 0..1 — доля от максимальной скорости передвижения. */
  speedRatio: number;
  sprintT: number;
  adsT: number;
  /** 0..1, если идёт перезарядка. */
  reloadT: number;
  reloadEmpty: boolean;
  /** 0 — оружие убрано. */
  equipT: number;
  /**
   * Прогресс цикла затвора болтовой винтовки, 0..1; undefined — цикла нет.
   * Отдельного клипа передёргивания в файле нет, поэтому играется хвост полной
   * перезарядки — ручное взведение правой рукой, см. `updateBoltCycle`.
   */
  boltCycleT?: number;
}

/**
 * Настоящие руки от первого лица: скиннед-меш с ригом и шестью клипами из
 * `fps_arms_saiga_animations_remake.glb`. Рига одна на весь арсенал — её
 * перевешивают на вьюмодель того оружия, которое сейчас в руках.
 *
 * Ствол **не** подвешивается к кости: импорт Sketchfab зеркальный (определитель
 * мировой матрицы костей отрицательный), и под такой цепочкой модель оружия
 * отразилась бы — окно выброса гильз оказалось бы слева. Вместо этого каждый
 * кадр по двум кистям и кости оружия строится обычная правая система координат,
 * и ствол ставится в неё. Заодно это решает задачу посадки: точка хвата модели
 * совпадает с ладонью буквально, а не «на глаз».
 *
 * Слои анимации:
 * - **база** — idle/walk/run, перекрёстное смешивание по скорости;
 * - **действие** — fire/reload, клип поверх базы со своим весом;
 * - **затвор** — хвост клипа полной перезарядки, где правая рука взводит
 *   оружие; гонится прогрессом цикла затвора, см. `updateBoltCycle`.
 */
export class FpsArms {
  readonly root: TransformNode;
  /** Узел-держатель ствола: живёт рядом с ригой, в системе координат вьюмодели. */
  readonly mount: TransformNode;
  readonly meshes: Mesh[] = [];
  /** Спрятанная «Сайга» из исходной модели — эталон посадки ствола в кисти. */
  readonly reference: Mesh[] = [];

  private readonly groups = new Map<ArmsClip, AnimationGroup>();
  private readonly weights = new Map<ArmsClip, number>();
  /** Клипы, которые надо отыграть с начала, как только они получат вес. */
  private readonly restart = new Set<ArmsClip>();

  private readonly handR: TransformNode;
  private readonly weaponBone: TransformNode;
  /**
   * Какие оси кости оружия считать «вперёд» и «вверх». Импорт Sketchfab
   * зеркальный и с поворотом осей, поэтому их определяем по позе покоя, а не
   * закладываем вслепую.
   */
  private fwdAxis = 2;
  private fwdSign = 1;
  private upAxis = 1;
  private upSign = 1;

  private held: WeaponModel | null = null;

  /** Активное одноразовое действие и сколько ему ещё держаться. */
  private action: ArmsClip | null = null;
  private actionWeight = 0;
  private actionHold = 0;

  /** Вес клипа перезарядки, когда он играет цикл затвора, а не перезарядку. */
  private boltWeight = 0;

  private visible = true;

  private readonly invRoot = new Matrix();
  private readonly boneLocal = new Matrix();
  private readonly frameHand = new Matrix();
  /** Положение корня, при котором кость головы совпадает с камерой. */
  private readonly baseRoot = new Vector3();
  /** Поправка под конкретный ствол: считается при взятии оружия в руки. */
  private readonly offset = new Vector3();
  private readonly posR = new Vector3();
  private readonly boneUp = new Vector3();
  private readonly boneFwd = new Vector3();
  private readonly tmpVec = new Vector3();
  private readonly tmpQuat = new Quaternion();

  constructor(scene: Scene, asset: AssetContainer) {
    asset.addAllToScene();

    this.root = new TransformNode("vm-arms-root", scene);
    this.root.scaling.setAll(RIG_SCALE);
    for (const node of asset.rootNodes) {
      if (node instanceof TransformNode) node.parent = this.root;
    }

    // «Сайгу» из модели не выбрасываем, а прячем: она — эталон посадки. Автор
    // поставил кисти именно под неё, поэтому по её габаритам считается масштаб
    // и место наших стволов в руках.
    for (const mesh of asset.meshes) {
      if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
      if ((mesh.material?.name ?? "") !== "arms") {
        mesh.name = `vm-arms-ref-${mesh.name}`;
        mesh.isPickable = false;
        mesh.setEnabled(false);
        this.reference.push(mesh);
        continue;
      }
      mesh.name = "vm-arms";
      mesh.renderingGroupId = VIEWMODEL_LAYER;
      mesh.isPickable = false;
      mesh.checkCollisions = false;
      mesh.receiveShadows = false;
      mesh.applyFog = false;
      // Габарит скиннед-меша считается по бинд-позе: у самой камеры он иначе
      // вылетает из усечённой пирамиды и руки моргают.
      mesh.alwaysSelectAsActiveMesh = true;
      if (mesh.material instanceof PBRMaterial && mesh.material.albedoTexture) {
        mesh.material.emissiveTexture = mesh.material.albedoTexture;
        mesh.material.emissiveColor.set(0.17, 0.17, 0.17);
      }
      this.meshes.push(mesh);
    }

    for (const group of asset.animationGroups) {
      for (const [clip, name] of Object.entries(CLIPS) as Array<[ArmsClip, string]>) {
        if (group.name === name) this.groups.set(clip, group);
      }
    }

    const node = (name: string): TransformNode => {
      const found = scene.getTransformNodeByName(name);
      if (!found) throw new Error(`В модели рук нет кости ${name}`);
      return found;
    };
    this.handR = node(HAND_R_BONE);
    this.weaponBone = node(WEAPON_BONE);

    this.mount = new TransformNode("vm-arms-mount", scene);

    this.alignToCamera(scene);
    // Позу покоя снимаем до запуска клипов — кости ещё не анимированы.
    this.sampleRig();
    this.calibrateBone();
    this.sampleRig();

    // Крутится только то, что реально видно. Шесть клипов по ~170 каналов — это
    // больше тысячи анимируемых свойств на кадр, и смешивание весами их все
    // пересчитывает: с постоянно играющими клипами кадр проседал вчетверо.
    for (const [clip, group] of this.groups) {
      group.stop();
      this.weights.set(clip, 0);
      if (clip === "idle") {
        group.play(true);
        group.setWeightForAllAnimatables(1);
        this.weights.set(clip, 1);
      }
    }

    this.root.setEnabled(false);
  }

  /**
   * Рига авторская: камера стояла в кости головы. Сдвигаем корень так, чтобы
   * эта кость оказалась в начале координат вьюмодели — руки в кадре встают
   * ровно так, как их поставил автор модели.
   */
  private alignToCamera(scene: Scene): void {
    const head = scene.getTransformNodeByName(HEAD_BONE);
    if (!head) return;
    this.root.position.setAll(0);
    this.root.computeWorldMatrix(true);
    head.computeWorldMatrix(true);
    this.root.getWorldMatrix().invertToRef(this.invRoot);
    Vector3.TransformCoordinatesToRef(head.getAbsolutePosition(), this.invRoot, this.tmpVec);
    this.baseRoot.copyFrom(this.tmpVec).scaleInPlace(-RIG_SCALE);
    this.root.position.copyFrom(this.baseRoot);
  }

  /**
   * Снять положение кистей и крен оружия в системе координат вьюмодели.
   * Считаем через локальные координаты риги, а не через мир: мировые матрицы
   * костей отстают от нашего цикла на кадр, а локальные — нет.
   */
  private sampleRig(): void {
    this.root.computeWorldMatrix(true);
    this.root.getWorldMatrix().invertToRef(this.invRoot);

    // Матрицы костей пересчитываем принудительно: сразу после смены оружия ригу
    // только что включили, и в кэше лежит поза от прошлого владельца — по ней
    // ствол уехал бы в произвольную точку.
    this.handR.computeWorldMatrix(true);
    this.weaponBone.computeWorldMatrix(true);

    const toVm = (node: TransformNode, out: Vector3): void => {
      Vector3.TransformCoordinatesToRef(node.getAbsolutePosition(), this.invRoot, out);
      out.scaleInPlace(RIG_SCALE).addInPlace(this.root.position);
    };
    toVm(this.handR, this.posR);

    // Ориентацию ствола берём у кости оружия: линия между запястьями оси ствола
    // не задаёт — кисти держат его с разных сторон и на разной высоте.
    this.weaponBone.getWorldMatrix().multiplyToRef(this.invRoot, this.boneLocal);
    this.readAxis(this.fwdAxis, this.fwdSign, this.boneFwd);
    this.readAxis(this.upAxis, this.upSign, this.boneUp);
  }

  private readAxis(axis: number, sign: number, out: Vector3): void {
    const m = this.boneLocal.m;
    const i = axis * 4;
    out.set(m[i]!, m[i + 1]!, m[i + 2]!).normalize().scaleInPlace(sign);
  }

  /**
   * Какая ось кости оружия смотрит вперёд, а какая вверх. Берём ту, что в позе
   * покоя ближе всего к направлению взгляда и к вертикали соответственно.
   */
  private calibrateBone(): void {
    const m = this.boneLocal.m;
    const axes = [0, 1, 2].map(i => new Vector3(m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!).normalize());

    let bestF = -2;
    let bestU = -2;
    for (let i = 0; i < 3; i++) {
      for (const sign of [1, -1]) {
        const v = axes[i]!;
        if (v.z * sign > bestF) {
          bestF = v.z * sign;
          this.fwdAxis = i;
          this.fwdSign = sign;
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      if (i === this.fwdAxis) continue;
      for (const sign of [1, -1]) {
        const v = axes[i]!;
        if (v.y * sign > bestU) {
          bestU = v.y * sign;
          this.upAxis = i;
          this.upSign = sign;
        }
      }
    }
  }

  /** Перевесить ригу и держатель ствола на вьюмодель активного оружия. */
  attachTo(parent: Node | null): void {
    this.root.parent = parent;
    this.mount.parent = parent;
    this.root.setEnabled(parent !== null);
  }

  get attachedTo(): Node | null {
    return this.root.parent;
  }

  /** Какой ствол сейчас держат кисти. */
  hold(model: WeaponModel | null): void {
    this.held = model;
    if (model) this.solveHipOffset(model);
  }

  /**
   * Подвинуть ригу так, чтобы марка этого ствола легла в `HIP_SIGHT`.
   *
   * Сдвиг риги переносит и кисти, и ствол в них на ту же величину, поэтому
   * зависимость линейная и одного прохода достаточно: поставили ствол, измерили
   * промах марки, добавили его к поправке. Считаем один раз на взятие оружия —
   * если пересчитывать каждый кадр, поправка съедала бы дыхание и покачивание
   * рук, и руки замерли бы намертво.
   */
  private solveHipOffset(model: WeaponModel): void {
    // Считаем от нуля, а не от прошлой поправки: накапливать ошибку между
    // сменами оружия нельзя, иначе она уползает от ствола к стволу.
    this.root.position.copyFrom(this.baseRoot);
    this.placeWeapon(model);
    this.hipAnchor(model, this.tmpVec);
    this.offset.copyFrom(model.hipTarget ?? HIP_SIGHT).subtractInPlace(this.tmpVec);
    this.root.position.copyFrom(this.baseRoot).addInPlace(this.offset);
    this.placeWeapon(model);
  }

  /** Точка ствола, которую выводим в кадр: марка, а если её нет — сам ствол. */
  private hipAnchor(model: WeaponModel, out: Vector3): Vector3 {
    if (model.sight) return this.sightInRoot(model, out);
    return out.copyFrom(model.body.position);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    for (const mesh of this.meshes) mesh.isVisible = visible;
  }

  /** Запустить одноразовое действие: выстрел или перезарядку. */
  trigger(clip: ArmsClip, hold: number): void {
    if (!this.groups.has(clip)) return;
    // Каждый выстрел заново отыгрывает начало клипа: в автоматическом огне
    // виден именно рывок, а не хвост анимации.
    if (this.action !== clip || clip === "fire") {
      this.action = clip;
      this.restart.add(clip);
    }
    this.actionHold = Math.max(this.actionHold, hold);
  }

  /** Сбросить действие (смена оружия, отмена перезарядки). */
  clearAction(): void {
    this.action = null;
    this.actionHold = 0;
    this.actionWeight = 0;
  }

  update(dt: number, ctx: ArmsContext): void {
    const cycling = ctx.boltCycleT !== undefined;

    // Перезарядка — не импульс, а состояние: держим клип, пока она идёт. Пока
    // затвор передёргивается, клип полной перезарядки занят циклом затвора —
    // начать перезарядку в это время игрок всё равно не может.
    if (!cycling && ctx.reloadT > 0) this.trigger(ctx.reloadEmpty ? "reloadFull" : "reloadFast", 0.08);

    this.actionHold = Math.max(0, this.actionHold - dt);
    const wantAction = this.action !== null && this.actionHold > 0 ? 1 : 0;
    // Вход в действие резкий, выход — плавный, иначе руки дёргаются на отпускании.
    this.actionWeight = damp(this.actionWeight, wantAction, wantAction > 0 ? 40 : 9, dt);
    if (this.actionWeight < 0.01 && wantAction === 0) {
      this.actionWeight = 0;
      this.action = null;
    }

    // База: стоим -> идём -> бежим.
    const speed = clamp01(ctx.speedRatio);
    const sprint = clamp01(ctx.sprintT) * (1 - clamp01(ctx.adsT));
    const move = clamp01(speed * 1.35) * (1 - sprint);
    const base = 1 - this.actionWeight;

    this.setWeight("run", base * sprint, dt);
    this.setWeight("walk", base * move * (1 - sprint), dt);
    this.setWeight("idle", base * (1 - move) * (1 - sprint), dt);
    this.setWeight("fire", this.action === "fire" ? this.actionWeight : 0, dt);
    this.setWeight("reloadFast", this.action === "reloadFast" ? this.actionWeight : 0, dt);
    this.updateBoltCycle(dt, ctx.boltCycleT);

    // Темп шага следует за скоростью — иначе руки качаются не в такт ходьбе.
    const walk = this.groups.get("walk");
    if (walk) walk.speedRatio = 0.75 + speed * 0.6;

    if (this.held) this.placeWeapon(this.held);
  }

  /**
   * Передёргивание затвора болтовой винтовки. Клип `reloadFull` служит двум
   * целям: целиком это перезарядка с пустым магазином, а его хвост
   * (`BOLT_CLIP_FROM..BOLT_CLIP_TO`) — то самое ручное взведение правой рукой.
   * Для цикла затвора отыгрываем только этот хвост, и не своим временем клипа,
   * а прогрессом цикла: рука уходит на рукоятку взведения и возвращается ровно
   * к концу паузы между выстрелами, сколько бы она ни длилась.
   *
   * Два применения одного клипа не конфликтуют: пока затвор передёргивается,
   * перезарядку начать нельзя, а во время перезарядки нет цикла затвора.
   */
  private updateBoltCycle(dt: number, boltCycleT: number | undefined): void {
    const group = this.groups.get("reloadFull");
    if (!group) return;

    if (boltCycleT !== undefined) {
      const span = group.to - group.from;
      const t = BOLT_CLIP_FROM + clamp01(boltCycleT) * (BOLT_CLIP_TO - BOLT_CLIP_FROM);
      if (!group.isPlaying) group.play(true);
      group.goToFrame(group.from + t * span);
      this.boltWeight = damp(this.boltWeight, 1, 40, dt);
      this.weights.set("reloadFull", this.boltWeight);
      group.setWeightForAllAnimatables(this.boltWeight);
      return;
    }

    // Цикла затвора нет: клип возвращается обычному механизму действий. Оба
    // пишут в один регистр `weights`, поэтому переключение идёт без скачка.
    this.boltWeight = 0;
    this.setWeight("reloadFull", this.action === "reloadFull" ? this.actionWeight : 0, dt);
  }

  /**
   * Поставить ствол в кисти: разворот берётся у кости оружия, а точка хвата за
   * рукоятку (`hands.right`) совмещается с правой кистью. Кости кистей стоят в
   * запястьях, поэтому между ними и ладонью есть постоянная поправка.
   */
  private placeWeapon(model: WeaponModel): void {
    const right = model.hands.right;
    if (!right) return;

    this.sampleRig();
    frameFrom(this.boneFwd, this.boneUp, this.frameHand);

    const body = model.body;
    Quaternion.FromRotationMatrixToRef(this.frameHand, this.tmpQuat);
    if (!body.rotationQuaternion) body.rotationQuaternion = new Quaternion();
    body.rotationQuaternion.copyFrom(this.tmpQuat);

    right.pos.scaleToRef(body.scaling.x, this.tmpVec);
    this.tmpVec.subtractInPlace(WRIST_TO_PALM);
    Vector3.TransformCoordinatesToRef(this.tmpVec, this.frameHand, this.tmpVec);
    body.position.copyFrom(this.posR).subtractInPlace(this.tmpVec);
  }

  /**
   * Где сейчас прицельная марка в системе координат вьюмодели. Считается по
   * той же позе, что и посадка ствола, поэтому отставания на кадр нет.
   */
  sightInRoot(model: WeaponModel, out: Vector3): Vector3 {
    const body = model.body;
    if (!model.sight) return out.copyFrom(body.position);
    model.sight.scaleToRef(body.scaling.x, out);
    if (body.rotationQuaternion) out.applyRotationQuaternionInPlace(body.rotationQuaternion);
    return out.addInPlace(body.position);
  }

  /**
   * Вес клипа и его жизненный цикл: при нулевом весе клип останавливается
   * совсем, иначе Babylon каждый кадр пересчитывает все его каналы впустую.
   */
  private setWeight(clip: ArmsClip, target: number, dt: number): void {
    const group = this.groups.get(clip);
    if (!group) return;

    let next = damp(this.weights.get(clip) ?? 0, target, 16, dt);
    if (target <= 0 && next < 0.004) next = 0;
    this.weights.set(clip, next);

    if (next === 0) {
      if (group.isPlaying) group.stop();
      this.restart.delete(clip);
      return;
    }
    if (!group.isPlaying) {
      group.play(true);
      this.restart.delete(clip);
    } else if (this.restart.delete(clip)) {
      group.goToFrame(group.from);
    }
    group.setWeightForAllAnimatables(next);
  }
}

/**
 * Ортонормированный базис по направлению «вперёд» и приблизительной вертикали:
 * +Z — вдоль оси, +Y — вертикаль, ортогонализованная к ней, +X — вправо.
 * Определитель положительный, поэтому матрица всегда представима кватернионом.
 */
function frameFrom(forward: Vector3, up: Vector3, out: Matrix): void {
  const z = forward.clone();
  if (z.lengthSquared() < 1e-9) z.copyFrom(FORWARD);
  z.normalize();

  const y = up.clone();
  y.subtractInPlace(z.scale(Vector3.Dot(y, z)));
  if (y.lengthSquared() < 1e-8) y.copyFrom(Math.abs(z.y) > 0.9 ? FORWARD : UP);
  y.normalize();

  const x = Vector3.Cross(y, z).normalize();
  Vector3.CrossToRef(z, x, y);
  Matrix.FromXYZAxesToRef(x, y, z, out);
}
