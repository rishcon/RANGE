import { clamp01 } from "../core/MathUtil";
import type { AudioManager } from "../fx/AudioManager";
import type { Action, InputManager } from "../input/InputManager";
import type { IWeapon } from "./Types";

const HOLSTER_TIME = 0.18;
const DRAW_TIME = 0.32;

const SLOT_ACTIONS: Action[] = ["slot1", "slot2", "slot3", "slot4", "slot5", "slot6", "slot7"];

type Phase = "idle" | "holster" | "draw";

/**
 * Слоты оружия и переключение между ними.
 *
 * Во время смены оружие не стреляет: сначала текущее убирается вниз
 * (`holster`), затем новое достаётся (`draw`) — как в тактических шутерах.
 */
export class Inventory {
  private index = 0;
  private previousIndex = 0;
  /** Какое именно оружие было выбрано в слоте: слот 1 хранит автомат или снайперку. */
  private readonly slotMemory = new Map<number, number>();
  private pendingIndex: number | null = null;
  private phase: Phase = "idle";
  private phaseTimer = 0;
  private equipT = 1;

  constructor(
    private readonly weapons: IWeapon[],
    private readonly audio: AudioManager
  ) {
    for (let i = 0; i < weapons.length; i++) {
      weapons[i]!.viewModel.setActive(i === this.index);
    }
    this.weapons[this.index]!.onEquip();
  }

  get current(): IWeapon {
    return this.weapons[this.index]!;
  }

  get all(): readonly IWeapon[] {
    return this.weapons;
  }

  get currentIndex(): number {
    return this.index;
  }

  /** 0 — оружие убрано, 1 — готово к действию. */
  get equipProgress(): number {
    return this.equipT;
  }

  /** Можно ли стрелять/бить именно сейчас. */
  get canAct(): boolean {
    return this.phase === "idle" && this.equipT >= 0.999;
  }

  get isSwitching(): boolean {
    return this.phase !== "idle";
  }

  // ------------------------------------------------------------ переключение

  /**
   * В слоте может быть несколько стволов (автомат и снайперка делят «1»).
   * Повторное нажатие той же клавиши переключает вариант внутри слота.
   */
  requestSlot(slot: number): void {
    const group: number[] = [];
    for (let i = 0; i < this.weapons.length; i++) {
      if (this.weapons[i]!.slot === slot && this.weapons[i]!.available) group.push(i);
    }
    if (group.length === 0) return;

    const posInGroup = group.indexOf(this.index);
    if (posInGroup >= 0) {
      if (group.length > 1) this.requestIndex(group[(posInGroup + 1) % group.length]!);
      return;
    }

    const remembered = this.slotMemory.get(slot);
    this.requestIndex(remembered !== undefined && group.includes(remembered) ? remembered : group[0]!);
  }

  /** Активное оружие слота — для подписи в HUD. */
  activeInSlot(slot: number): IWeapon {
    if (this.current.slot === slot) return this.current;
    const remembered = this.slotMemory.get(slot);
    if (remembered !== undefined && this.weapons[remembered]?.slot === slot) return this.weapons[remembered]!;
    return this.weapons.find((w) => w.slot === slot) ?? this.current;
  }

  requestIndex(idx: number): void {
    if (idx < 0 || idx >= this.weapons.length) return;
    if (idx === this.index && this.phase === "idle") return;
    if (!this.weapons[idx]!.available) return;
    // Замах ножом или бросок гранаты прерывать нельзя.
    if (this.current.busy && this.phase === "idle" && !this.current.isReloading) return;

    this.pendingIndex = idx;
    if (this.phase === "idle") {
      this.phase = "holster";
      this.phaseTimer = HOLSTER_TIME;
      this.current.onHolster();
      this.audio.weaponSwitch();
    }
  }

  /** Предыдущее оружие (как Q в CS). */
  swapToPrevious(): void {
    this.requestIndex(this.previousIndex);
  }

  cycle(direction: number): void {
    const count = this.weapons.length;
    for (let step = 1; step <= count; step++) {
      const idx = (((this.index + direction * step) % count) + count) % count;
      if (this.weapons[idx]!.available) {
        this.requestIndex(idx);
        return;
      }
    }
  }

  // -------------------------------------------------------------------- кадр

  update(dt: number, input: InputManager): void {
    this.handleInput(input);

    switch (this.phase) {
      case "holster":
        this.phaseTimer -= dt;
        this.equipT = clamp01(this.phaseTimer / HOLSTER_TIME);
        if (this.phaseTimer <= 0) this.finishHolster();
        break;
      case "draw":
        this.phaseTimer -= dt;
        this.equipT = 1 - clamp01(this.phaseTimer / DRAW_TIME);
        if (this.phaseTimer <= 0) {
          this.phase = "idle";
          this.equipT = 1;
        }
        break;
      default:
        this.equipT = 1;
    }

    // Гранаты кончились — автоматически возвращаемся к предыдущему оружию.
    if (this.phase === "idle" && !this.current.available) {
      const fallback = this.weapons[this.previousIndex]!.available ? this.previousIndex : 0;
      this.requestIndex(fallback);
    }
  }

  private handleInput(input: InputManager): void {
    for (let i = 0; i < SLOT_ACTIONS.length; i++) {
      if (input.wasPressed(SLOT_ACTIONS[i]!)) this.requestSlot(i + 1);
    }
    if (input.wasPressed("lastWeapon")) this.swapToPrevious();

    const wheel = input.consumeWheel();
    if (wheel !== 0) this.cycle(wheel > 0 ? 1 : -1);
  }

  private finishHolster(): void {
    const next = this.pendingIndex ?? this.index;
    this.pendingIndex = null;

    this.current.viewModel.setActive(false);
    this.previousIndex = this.index;
    this.index = next;

    this.current.viewModel.setActive(true);
    this.current.onEquip();
    this.slotMemory.set(this.current.slot, this.index);
    this.audio.weaponDraw();

    this.phase = "draw";
    this.phaseTimer = DRAW_TIME;
    this.equipT = 0;
  }

  /** Мгновенно вернуться к первому слоту и снять все переходы. */
  resetToPrimary(): void {
    for (const w of this.weapons) {
      w.onHolster();
      w.viewModel.setActive(false);
    }
    this.index = 0;
    this.previousIndex = 0;
    this.pendingIndex = null;
    this.slotMemory.clear();
    this.phase = "idle";
    this.phaseTimer = 0;
    this.equipT = 1;
    this.current.viewModel.setActive(true);
    this.current.onEquip();
  }
}
