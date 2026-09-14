import { clamp01, randRange } from "../core/MathUtil";
import type { SurfaceKind } from "../world/Level";
import type { SoundProfile } from "../weapons/WeaponConfig";

interface NoiseOptions {
  duration: number;
  attack?: number;
  gain?: number;
  type?: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  reverb?: number;
}

interface ToneOptions {
  freq: number;
  freqEnd?: number;
  duration: number;
  gain?: number;
  type?: OscillatorType;
  attack?: number;
}

/**
 * Имена звуковых сэмплов. Для каждого движок ищет файл
 * `public/audio/<имя>.(ogg|wav|mp3)`; если файла нет — играет процедурный
 * вариант, синтезированный на WebAudio. Поэтому игра работает и без ассетов,
 * но с ними звучит как обычная игра.
 */
export const SAMPLE_NAMES = [
  "shot-rifle",
  "shot-sniper",
  "shot-pistol",
  "dry-fire",
  "mag-out",
  "mag-in",
  "mag-drop",
  "bolt-pull",
  "bolt-release",
  "ads-in",
  "ads-out",
  "shell-eject",
  "shell-drop",
  "impact-concrete",
  "impact-metal",
  "impact-wood",
  "impact-dirt",
  "impact-flesh",
  "hitmarker",
  "hitmarker-head",
  "target-down",
  "footstep-walk",
  "footstep-run",
  "footstep-crouch",
  "jump",
  "land",
  "knife-swing",
  "knife-swing-heavy",
  "knife-hit-flesh",
  "knife-hit-hard",
  "pin-pull",
  "throw",
  "grenade-bounce",
  "explosion",
  "smoke-pop",
  "flashbang",
  "flash-ring",
  "weapon-switch",
  "weapon-draw",
  "ui-click",
] as const;

export type SampleName = (typeof SAMPLE_NAMES)[number];

const EXTENSIONS = ["ogg", "wav", "mp3"];

