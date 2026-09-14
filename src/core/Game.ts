import { DefaultRenderingPipeline, Engine, ImageProcessingConfiguration, Scene, Vector3 } from "@babylonjs/core";
import { AudioManager } from "../fx/AudioManager";
import { Effects } from "../fx/Effects";
import { GrenadeSystem } from "../fx/Grenades";
import { EnemyManager } from "../characters/Enemy";
import { PlayerBody } from "../characters/PlayerBody";
import { DuelMode } from "../modes/Duel";
import { InputManager } from "../input/InputManager";
import { Player } from "../player/Player";
import { HUD, type HudSlotInfo } from "../ui/HUD";
import { Menu } from "../ui/Menu";
import { Level } from "../world/Level";
import { TargetManager, type HitZone } from "../world/Targets";
import { Firearm } from "../weapons/Firearm";
import { GrenadeWeapon } from "../weapons/GrenadeWeapon";
import { Inventory } from "../weapons/Inventory";
import { Melee } from "../weapons/Melee";
import { createStats, type IWeapon, type SessionStats } from "../weapons/Types";
import { FIREARMS, GRENADES, KNIFE } from "../weapons/WeaponConfig";
import { ModelFactory, VIEWMODEL_LAYER } from "../weapons/models";
import { ViewModel } from "../weapons/ViewModel";
import { clamp, hFovToVFov, lerp, smoothstep } from "./MathUtil";
import { settings } from "./Settings";

type Mode = "menu" | "playing";

/** Сборка всех подсистем и главный цикл. */
export class Game {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly input: InputManager;
  private readonly audio = new AudioManager();
  private readonly level: Level;
  private readonly effects: Effects;
  private readonly targets: TargetManager;
  private readonly player: Player;
  private readonly hud = new HUD();
  private readonly menu: Menu;
  private readonly pipeline: DefaultRenderingPipeline;

  private readonly playerBody: PlayerBody;
  private readonly enemies: EnemyManager;
  private readonly duel: DuelMode;
  /** Идёт ли сейчас дуэль: в ней отключены полигонные бойцы. */
  private duelActive = false;
  /** Камера смерти: облетает тело игрока после проигранного раунда. */
  private readonly playerDeath = { active: false, timer: 0, orbit: 0 };
  private readonly deathTarget = new Vector3();
  private readonly stats: SessionStats = createStats();
  private readonly grenadeSystem: GrenadeSystem;
  private readonly inventory: Inventory;
  private readonly firearms: Firearm[] = [];
  private readonly grenadeWeapons: GrenadeWeapon[] = [];
  private readonly slotCounts = new Map<number, number>();
  private readonly slotNames = new Map<number, string>();
  private slotList: HudSlotInfo[] = [];

  private mode: Mode = "menu";
  private fpsAccum = 0;

