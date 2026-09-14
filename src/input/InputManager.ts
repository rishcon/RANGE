export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "jump"
  | "crouch"
  | "sprint"
  | "leanLeft"
  | "leanRight"
  | "reload"
  | "resetRange"
  | "fullscreen"
  | "slot1"
  | "slot2"
  | "slot3"
  | "slot4"
  | "slot5"
  | "slot6"
  | "slot7"
  | "lastWeapon";

/** Раскладка: действие -> коды клавиш (KeyboardEvent.code). */
const BINDINGS: Record<Action, string[]> = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["Space"],
  crouch: ["ControlLeft", "ControlRight", "KeyC"],
  sprint: ["ShiftLeft", "ShiftRight"],
  leanLeft: ["KeyQ"],
  leanRight: ["KeyE"],
  reload: ["KeyR"],
  resetRange: ["KeyF"],
  fullscreen: ["F11"],
  // Слоты: основное, снайперская, пистолет, нож, три вида гранат.
  slot1: ["Digit1", "Numpad1"],
  slot2: ["Digit2", "Numpad2"],
  slot3: ["Digit3", "Numpad3"],
  slot4: ["Digit4", "Numpad4"],
  slot5: ["Digit5", "Numpad5"],
  slot6: ["Digit6", "Numpad6"],
  slot7: ["Digit7", "Numpad7"],
  // Q/E заняты наклонами, поэтому «предыдущее оружие» — на X.
  lastWeapon: ["KeyX"],
};

/**
 * Ввод: клавиатура, кнопки мыши и относительное движение мыши через Pointer Lock.
 * Дельта мыши копится между кадрами и потребляется игроком один раз за кадр.
 */
export class InputManager {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly mouseHeld = new Set<number>();
  private readonly mousePressed = new Set<number>();

  private dx = 0;
  private dy = 0;
  private wheel = 0;

  private locked = false;
  private listeners: Array<() => void> = [];

  /** Вызывается при изменении состояния захвата курсора. */
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Нажат Escape (вне pointer lock его ловим отдельно). */
  onEscape: (() => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        this.onEscape?.();
        return;
      }
      // Пробел/стрелки не должны скроллить страницу в браузерной сборке.
      if (this.locked && ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) {
        e.preventDefault();
      }
      if (e.repeat) return;
      this.held.add(e.code);
      this.pressed.add(e.code);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.held.delete(e.code);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!this.locked) return;
      this.mouseHeld.add(e.button);
      this.mousePressed.add(e.button);
    };

    const onMouseUp = (e: MouseEvent) => {
      this.mouseHeld.delete(e.button);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    };

    const onWheel = (e: WheelEvent) => {
      if (!this.locked) return;
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    const onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.clear();
      this.onLockChange?.(this.locked);
    };

    const onBlur = () => this.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("blur", onBlur);
    document.addEventListener("pointerlockchange", onLockChange);
    this.canvas.addEventListener("contextmenu", onContextMenu);

    this.listeners = [
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("mousedown", onMouseDown),
      () => window.removeEventListener("mouseup", onMouseUp),
      () => window.removeEventListener("mousemove", onMouseMove),
      () => window.removeEventListener("wheel", onWheel),
      () => window.removeEventListener("blur", onBlur),
      () => document.removeEventListener("pointerlockchange", onLockChange),
      () => this.canvas.removeEventListener("contextmenu", onContextMenu),
    ];
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
  }

  // ------------------------------------------------------------ pointer lock

  get isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    if (this.locked) return;
    const res = this.canvas.requestPointerLock() as unknown;
    // В новых браузерах requestPointerLock возвращает промис; ошибку глотаем —
    // повторный запрос слишком быстро после exit блокируется движком.
    if (res instanceof Promise) res.catch(() => undefined);
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ------------------------------------------------------------------ опрос

  isDown(action: Action): boolean {
    for (const code of BINDINGS[action]) if (this.held.has(code)) return true;
    return false;
  }

  wasPressed(action: Action): boolean {
    for (const code of BINDINGS[action]) if (this.pressed.has(code)) return true;
    return false;
  }

  isMouseDown(button: number): boolean {
    return this.mouseHeld.has(button);
  }

  wasMousePressed(button: number): boolean {
    return this.mousePressed.has(button);
  }

  /** Ось движения: x — стрейф, y — вперёд/назад. Нормализована по диагонали. */
  moveAxis(): { x: number; y: number } {
    let x = (this.isDown("right") ? 1 : 0) - (this.isDown("left") ? 1 : 0);
    let y = (this.isDown("forward") ? 1 : 0) - (this.isDown("back") ? 1 : 0);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  /** Ось наклона: -1 влево (Q), +1 вправо (E). */
  leanAxis(): number {
    return (this.isDown("leanRight") ? 1 : 0) - (this.isDown("leanLeft") ? 1 : 0);
  }

  /** Забрать накопленное движение мыши (обнуляет накопитель). */
  consumeMouseDelta(): { x: number; y: number } {
    const out = { x: this.dx, y: this.dy };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Вызывать в конце кадра: сбрасывает "нажато в этом кадре". */
  endFrame(): void {
    this.pressed.clear();
    this.mousePressed.clear();
  }

  clear(): void {
    this.held.clear();
    this.pressed.clear();
    this.mouseHeld.clear();
    this.mousePressed.clear();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  }
}
