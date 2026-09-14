import { clamp, clamp01 } from "../core/MathUtil";
import type { HitZone } from "../world/Targets";

export interface HudSlotInfo {
  slot: number;
  name: string;
}

export type HudSight = "none" | "iron" | "reddot" | "scope";

export interface HudState {
  weaponName: string;
  weaponCaliber: string;
  /** Патроны; null — оружие без боезапаса (нож, гранаты). */
  ammo: { mag: number; reserve: number; magSize: number } | null;
  /** Количество гранат в руках; null — не применимо. */
  count: number | null;
  activeSlot: number;
  /** Остатки по слотам: слот -> количество (для гранат). */
  slotCounts: Map<number, number>;
  /** Подписи слотов: в слоте «1» может лежать автомат или снайперка. */
  slotNames: Map<number, string>;

  reloading: boolean;
  reloadProgress: number;
  /** Полуугол разброса, градусы. */
  spreadDeg: number;
  /** Вертикальный FOV камеры, радианы — нужен для перевода разброса в пиксели. */
  fovV: number;
  adsT: number;
  sight: HudSight;
  showCrosshair: boolean;

  crouching: boolean;
  sprinting: boolean;
  leaning: boolean;
  shots: number;
  hits: number;
  headshots: number;
  accuracy: number;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`HUD: не найден элемент #${id}`);
  return node as T;
}

/** DOM-оверлей: марка прицела, боезапас, слоты оружия, оптика и ослепление. */
export class HUD {
  private readonly root = el("hud");
  private readonly crosshair = el("crosshair");
  private readonly hitmarkerEl = el("hitmarker");
  private readonly weaponNameEl = el("weapon-name");
  private readonly ammoMag = el("ammo-mag");
  private readonly ammoSep = el("ammo-sep");
  private readonly ammoReserve = el("ammo-reserve");
  private readonly fireModeEl = el("fire-mode");
  private readonly reloadBar = el("reload-bar");
  private readonly reloadFill = el("reload-fill");
  private readonly reloadPrompt = el("reload-prompt");
  private readonly stStance = el("st-stance");
  private readonly stSprint = el("st-sprint");
  private readonly stLean = el("st-lean");
  private readonly stHits = el("st-hits");
  private readonly stHeads = el("st-heads");
  private readonly stAcc = el("st-acc");
  private readonly fpsEl = el("fps");
  private readonly hintEl = el("hint");
  private readonly vignette = el("ads-vignette");
  private readonly scopeEl = el("scope");
  private readonly reddotEl = el("reddot");
  private readonly flashEl = el("flash");
  private readonly slotsEl = el("weapon-slots");
  private readonly duelEl = el("duel");
  private readonly duelYou = el("duel-you");
  private readonly duelBot = el("duel-bot");
  private readonly duelMessage = el("duel-message");
  private readonly healthEl = el("health");
  private readonly healthFill = el("health-fill");
  private readonly healthValue = el("health-value");
  private readonly damageVignette = el("damage-vignette");

  private readonly slotNodes = new Map<number, { row: HTMLElement; name: HTMLElement; count: HTMLElement }>();

  private hintTimer = 0;
  private lastAmmo = "";
  private lastSlot = -1;

  private flashIntensity = 0;
  private flashTimer = 0;
  private flashDuration = 0;

  private damageTimer = 0;

  constructor() {
    this.buildScopeReticle();
  }

  /**
   * Сетка оптического прицела: перекрестие с милдотами и шкала дальности
   * сверху — как в тактических прицелах кратностью 4–8x.
   */
  private buildScopeReticle(): void {
    const svg = this.scopeEl.querySelector("svg.reticle");
    if (!svg) return;
    const NS = "http://www.w3.org/2000/svg";
    const ink = "#0b0b0c";

    const add = (tag: string, attrs: Record<string, string | number>): SVGElement => {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.appendChild(node);
      return node as SVGElement;
    };

    // Основные нити: горизонталь с разрывом в центре и вертикаль вниз.
    add("line", { x1: 13, y1: 100, x2: 90, y2: 100, stroke: ink, "stroke-width": 1.5 });
    add("line", { x1: 110, y1: 100, x2: 187, y2: 100, stroke: ink, "stroke-width": 1.5 });
    add("line", { x1: 100, y1: 110, x2: 100, y2: 187, stroke: ink, "stroke-width": 1.5 });
    add("line", { x1: 100, y1: 13, x2: 100, y2: 90, stroke: ink, "stroke-width": 0.7 });

    // Тонкий крест в центре — точка прицеливания.
    add("line", { x1: 93, y1: 100, x2: 107, y2: 100, stroke: ink, "stroke-width": 0.8 });
    add("line", { x1: 100, y1: 93, x2: 100, y2: 107, stroke: ink, "stroke-width": 0.8 });

    // Милдоты вниз — поправки на дальность.
    for (let i = 1; i <= 6; i++) {
      const y = 100 + i * 13;
      const w = i % 2 === 0 ? 7 : 4;
      add("line", { x1: 100 - w, y1: y, x2: 100 + w, y2: y, stroke: ink, "stroke-width": 1.2 });
    }
    // Милдоты по горизонтали — поправки на ветер и упреждение.
    for (let i = 1; i <= 5; i++) {
      const d = i * 13;
      const h = i % 2 === 0 ? 6 : 3.5;
      add("line", { x1: 100 - d, y1: 100 - h, x2: 100 - d, y2: 100 + h, stroke: ink, "stroke-width": 1.2 });
      add("line", { x1: 100 + d, y1: 100 - h, x2: 100 + d, y2: 100 + h, stroke: ink, "stroke-width": 1.2 });
    }

    // Шкала дальности сверху.
    add("line", { x1: 52, y1: 36, x2: 148, y2: 36, stroke: ink, "stroke-width": 1 });
    for (let i = 0; i <= 8; i++) {
      const x = 52 + i * 12;
      add("line", { x1: x, y1: 36, x2: x, y2: 36 + (i % 2 === 0 ? 5 : 3), stroke: ink, "stroke-width": 1 });
    }
    for (const [i, label] of [
      [0, "100"],
      [4, "200"],
      [8, "300"],
    ] as Array<[number, string]>) {
      const text = add("text", {
        x: 52 + i * 12,
        y: 32,
        fill: ink,
        "font-size": 6,
        "text-anchor": "middle",
        "font-family": "'Segoe UI', sans-serif",
      });
      text.textContent = label;
    }
  }