/**
 * Звук игры. Сэмплы из `public/audio` подхватываются автоматически, всё
 * остальное синтезируется на лету — в репозитории нет ни одного бинарного
 * ассета, но выстрел, механика и рикошеты звучат по-разному.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private volume = 0.7;

  private readonly samples = new Map<string, AudioBuffer>();
  private samplesRequested = false;

  /** Приглушение после светошумовой: остаток времени и его сила. */
  private deafTimer = 0;
  private deafDuration = 0;
  private deafAmount = 0;

  /** Создаёт контекст. Должен вызываться из обработчика пользовательского ввода. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.volume;

    // Компрессор сглаживает пики очереди — иначе автоматный огонь клиппует.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 9;
    comp.attack.value = 0.002;
    comp.release.value = 0.15;

    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    // Реверб «открытого полигона»: короткий IR из затухающего шума.
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(ctx, 1.35, 3.2);
    const send = ctx.createGain();
    send.gain.value = 1;
    send.connect(convolver);
    const wet = ctx.createGain();
    wet.gain.value = 0.42;
    convolver.connect(wet);
    wet.connect(master);
    this.reverbSend = send;

    this.noiseBuffer = this.makeNoise(ctx, 2);
    void this.loadSamples();
  }

  // ------------------------------------------------------------------ сэмплы

  /**
   * Пытается подгрузить файлы из `audio/`. Отсутствующие просто игнорируются —
   * для них останется процедурный звук.
   */
  private async loadSamples(): Promise<void> {
    if (this.samplesRequested) return;
    this.samplesRequested = true;
    const ctx = this.ctx;
    if (!ctx) return;

    await Promise.all(
      SAMPLE_NAMES.map(async (name) => {
        for (const ext of EXTENSIONS) {
          try {
            const res = await fetch(`audio/${name}.${ext}`);
            if (!res.ok) continue;
            const data = await res.arrayBuffer();
            this.samples.set(name, await ctx.decodeAudioData(data));
            return;
          } catch {
            // Нет файла или он не декодируется — пробуем следующее расширение.
          }
        }
      })
    );
  }

  get loadedSampleCount(): number {
    return this.samples.size;
  }

  /** Играет сэмпл, если он загружен; иначе — процедурный запасной вариант. */
  private play(name: SampleName, fallback: () => void, gain = 1, rate = 1): void {
    const buf = this.samples.get(name);
    const ctx = this.ctx;
    const master = this.master;
    if (!buf || !ctx || !master) {
      fallback();
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * randRange(0.97, 1.03);

    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(master);
    src.start();
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    this.applyVolume();
  }

  /** Итоговая громкость с учётом оглушения после светошумовой. */
  private applyVolume(): void {
    if (!this.master) return;
    const muffle = this.deafDuration > 0 ? (this.deafTimer / this.deafDuration) * this.deafAmount : 0;
    this.master.gain.value = this.volume * (1 - muffle * 0.85);
  }

  /** Восстановление слуха. Вызывается каждый кадр. */
  update(dt: number): void {
    if (this.deafTimer <= 0) return;
    this.deafTimer = Math.max(0, this.deafTimer - dt);
    if (this.deafTimer <= 0) {
      this.deafDuration = 0;
      this.deafAmount = 0;
    }
    this.applyVolume();
  }

  suspend(): void {
    if (this.ctx?.state === "running") void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  // ------------------------------------------------------------- источники

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  private noise(opts: NoiseOptions): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = randRange(0.92, 1.08);
    // Случайное окно внутри буфера — выстрелы не звучат одинаково.
    const offset = Math.random() * 1.2;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? "bandpass";
    filter.frequency.setValueAtTime(opts.freq, now);
    if (opts.freqEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqEnd), now + opts.duration);
    }
    filter.Q.value = opts.q ?? 1;

    const gain = ctx.createGain();
    const peak = opts.gain ?? 0.5;
    const attack = opts.attack ?? 0.001;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + opts.duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    if (opts.reverb && this.reverbSend) {
      const sendGain = ctx.createGain();
      sendGain.gain.value = opts.reverb;
      gain.connect(sendGain);
      sendGain.connect(this.reverbSend);
    }

    src.start(now, offset, opts.duration + attack + 0.05);
    src.stop(now + opts.duration + attack + 0.06);
  }

  private tone(opts: ToneOptions): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(opts.freq, now);
    if (opts.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), now + opts.duration);
    }

    const gain = ctx.createGain();
    const attack = opts.attack ?? 0.002;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(opts.gain ?? 0.3, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + opts.duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + attack + opts.duration + 0.02);
  }

  // ----------------------------------------------------------------- выстрел

  shot(profile: SoundProfile = "rifle"): void {
    switch (profile) {
      case "sniper":
        this.play("shot-sniper", () => {
          this.noise({ duration: 0.08, freq: 4200, freqEnd: 700, type: "bandpass", q: 0.6, gain: 1, reverb: 0.8 });
          this.noise({ duration: 0.32, freq: 900, freqEnd: 120, type: "lowpass", gain: 0.7, reverb: 1 });
          this.tone({ freq: 95, freqEnd: 34, duration: 0.26, gain: 0.55, type: "sine" });
          this.noise({ duration: 0.06, freq: 2600, type: "bandpass", q: 3, gain: 0.14, attack: 0.02 });
        });
        break;
      case "pistol":
        this.play("shot-pistol", () => {
          this.noise({ duration: 0.04, freq: 5600, freqEnd: 1500, type: "bandpass", q: 0.9, gain: 0.6, reverb: 0.35 });
          this.noise({ duration: 0.09, freq: 1700, freqEnd: 320, type: "lowpass", gain: 0.4, reverb: 0.5 });
          this.tone({ freq: 165, freqEnd: 70, duration: 0.07, gain: 0.3, type: "sine" });
          this.noise({ duration: 0.05, freq: 3800, type: "bandpass", q: 3.5, gain: 0.2, attack: 0.01 });
        });
        break;
      default:
        this.play("shot-rifle", () => {
          this.noise({ duration: 0.055, freq: 5200, freqEnd: 1100, type: "bandpass", q: 0.7, gain: 0.85, reverb: 0.5 });
          this.noise({ duration: 0.13, freq: 1400, freqEnd: 240, type: "lowpass", gain: 0.55, reverb: 0.7 });
          this.tone({ freq: 138, freqEnd: 52, duration: 0.11, gain: 0.42, type: "sine" });
          this.noise({ duration: 0.045, freq: 3400, type: "bandpass", q: 3, gain: 0.16, attack: 0.012 });
        });
    }
  }

  dryFire(): void {
    this.play("dry-fire", () => {
      this.noise({ duration: 0.03, freq: 2600, type: "bandpass", q: 4, gain: 0.3 });
      this.tone({ freq: 800, freqEnd: 400, duration: 0.02, gain: 0.08, type: "square" });
    });
  }

  // --------------------------------------------------------------- механика

  magOut(): void {
    this.play("mag-out", () => {
      this.noise({ duration: 0.09, freq: 1500, freqEnd: 600, type: "bandpass", q: 2.2, gain: 0.24 });
    });
  }

  magIn(): void {
    this.play("mag-in", () => {
      this.noise({ duration: 0.07, freq: 900, type: "bandpass", q: 1.6, gain: 0.3 });
      this.tone({ freq: 240, freqEnd: 120, duration: 0.05, gain: 0.16, type: "triangle" });
    });
  }

  magDrop(): void {
    this.play("mag-drop", () => {
      this.noise({ duration: 0.12, freq: 700, freqEnd: 260, type: "bandpass", q: 1.2, gain: 0.14, reverb: 0.25 });
    });
  }

  boltPull(): void {
    this.play("bolt-pull", () => {
      this.noise({ duration: 0.1, freq: 2100, freqEnd: 900, type: "bandpass", q: 2.6, gain: 0.22 });
    });
  }

  boltRelease(): void {
    this.play("bolt-release", () => {
      this.noise({ duration: 0.05, freq: 2800, type: "bandpass", q: 3.5, gain: 0.3 });
      this.tone({ freq: 420, freqEnd: 180, duration: 0.04, gain: 0.12, type: "square" });
    });
  }

  adsToggle(inward: boolean): void {
    this.play(inward ? "ads-in" : "ads-out", () => {
      this.noise({ duration: 0.035, freq: inward ? 2400 : 1800, type: "bandpass", q: 3, gain: 0.1 });
    });
  }

  // ----------------------------------------------------------------- гильзы

  /** Звон гильзы в момент выброса из окна экстракции. */
  shellEject(): void {
    this.play("shell-eject", () => {
      this.noise({ duration: 0.035, freq: randRange(4200, 6200), type: "bandpass", q: 7, gain: 0.1 });
    });
  }

  /** Гильза упала на бетон — короткий звонкий «дзынь». */
  shellDrop(distance: number): void {
    const att = 1 / (1 + distance * 0.35);
    this.play(
      "shell-drop",
      () => {
        this.noise({ duration: 0.05, freq: randRange(3600, 5600), type: "bandpass", q: 9, gain: 0.28 * att });
        this.tone({
          freq: randRange(2400, 4200),
          freqEnd: randRange(1400, 2200),
          duration: 0.16,
          gain: 0.14 * att,
          type: "triangle",
        });
      },
      att
    );
  }

  // --------------------------------------------------------------- попадания

  impact(surface: SurfaceKind, distance: number): void {
    const att = 1 / (1 + distance * 0.09);
    const g = 0.45 * att;
    switch (surface) {
      case "metal":
        this.play(
          "impact-metal",
          () => {
            this.noise({ duration: 0.06, freq: 4200, type: "bandpass", q: 5, gain: g, reverb: 0.4 });
            this.tone({ freq: randRange(1500, 2400), freqEnd: 700, duration: 0.22, gain: g * 0.5, type: "triangle" });
          },
          att
        );
        break;
      case "wood":
        this.play(
          "impact-wood",
          () => {
            this.noise({ duration: 0.08, freq: 900, freqEnd: 300, type: "bandpass", q: 1.4, gain: g });
          },
          att
        );
        break;
      case "sand":
      case "dirt":
        this.play(
          "impact-dirt",
          () => {
            this.noise({ duration: 0.1, freq: 500, freqEnd: 180, type: "lowpass", gain: g * 0.9 });
          },
          att
        );
        break;
      case "dummy":
        this.play(
          "impact-flesh",
          () => {
            this.noise({ duration: 0.07, freq: 420, freqEnd: 160, type: "lowpass", gain: g * 1.1 });
            this.tone({ freq: 160, freqEnd: 70, duration: 0.08, gain: g * 0.35, type: "sine" });
          },
          att
        );
        break;
      default:
        this.play(
          "impact-concrete",
          () => {
            this.noise({ duration: 0.07, freq: 2200, freqEnd: 600, type: "bandpass", q: 1.6, gain: g, reverb: 0.3 });
            this.noise({ duration: 0.14, freq: 380, type: "lowpass", gain: g * 0.4 });
          },
          att
        );
    }
  }

  /** Подтверждение попадания в мишень — короткий «тик» в наушниках. */
  hitmarker(headshot: boolean): void {
    this.play(headshot ? "hitmarker-head" : "hitmarker", () => {
      this.tone({
        freq: headshot ? 1500 : 1050,
        freqEnd: headshot ? 1100 : 820,
        duration: 0.055,
        gain: 0.16,
        type: "square",
      });
    });
  }

  targetDown(): void {
    this.play("target-down", () => {
      this.tone({ freq: 760, freqEnd: 300, duration: 0.18, gain: 0.14, type: "triangle" });
    });
  }

  // ------------------------------------------------------------ перемещение

  footstep(running: boolean, crouching: boolean): void {
    const g = crouching ? 0.05 : running ? 0.15 : 0.09;
    const name = crouching ? "footstep-crouch" : running ? "footstep-run" : "footstep-walk";
    this.play(name, () => {
      this.noise({
        duration: running ? 0.09 : 0.12,
        freq: randRange(700, 1200),
        freqEnd: 240,
        type: "lowpass",
        gain: g,
      });
      this.noise({ duration: 0.04, freq: randRange(2600, 3800), type: "bandpass", q: 2, gain: g * 0.35 });
    });
  }

  jump(): void {
    this.play("jump", () => {
      this.noise({ duration: 0.07, freq: 800, freqEnd: 300, type: "lowpass", gain: 0.08 });
    });
  }

  land(speed: number): void {
    const g = clamp01(speed / 12) * 0.28 + 0.05;
    this.play(
      "land",
      () => {
        this.noise({ duration: 0.16, freq: 600, freqEnd: 150, type: "lowpass", gain: g });
        this.tone({ freq: 90, freqEnd: 45, duration: 0.12, gain: g * 0.5, type: "sine" });
      },
      clamp01(g * 3)
    );
  }

  // ------------------------------------------------------------- ближний бой

  knifeSwing(heavy: boolean): void {
    this.play(heavy ? "knife-swing-heavy" : "knife-swing", () => {
      this.noise({
        duration: heavy ? 0.16 : 0.1,
        freq: heavy ? 1700 : 2600,
        freqEnd: heavy ? 500 : 900,
        type: "bandpass",
        q: 1.2,
        gain: heavy ? 0.18 : 0.12,
      });
    });
  }

  knifeHit(surface: SurfaceKind, heavy: boolean): void {
    const g = heavy ? 0.4 : 0.28;
    const soft = surface === "dummy";
    this.play(soft ? "knife-hit-flesh" : "knife-hit-hard", () => {
      if (soft) {
        this.noise({ duration: 0.09, freq: 520, freqEnd: 150, type: "lowpass", gain: g });
        this.tone({ freq: 190, freqEnd: 80, duration: 0.08, gain: g * 0.4, type: "sine" });
      } else if (surface === "metal") {
        this.noise({ duration: 0.07, freq: 5200, type: "bandpass", q: 6, gain: g, reverb: 0.4 });
        this.tone({ freq: randRange(2000, 3200), freqEnd: 900, duration: 0.26, gain: g * 0.45, type: "triangle" });
      } else {
        this.noise({ duration: 0.08, freq: 1600, freqEnd: 400, type: "bandpass", q: 1.6, gain: g * 0.8 });
      }
    });
  }

  // ----------------------------------------------------------------- гранаты

  pinPull(): void {
    this.play("pin-pull", () => {
      this.noise({ duration: 0.05, freq: 3200, type: "bandpass", q: 5, gain: 0.2 });
      this.tone({ freq: 900, freqEnd: 600, duration: 0.05, gain: 0.08, type: "square" });
    });
  }

  throwWhoosh(): void {
    this.play("throw", () => {
      this.noise({ duration: 0.18, freq: 900, freqEnd: 300, type: "bandpass", q: 0.9, gain: 0.14 });
    });
  }

  grenadeBounce(distance: number): void {
    const att = 1 / (1 + distance * 0.12);
    this.play(
      "grenade-bounce",
      () => {
        this.noise({ duration: 0.05, freq: randRange(1400, 2600), type: "bandpass", q: 4, gain: 0.3 * att });
        this.tone({ freq: randRange(320, 560), freqEnd: 180, duration: 0.06, gain: 0.12 * att, type: "triangle" });
      },
      att
    );
  }

  explosion(distance: number): void {
    const att = 1 / (1 + distance * 0.045);
    this.play(
      "explosion",
      () => {
        // Низ, тело и длинный хвост — именно они дают ощущение мощности.
        this.tone({ freq: 68, freqEnd: 22, duration: 0.55, gain: 0.95 * att, type: "sine" });
        this.noise({ duration: 0.16, freq: 2600, freqEnd: 220, type: "lowpass", gain: 0.9 * att, reverb: 0.9 });
        this.noise({ duration: 0.9, freq: 600, freqEnd: 90, type: "lowpass", gain: 0.5 * att, reverb: 1 });
        this.noise({ duration: 0.08, freq: 6000, freqEnd: 2000, type: "bandpass", q: 0.8, gain: 0.4 * att });
      },
      att
    );
  }

  smokePop(distance: number): void {
    const att = 1 / (1 + distance * 0.07);
    this.play(
      "smoke-pop",
      () => {
        this.noise({ duration: 0.12, freq: 1800, freqEnd: 500, type: "bandpass", q: 1.2, gain: 0.45 * att });
        // Долгое шипение выходящего дыма.
        this.noise({ duration: 2.4, freq: 3400, freqEnd: 2200, type: "bandpass", q: 0.7, gain: 0.16 * att, attack: 0.15 });
      },
      att
    );
  }

  flashBang(distance: number): void {
    const att = 1 / (1 + distance * 0.05);
    this.play(
      "flashbang",
      () => {
        this.noise({ duration: 0.1, freq: 7000, freqEnd: 1200, type: "bandpass", q: 0.6, gain: 1 * att, reverb: 0.8 });
        this.tone({ freq: 140, freqEnd: 60, duration: 0.22, gain: 0.5 * att, type: "sine" });
      },
      att
    );
  }

  /**
   * Оглушение после светошумовой: мастер-громкость падает и медленно
   * возвращается. Звон в ушах — отдельный звук.
   */
  deafen(seconds: number, intensity: number): void {
    this.deafDuration = Math.max(this.deafDuration, seconds);
    this.deafTimer = Math.max(this.deafTimer, seconds);
    this.deafAmount = Math.max(this.deafAmount, clamp01(intensity));

    this.play(
      "flash-ring",
      () => {
        this.tone({
          freq: 4200,
          freqEnd: 3600,
          duration: Math.min(seconds, 3),
          gain: 0.05 * this.deafAmount,
          type: "sine",
          attack: 0.05,
        });
      },
      this.deafAmount
    );
    this.applyVolume();
  }

  // ---------------------------------------------------------- смена оружия

  weaponSwitch(): void {
    this.play("weapon-switch", () => {
      this.noise({ duration: 0.06, freq: 1200, freqEnd: 600, type: "bandpass", q: 2, gain: 0.12 });
    });
  }

  weaponDraw(): void {
    this.play("weapon-draw", () => {
      this.noise({ duration: 0.09, freq: 1800, freqEnd: 800, type: "bandpass", q: 2.2, gain: 0.16 });
    });
  }

  uiClick(): void {
    this.play("ui-click", () => {
      this.tone({ freq: 620, freqEnd: 520, duration: 0.05, gain: 0.09, type: "square" });
    });
  }
}
