import { Vector3, type Scene } from "@babylonjs/core";
import { PLAYER } from "../core/Config";
import { clamp01 } from "../core/MathUtil";
import type { Player } from "../player/Player";
import { Character, SOLDIER_PALETTE, type CharacterState } from "./Character";
import { RB } from "./Ragdoll";

/**
 * Тело игрока, видимое от первого лица: торс, таз и ноги.
 *
 * Голова, шея и руки скрыты — голова перекрывала бы камеру, а руки дублировали
 * бы вьюмодель оружия. Тело не участвует в рейкастах, иначе игрок попадал бы
 * сам в себя.
 */
export class PlayerBody {
  private readonly character: Character;
  private readonly state: CharacterState = {
    speed: 0,
    crouch: 0,
    grounded: true,
    verticalVelocity: 0,
    lookPitch: 0,
    lean: 0,
    death: 0,
  };

  constructor(
    scene: Scene,
    private readonly player: Player
  ) {
    this.character = new Character(scene, SOLDIER_PALETTE, { holdWeapon: false, namePrefix: "player" });
    this.character.setFirstPerson(true);

    for (const mesh of this.character.meshes) {
      mesh.isPickable = false;
      // Собственное тело не должно отбрасывать тень себе в камеру.
      mesh.receiveShadows = true;
    }
  }

  get root(): Character["root"] {
    return this.character.root;
  }

  get meshes(): Character["meshes"] {
    return this.character.meshes;
  }

  get isDead(): boolean {
    return this.character.isRagdollActive;
  }

  /**
   * Игрок убит: тело показывается целиком (голова и руки больше не мешают,
   * камера отвязана) и переходит в рэгдолл.
   */
  die(velocity: Vector3, impulse: Vector3, point: Vector3): void {
    if (this.character.isRagdollActive) return;
    this.character.setFirstPerson(false);
    this.character.groundY = this.player.body.position.y;
    this.character.startRagdoll(velocity, impulse, point);
  }

  /** Точка, за которой держится камера смерти. */
  getViewTarget(out: Vector3): Vector3 {
    if (this.character.isRagdollActive) return this.character.getRagdollPoint(RB.chest, out);
    return out.copyFrom(this.player.body.position).addInPlaceFromFloats(0, 1, 0);
  }

  update(dt: number): void {
    const player = this.player;
    const body = player.body;

    // В рэгдолле позой управляет физика — позицию корня трогать нельзя.
    if (this.character.isRagdollActive) {
      this.character.update(dt, this.state);
      return;
    }

    const crouchRange = PLAYER.standHeight - PLAYER.crouchHeight;
    const drop = PLAYER.standHeight - body.currentHeight;
    this.state.crouch = crouchRange > 0 ? clamp01(drop / crouchRange) : 0;
    // Таз опускается ровно на столько же, на сколько просела камера.
    this.state.crouchDrop = drop;
    this.state.speed = player.speedRatio;
    this.state.grounded = player.grounded;
    this.state.verticalVelocity = body.velocity.y;
    this.state.lookPitch = player.pitch;
    this.state.lean = player.leanAmount;

    // Камера сидит в голове, а голова у человека вынесена вперёд относительно
    // центра масс — иначе взгляд вниз упирается ровно в собственную грудь.
    const back = 0.1;
    this.character.groundY = body.position.y;
    this.character.root.position.set(
      body.position.x - Math.sin(player.yaw) * back,
      body.position.y,
      body.position.z - Math.cos(player.yaw) * back
    );
    this.character.root.rotation.y = player.yaw;
    this.character.update(dt, this.state);
  }

  reset(): void {
    this.character.reset();
    this.character.setFirstPerson(true);
  }

  dispose(): void {
    this.character.dispose();
  }
}