  show(): void {
    this.root.classList.add("visible");
    this.hintTimer = 0;
    this.hintEl.classList.remove("faded");
  }

  hide(): void {
    this.root.classList.remove("visible");
  }

  setFpsVisible(visible: boolean): void {
    this.fpsEl.classList.toggle("hidden", !visible);
  }

  setFps(value: number): void {
    this.fpsEl.textContent = `${Math.round(value)} FPS`;
  }

  /** Строит список слотов один раз при запуске. */
  buildWeaponSlots(items: HudSlotInfo[]): void {
    this.slotsEl.textContent = "";
    this.slotNodes.clear();

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "wslot";

      const key = document.createElement("span");
      key.className = "key";
      key.textContent = String(item.slot);

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.name;

      const count = document.createElement("span");
      count.className = "count";

      row.append(key, name, count);
      this.slotsEl.append(row);
      this.slotNodes.set(item.slot, { row, name, count });
    }
    this.lastSlot = -1;
  }

  update(state: HudState, dt: number, viewportHeight: number): void {
    this.updateCrosshair(state, viewportHeight);
    this.updateAmmo(state);
    this.updateSlots(state);
    this.updateStatus(state);
    this.updateOverlays(state, dt);

    // ---- подсказка управления не должна лезть в прицел
    this.hintEl.style.visibility = state.sight === "scope" && state.adsT > 0.5 ? "hidden" : "";
    if (this.hintTimer < 11) {
      this.hintTimer += dt;
      if (this.hintTimer >= 11) this.hintEl.classList.add("faded");
    }
  }

  private updateCrosshair(state: HudState, viewportHeight: number): void {
    // Раствор марки = реальный конус разброса в пикселях экрана.
    const halfH = viewportHeight / 2;
    const pxPerRad = halfH / Math.tan(state.fovV / 2);
    const spreadPx = Math.tan((state.spreadDeg * Math.PI) / 180) * pxPerRad;
    const gap = clamp(spreadPx, 3, 140);

    this.crosshair.style.setProperty("--gap", `${gap.toFixed(1)}px`);
    this.crosshair.style.setProperty("--len", `${clamp(5 + gap * 0.08, 5, 14).toFixed(1)}px`);
    this.crosshair.classList.toggle("hidden", !state.showCrosshair);
  }

  private updateAmmo(state: HudState): void {
    this.weaponNameEl.textContent = `${state.weaponName} / ${state.weaponCaliber}`;

    if (state.ammo) {
      const key = `${state.ammo.mag}/${state.ammo.reserve}`;
      if (key !== this.lastAmmo) {
        this.lastAmmo = key;
        this.ammoMag.textContent = String(state.ammo.mag);
        // Порог «мало патронов» относительный: у снайперки магазин на 5.
        this.ammoMag.classList.toggle("low", state.ammo.mag <= Math.max(1, Math.ceil(state.ammo.magSize * 0.25)));
        this.ammoReserve.textContent = String(state.ammo.reserve);
      }
      this.ammoSep.style.display = "";
      this.ammoReserve.style.display = "";
      this.fireModeEl.textContent = "";
    } else if (state.count !== null) {
      const key = `g${state.count}`;
      if (key !== this.lastAmmo) {
        this.lastAmmo = key;
        this.ammoMag.textContent = String(state.count);
        this.ammoMag.classList.toggle("low", state.count <= 1);
      }
      this.ammoSep.style.display = "none";
      this.ammoReserve.style.display = "none";
      this.fireModeEl.textContent = "ШТ.";
    } else {
      if (this.lastAmmo !== "melee") {
        this.lastAmmo = "melee";
        this.ammoMag.textContent = "—";
        this.ammoMag.classList.remove("low");
      }
      this.ammoSep.style.display = "none";
      this.ammoReserve.style.display = "none";
      this.fireModeEl.textContent = "";
    }

    this.reloadBar.classList.toggle("active", state.reloading);
    if (state.reloading) this.reloadFill.style.width = `${(state.reloadProgress * 100).toFixed(1)}%`;
    this.reloadPrompt.classList.toggle(
      "show",
      state.ammo !== null && state.ammo.mag === 0 && !state.reloading && state.ammo.reserve > 0
    );
  }

  private updateSlots(state: HudState): void {
    if (state.activeSlot !== this.lastSlot) {
      this.lastSlot = state.activeSlot;
      for (const [slot, node] of this.slotNodes) {
        node.row.classList.toggle("active", slot === state.activeSlot);
      }
    }
    for (const [slot, node] of this.slotNodes) {
      const count = state.slotCounts.get(slot);
      const text = count === undefined ? "" : String(count);
      if (node.count.textContent !== text) node.count.textContent = text;
      node.row.classList.toggle("empty", count === 0);

      const name = state.slotNames.get(slot);
      if (name && node.name.textContent !== name) node.name.textContent = name;
    }
  }

  private updateStatus(state: HudState): void {
    this.stStance.textContent = state.crouching ? "ПРИСЕД" : "СТОЯ";
    this.stStance.classList.toggle("on", state.crouching);
    this.stSprint.classList.toggle("on", state.sprinting);
    this.stLean.classList.toggle("on", state.leaning);

    this.stHits.textContent = String(state.hits);
    this.stHeads.textContent = String(state.headshots);
    this.stAcc.textContent = state.shots > 0 ? `${Math.round(state.accuracy * 100)}%` : "—";
  }

  private updateOverlays(state: HudState, dt: number): void {
    const scoped = state.sight === "scope" && state.adsT > 0.82;
    // Коллиматорная точка появляется раньше полного зума — так целиться быстрее.
    const reddot = state.sight === "reddot" && state.adsT > 0.55;

    // Виньетка уместна только с механическим прицелом: у оптики своя маска,
    // а коллиматор не сужает обзор.
    const vignette = state.sight === "iron" ? clamp01((state.adsT - 0.25) / 0.75) * 0.9 : 0;
    this.vignette.style.opacity = vignette.toFixed(3);
    this.scopeEl.classList.toggle("on", scoped);
    this.reddotEl.classList.toggle("on", reddot);

    if (this.damageTimer > 0) {
      this.damageTimer = Math.max(0, this.damageTimer - dt);
      this.damageVignette.style.opacity = (this.damageTimer / 0.55) * 0.85 + "";
    }

    // Вспышка: короткий «белый экран», затем медленное восстановление зрения.
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
      const t = 1 - this.flashTimer / this.flashDuration;
      const curve = t < 0.12 ? 1 : Math.pow(1 - (t - 0.12) / 0.88, 1.7);
      this.flashEl.style.opacity = (this.flashIntensity * curve).toFixed(3);
      if (this.flashTimer <= 0) this.flashEl.style.opacity = "0";
    }
  }

  /** Счёт и здоровье дуэли; `null` скрывает всю панель режима. */
  setDuel(info: { playerScore: number; botScore: number; message: string; health: number } | null): void {
    const on = info !== null;
    this.duelEl.classList.toggle("hidden", !on);
    this.healthEl.classList.toggle("hidden", !on);
    if (!info) return;

    if (this.duelYou.textContent !== String(info.playerScore)) this.duelYou.textContent = String(info.playerScore);
    if (this.duelBot.textContent !== String(info.botScore)) this.duelBot.textContent = String(info.botScore);
    if (this.duelMessage.textContent !== info.message) this.duelMessage.textContent = info.message;

    const percent = Math.round(clamp01(info.health) * 100);
    this.healthFill.style.width = `${percent}%`;
    this.healthValue.textContent = String(percent);
    this.healthEl.classList.toggle("low", percent <= 35);
  }

  /** Красная засветка по краям экрана при попадании по игроку. */
  damageFlash(): void {
    this.damageTimer = 0.55;
    this.damageVignette.style.opacity = "0.85";
  }

  /** Ослепление светошумовой гранатой. */
  flash(intensity: number, duration: number): void {
    // Новая вспышка перебивает старую, если она сильнее.
    if (intensity * duration < this.flashIntensity * this.flashTimer) return;
    this.flashIntensity = clamp01(intensity);
    this.flashDuration = Math.max(0.2, duration);
    this.flashTimer = this.flashDuration;
    this.flashEl.style.opacity = this.flashIntensity.toFixed(3);
  }

  clearFlash(): void {
    this.flashTimer = 0;
    this.flashIntensity = 0;
    this.flashEl.style.opacity = "0";
  }

  hitmarker(zone: HitZone, killed: boolean): void {
    const node = this.hitmarkerEl;
    node.classList.remove("show", "head", "kill");
    // Перезапуск CSS-анимации требует принудительного reflow.
    void node.offsetWidth;
    if (zone === "head") node.classList.add("head");
    if (killed) node.classList.add("kill");
    node.classList.add("show");
  }
}