  /** Накопитель времени для ограничителя кадров. */
  private frameAccum = 0;
  private smoothDt = 1 / 60;
  /** FPS считаем по реально отрисованным кадрам, а не по вызовам rAF. */
  private renderedFrames = 0;
  private renderedTime = 0;
  private displayFps = 60;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, {
      stencil: true,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    // Итоговое разрешение = CSS-размер * dpr * renderScale (см. applySettings).
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));

    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = true;
    // Слой вьюмодели очищает глубину: ствол не проваливается в стены.
    this.scene.setRenderingAutoClearDepthStencil(VIEWMODEL_LAYER, true, true, true);

    this.level = new Level(this.scene);
    this.effects = new Effects(this.scene, this.level.textures);

    this.player = new Player(this.scene, {
      onFootstep: (running, crouching) => this.audio.footstep(running, crouching),
      onJump: () => this.audio.jump(),
      onLand: (speed) => this.audio.land(speed),
    });
    this.scene.activeCamera = this.player.camera;

    this.targets = new TargetManager(this.scene);

    // Тело игрока видно при взгляде вниз; бойцы живут по своим маршрутам.
    this.playerBody = new PlayerBody(this.scene, this.player);
    this.enemies = new EnemyManager(this.scene);
    for (const enemy of this.enemies.all) this.targets.addHittable(enemy);

    this.grenadeSystem = new GrenadeSystem(
      this.scene,
      this.level.textures,
      this.audio,
      this.targets,
      this.player,
      this.effects,
      {
        onFlash: (intensity, duration) => this.hud.flash(intensity, duration),
        onFragHits: (hits, kills) => {
          this.stats.hits += hits;
          this.stats.kills += kills;
        },
      }
    );

    this.duel = new DuelMode(this.scene, this.audio, this.player, {
      onPlayerHit: (_damage, _direction) => {
        this.hud.damageFlash();
        this.audio.impact("dummy", 1);
      },
      onPlayerDied: (direction) => this.killPlayer(direction),
      onRoundStart: () => this.revivePlayer(),
    });
    this.targets.addHittable(this.duel.bot);

    this.inventory = new Inventory(this.buildArsenal(), this.audio);
    this.slotList = this.buildSlotInfo();
    this.hud.buildWeaponSlots(this.slotList);
    this.effects.onShellLand = (distance) => this.audio.shellDrop(distance);

    this.targets.forEachShadowCaster((m) => this.level.addShadowCaster(m));
    this.enemies.forEachMesh((m) => this.level.addShadowCaster(m));
    for (const m of this.duel.bot.character.meshes) this.level.addShadowCaster(m);
    for (const m of this.playerBody.meshes) this.level.addShadowCaster(m);
    this.level.finalize();

    this.pipeline = new DefaultRenderingPipeline("post", true, this.scene, [this.player.camera]);
    this.pipeline.fxaaEnabled = true;
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.85;
    this.pipeline.bloomWeight = 0.22;
    this.pipeline.bloomKernel = 48;
    this.pipeline.imageProcessing.toneMappingEnabled = true;
    this.pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.pipeline.imageProcessing.contrast = 1.06;
    this.pipeline.imageProcessing.exposure = 0.95;

    this.input = new InputManager(canvas);
    this.input.attach();
    this.input.onEscape = () => this.onEscape();
    this.input.onLockChange = (locked) => this.onLockChange(locked);

    this.menu = new Menu({
      onStart: () => this.startNewSession(),
      onStartDuel: () => this.startDuel(),
      onResume: () => this.resume(),
      onQuitToMenu: () => this.quitToMenu(),
      onResetRange: () => this.resetRange(),
      onExit: () => window.desktop?.quit(),
      onNavigate: () => {
        this.audio.unlock();
        this.audio.uiClick();
      },
    });

    settings.onChange(() => this.applySettings());
    this.applySettings();

    // Клик по канвасу возвращает захват курсора (браузер может отказать сразу после Escape).
    canvas.addEventListener("click", () => {
      if (this.mode === "playing" && !this.input.isLocked) this.input.requestLock();
    });

    window.addEventListener("resize", () => this.engine.resize());
    this.menu.show("main");
  }

  // ------------------------------------------------------------------ арсенал

  private buildArsenal(): IWeapon[] {
    const factory = new ModelFactory(this.scene);
    const textures = this.level.textures;
    const camera = this.player.camera;
    const weapons: IWeapon[] = [];
    const onHit = (zone: HitZone, killed: boolean): void => this.hud.hitmarker(zone, killed);

    for (const cfg of FIREARMS) {
      const vm = new ViewModel(this.scene, camera, factory, cfg.modelKind, textures, true);
      const firearm = new Firearm(
        cfg,
        vm,
        this.scene,
        this.player,
        this.effects,
        this.audio,
        this.targets,
        this.stats,
        { onHitConfirmed: onHit }
      );
      this.firearms.push(firearm);
      weapons.push(firearm);
    }

    const knifeVm = new ViewModel(this.scene, camera, factory, "knife", textures, false);
    weapons.push(
      new Melee(KNIFE, knifeVm, this.scene, this.player, this.effects, this.audio, this.targets, this.stats, onHit)
    );

    for (const cfg of GRENADES) {
      const vm = new ViewModel(this.scene, camera, factory, cfg.kind, textures, false);
      const grenade = new GrenadeWeapon(cfg, vm, this.player, this.audio, this.grenadeSystem);
      this.grenadeWeapons.push(grenade);
      weapons.push(grenade);
    }

    return weapons.sort((a, b) => a.slot - b.slot);
  }

  /** По одной строке на слот: автомат и снайперка делят «1». */
  private buildSlotInfo(): HudSlotInfo[] {
    const seen = new Set<number>();
    const out: HudSlotInfo[] = [];
    for (const w of this.inventory.all) {
      if (seen.has(w.slot)) continue;
      seen.add(w.slot);
      out.push({ slot: w.slot, name: w.displayName });
    }
    return out;
  }

  run(): void {
    this.engine.runRenderLoop(() => {
      const raw = Math.min(this.engine.getDeltaTime() / 1000, 0.25);
      this.frameAccum += raw;

      // Ограничитель кадров: лишние сотни FPS не добавляют плавности, но делают
      // интервалы между кадрами неровными — движение начинает «подрагивать».
      const limit = settings.current.fpsLimit;
      if (limit > 0 && this.frameAccum < 1 / limit - 0.0005) return;

      const dt = Math.min(this.frameAccum, 0.05);
      this.frameAccum = 0;

      // Мягкое сглаживание шага времени убирает дрожание камеры на неровных кадрах.
      this.smoothDt += (dt - this.smoothDt) * 0.4;
      const step = clamp(this.smoothDt, 1 / 480, 0.05);

      if (this.mode === "playing") this.updateGameplay(step);
      else this.updateMenuScene(step);
      this.scene.render();

      this.renderedFrames++;
      this.renderedTime += dt;
      if (this.renderedTime >= 0.5) {
        this.displayFps = this.renderedFrames / this.renderedTime;
        this.renderedFrames = 0;
        this.renderedTime = 0;
      }
    });
  }

  // ------------------------------------------------------------- состояния

  /** Дуэль: полигонные бойцы прячутся, на арене остаётся один противник. */
  private startDuel(): void {
    this.audio.unlock();
    this.prepareLoadout();
    this.revivePlayer();
    this.duelActive = true;
    for (const e of this.enemies.all) e.character.setEnabled(false);
    this.targets.setVisible(false);
    this.duel.start();
    this.enterPlaying();
  }

  /** Игрок убит: тело падает рэгдоллом, камера отлетает и смотрит на него. */
  private killPlayer(direction: Vector3): void {
    if (this.playerDeath.active) return;
    this.playerDeath.active = true;
    this.playerDeath.timer = 0;
    // Камера уходит за спину — оттуда падение видно целиком.
    this.playerDeath.orbit = this.player.yaw + Math.PI;

    const velocity = this.player.body.velocity.clone();
    const impulse = direction.scale(5.5);
    const point = this.player.position.add(new Vector3(0, 1.25, 0));
    this.playerBody.die(velocity, impulse, point);

    this.inventory.current.viewModel.setActive(false);
    this.input.clear();
    this.audio.land(6);
  }

  private revivePlayer(): void {
    if (!this.playerDeath.active) return;
    this.playerDeath.active = false;
    this.playerBody.reset();
    this.inventory.current.viewModel.setActive(true);
  }

  /** Медленный облёт тела: дистанция плавно растёт, взгляд держится на груди. */
  private updateDeathCamera(dt: number): void {
    this.playerDeath.timer += dt;
    this.playerDeath.orbit += dt * 0.3;

    this.playerBody.getViewTarget(this.deathTarget);
    const distance = 2.4 + Math.min(this.playerDeath.timer * 0.4, 1.4);
    const height = 1.35;

    const camera = this.player.camera;
    camera.position.set(
      this.deathTarget.x + Math.sin(this.playerDeath.orbit) * distance,
      this.deathTarget.y + height,
      this.deathTarget.z + Math.cos(this.playerDeath.orbit) * distance
    );

    const dx = this.deathTarget.x - camera.position.x;
    const dy = this.deathTarget.y - camera.position.y;
    const dz = this.deathTarget.z - camera.position.z;
    camera.rotation.set(Math.atan2(-dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0);
  }

  /** Общая подготовка снаряжения для любого режима. */
  private prepareLoadout(): void {
    for (const f of this.firearms) f.refill();
    for (const g of this.grenadeWeapons) g.refill();
    this.inventory.resetToPrimary();
    this.playerBody.reset();
    this.grenadeSystem.clear();
    this.hud.clearFlash();
    this.resetStats();
    this.effects.clearDecals();
  }

  private startNewSession(): void {
    this.audio.unlock();
    this.revivePlayer();
    this.player.respawn();
    this.prepareLoadout();
    this.duelActive = false;
    this.duel.stop();
    this.targets.setVisible(true);
    for (const e of this.enemies.all) e.character.setEnabled(true);
    this.enemies.resetAll();
    this.targets.resetAll();
    this.enterPlaying();
  }

  private resetStats(): void {
    this.stats.shots = 0;
    this.stats.hits = 0;
    this.stats.headshots = 0;
    this.stats.kills = 0;
  }

  private resume(): void {
    this.enterPlaying();
  }

  private enterPlaying(): void {
    this.mode = "playing";
    this.menu.hide();
    this.hud.show();
    this.audio.resume();
    this.input.clear();
    this.input.requestLock();
  }

  private pause(): void {
    if (this.mode !== "playing") return;
    this.mode = "menu";
    this.hud.hide();
    this.input.releaseLock();
    this.input.clear();
    this.audio.suspend();
    this.menu.show("pause");
  }

  private quitToMenu(): void {
    this.mode = "menu";
    this.hud.hide();
    this.input.releaseLock();
    this.menu.show("main");
  }

  private resetRange(): void {
    this.targets.resetAll();
    this.enemies.resetAll();
    this.effects.clearDecals();
    this.grenadeSystem.clear();
    this.hud.clearFlash();
    this.resetStats();
  }

  private onEscape(): void {
    if (this.mode === "playing") {
      this.pause();
      return;
    }
    if (this.menu.screen === "settings") {
      // Возврат из настроек обрабатывает сама панель.
      document.getElementById("btn-settings-back")?.click();
    } else if (this.menu.screen === "pause") {
      this.resume();
    }
  }

  private onLockChange(locked: boolean): void {
    if (!locked && this.mode === "playing") this.pause();
  }

  // ----------------------------------------------------------------- кадр

  private updateGameplay(dt: number): void {
    // Пока игрок мёртв, управление отключено: идёт только физика тела и мира.
    if (this.playerDeath.active) {
      this.updateDeathCamera(dt);
      this.playerBody.update(dt);
      if (this.duelActive) this.duel.update(dt);
      this.targets.update(dt);
      this.effects.update(dt);
      this.grenadeSystem.update(dt);
      this.audio.update(dt);
      this.applyFov(0, 1);
      this.updateHud(dt, this.inventory.current);
      this.input.endFrame();
      return;
    }

    this.inventory.update(dt, this.input);
    const weapon = this.inventory.current;
    const canAct = this.inventory.canAct;

    // 1) Прицеливание/отдача -> 2) игрок и камера -> 3) действие по итоговым углам.
    weapon.updateAim(dt, this.input, canAct);
    this.player.update(dt, this.input, {
      adsT: weapon.aimProgress,
      recoil: weapon.recoilAim,
      viewPunch: weapon.viewPunch,
      allowSprint: weapon.allowSprint && !this.inventory.isSwitching,
    });
    weapon.updateAction(dt, this.input, canAct);
    weapon.updateViewModel(dt, this.inventory.equipProgress);
    // Тело обновляем после игрока — оно повторяет его позу.
    this.playerBody.update(dt);
    if (this.duelActive) this.duel.update(dt);
    else this.enemies.update(dt, this.player.position);

    if (this.input.wasPressed("resetRange")) this.resetRange();
    if (this.input.wasPressed("fullscreen")) window.desktop?.toggleFullscreen();

    this.targets.update(dt);
    this.effects.update(dt);
    this.grenadeSystem.update(dt);
    this.audio.update(dt);
    this.applyFov(weapon.aimProgress, weapon.adsFovMul);
    this.updateHud(dt, weapon);

    this.input.endFrame();
  }

  private updateMenuScene(dt: number): void {
    // В меню мир продолжает жить: мишени встают, гильзы падают, дым рассеивается.
    this.targets.update(dt);
    if (this.duelActive) this.duel.update(dt);
    else this.enemies.update(dt, this.player.position);
    this.effects.update(dt);
    this.grenadeSystem.update(dt);
    this.audio.update(dt);
    this.applyFov(0, 1);
  }

  private applyFov(adsT: number, adsFovMul: number): void {
    const camera = this.player.camera;
    const aspect = this.engine.getAspectRatio(camera);
    const hip = hFovToVFov(settings.current.fovDeg, aspect);
    // В прицеле поле зрения сужается — у оптики заметно сильнее, чем у механики.
    const ads = hFovToVFov(settings.current.fovDeg * adsFovMul, aspect);
    camera.fov = lerp(hip, ads, smoothstep(adsT));
  }

  private updateHud(dt: number, weapon: IWeapon): void {
    this.fpsAccum += dt;
    if (this.fpsAccum > 0.25) {
      this.fpsAccum = 0;
      this.hud.setFps(this.displayFps);
    }

    this.slotCounts.clear();
    for (const g of this.grenadeWeapons) this.slotCounts.set(g.slot, g.hudCount);

    this.slotNames.clear();
    for (const info of this.slotList) {
      this.slotNames.set(info.slot, this.inventory.activeInSlot(info.slot).displayName);
    }

    // У гранат и ножа прицеливания нет — марку из-за «замаха» прятать не нужно.
    const aimingWithSights = weapon.adsFovMul < 0.99 && weapon.aimProgress > 0.55;

    this.hud.setDuel(
      this.duelActive
        ? {
            playerScore: this.duel.state.playerScore,
            botScore: this.duel.state.botScore,
            message: this.duel.state.message,
            health: this.duel.playerHealthRatio,
          }
        : null
    );

    this.hud.update(
      {
        weaponName: weapon.displayName,
        weaponCaliber: weapon.caliber,
        ammo: weapon.hudAmmo,
        count: weapon.hudCount,
        activeSlot: weapon.slot,
        slotCounts: this.slotCounts,
        slotNames: this.slotNames,

        reloading: weapon.isReloading,
        reloadProgress: weapon.reloadProgress,
        spreadDeg: weapon.spreadDegrees,
        fovV: this.player.camera.fov,
        adsT: weapon.aimProgress,
        sight: weapon.sightType,
        showCrosshair:
          settings.current.crosshair && !aimingWithSights && weapon.spreadDegrees > 0 && !this.playerDeath.active,

        crouching: this.player.crouching,
        sprinting: this.player.sprinting,
        leaning: Math.abs(this.player.leanAmount) > 0.15,
        shots: this.stats.shots,
        hits: this.stats.hits,
        headshots: this.stats.headshots,
        accuracy: this.stats.shots > 0 ? this.stats.hits / this.stats.shots : 0,
      },
      dt,
      this.canvas.clientHeight
    );
  }

  // ------------------------------------------------------------- настройки

  private applySettings(): void {
    const s = settings.current;
    this.audio.setVolume(s.masterVolume);
    this.level.setShadowsEnabled(s.shadows);
    this.hud.setFpsVisible(s.showFps);

    this.pipeline.fxaaEnabled = s.postFx;
    this.pipeline.bloomEnabled = s.postFx;
    this.pipeline.imageProcessing.toneMappingEnabled = s.postFx;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.engine.setHardwareScalingLevel(1 / Math.max(0.3, dpr * s.renderScale));
  }

  dispose(): void {
    this.input.dispose();
    this.playerBody.dispose();
    for (const w of this.inventory.all) w.viewModel.dispose();
    this.player.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
