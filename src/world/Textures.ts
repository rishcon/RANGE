import { DynamicTexture, Scene, Texture } from "@babylonjs/core";

type Ctx2D = CanvasRenderingContext2D;

/** Общая фабрика процедурных текстур — ассеты в репозитории не нужны. */
function makeTexture(
  name: string,
  size: number,
  scene: Scene,
  draw: (ctx: Ctx2D, size: number) => void,
  hasAlpha = false
): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as unknown as Ctx2D;
  draw(ctx, size);
  tex.hasAlpha = hasAlpha;
  tex.update(false);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Детерминированный "шум" пятнами — дешевле per-pixel и выглядит как зерно. */
function speckle(ctx: Ctx2D, size: number, count: number, radius: number, colors: string[]): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = radius * (0.35 + Math.random() * 0.9);
    ctx.fillStyle = colors[(Math.random() * colors.length) | 0]!;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * ВАЖНО: `DynamicTexture.clone()` в Babylon копирует только параметры, но НЕ
 * содержимое канваса — клон приходит пустым, и материал рендерится без текстуры.
 * Поэтому для тайлинга делаем настоящую копию пикселей.
 */
export function tiledCopy(src: DynamicTexture, scene: Scene, uScale: number, vScale: number): DynamicTexture {
  const size = src.getSize();
  const copy = new DynamicTexture(`${src.name}-x${uScale}`, { width: size.width, height: size.height }, scene, true);
  const ctx = copy.getContext() as unknown as Ctx2D;
  const srcCanvas = (src.getContext() as unknown as Ctx2D).canvas;
  ctx.drawImage(srcCanvas as unknown as CanvasImageSource, 0, 0);
  copy.hasAlpha = src.hasAlpha;
  copy.update(false);
  copy.wrapU = Texture.WRAP_ADDRESSMODE;
  copy.wrapV = Texture.WRAP_ADDRESSMODE;
  copy.uScale = uScale;
  copy.vScale = vScale;
  return copy;
}

export interface TextureLibrary {
  concrete: DynamicTexture;
  asphalt: DynamicTexture;
  dirt: DynamicTexture;
  metal: DynamicTexture;
  wood: DynamicTexture;
  sandbag: DynamicTexture;
  bulletHole: DynamicTexture;
  particle: DynamicTexture;
  flash: DynamicTexture;
  sky: DynamicTexture;
}

export function buildTextures(scene: Scene): TextureLibrary {
  const concrete = makeTexture("tex-concrete", 512, scene, (ctx, s) => {
    ctx.fillStyle = "#8d8a85";
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 2600, 3.2, ["#82807b", "#97948e", "#78766f", "#a09d96"]);
    // Разбивка на плиты.
    ctx.strokeStyle = "rgba(50,49,46,0.55)";
    ctx.lineWidth = 3;
    for (let i = 0; i <= 2; i++) {
      const p = (i * s) / 2;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, s);
      ctx.moveTo(0, p);
      ctx.lineTo(s, p);
      ctx.stroke();
    }
    // Трещины.
    ctx.strokeStyle = "rgba(60,58,55,0.35)";
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 26; i++) {
      ctx.beginPath();
      let x = Math.random() * s;
      let y = Math.random() * s;
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) {
        x += (Math.random() - 0.5) * 60;
        y += (Math.random() - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

  const asphalt = makeTexture("tex-asphalt", 512, scene, (ctx, s) => {
    ctx.fillStyle = "#3f4145";
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 4200, 2.6, ["#4a4d51", "#36383b", "#55585d", "#2e3033"]);
  });

  const dirt = makeTexture("tex-dirt", 512, scene, (ctx, s) => {
    ctx.fillStyle = "#8a7657";
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 3800, 3.4, ["#7d6a4d", "#977f5f", "#6f5f45", "#a08a68"]);
  });

  const metal = makeTexture("tex-metal", 512, scene, (ctx, s) => {
    ctx.fillStyle = "#6e737a";
    ctx.fillRect(0, 0, s, s);
    // Продольная шлифовка.
    for (let i = 0; i < 420; i++) {
      const y = Math.random() * s;
      ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
      ctx.lineWidth = Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s, y + (Math.random() - 0.5) * 6);
      ctx.stroke();
    }
    speckle(ctx, s, 400, 2.2, ["rgba(40,42,45,0.35)", "rgba(160,90,50,0.15)"]);
  });

  const wood = makeTexture("tex-wood", 512, scene, (ctx, s) => {
    ctx.fillStyle = "#9c7a4e";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      const y = (i / 90) * s;
      ctx.strokeStyle = `rgba(${90 + Math.random() * 50},${64 + Math.random() * 40},${34 + Math.random() * 26},0.5)`;
      ctx.lineWidth = 1 + Math.random() * 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= s; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 3);
      ctx.stroke();
    }
    // Стыки досок.
    ctx.strokeStyle = "rgba(50,36,20,0.65)";
    ctx.lineWidth = 3;
    for (let i = 1; i < 4; i++) {
      const y = (i * s) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s, y);
      ctx.stroke();
    }
  });

  const sandbag = makeTexture("tex-sandbag", 256, scene, (ctx, s) => {
    ctx.fillStyle = "#7d7355";
    ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, 1800, 2.4, ["#6e654a", "#8b8163", "#5f5741"]);
    ctx.strokeStyle = "rgba(60,55,40,0.5)";
    ctx.lineWidth = 2;
    for (let i = 0; i < s; i += 18) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, s);
      ctx.stroke();
    }
  });

  const bulletHole = makeTexture(
    "tex-bullet-hole",
    128,
    scene,
    (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      // Пылевой ореол.
      const halo = ctx.createRadialGradient(c, c, s * 0.1, c, c, s * 0.48);
      halo.addColorStop(0, "rgba(35,32,30,0.95)");
      halo.addColorStop(0.35, "rgba(60,56,52,0.5)");
      halo.addColorStop(1, "rgba(90,86,80,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(c, c, s * 0.48, 0, Math.PI * 2);
      ctx.fill();
      // Отверстие.
      ctx.fillStyle = "rgba(12,10,9,0.98)";
      ctx.beginPath();
      ctx.arc(c, c, s * 0.13, 0, Math.PI * 2);
      ctx.fill();
      // Сколы по краю.
      ctx.strokeStyle = "rgba(25,22,20,0.6)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 9; i++) {
        const a = Math.random() * Math.PI * 2;
        const len = s * (0.16 + Math.random() * 0.16);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * s * 0.12, c + Math.sin(a) * s * 0.12);
        ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
        ctx.stroke();
      }
    },
    true
  );

  const particle = makeTexture(
    "tex-particle",
    64,
    scene,
    (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      const g = ctx.createRadialGradient(c, c, 0, c, c, c);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.4, "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    },
    true
  );

  const flash = makeTexture(
    "tex-flash",
    128,
    scene,
    (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const c = s / 2;
      const g = ctx.createRadialGradient(c, c, 0, c, c, c * 0.45);
      g.addColorStop(0, "rgba(255,255,240,1)");
      g.addColorStop(0.5, "rgba(255,205,120,0.9)");
      g.addColorStop(1, "rgba(255,150,40,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);

      ctx.fillStyle = "rgba(255,232,180,0.95)";
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(c + Math.cos(a - 0.12) * c * 0.95, c + Math.sin(a - 0.12) * c * 0.95);
        ctx.lineTo(c + Math.cos(a + 0.12) * c * 0.95, c + Math.sin(a + 0.12) * c * 0.95);
        ctx.closePath();
        ctx.fill();
      }
    },
    true
  );

  const sky = makeTexture("tex-sky", 256, scene, (ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, "#20344c");
    g.addColorStop(0.42, "#5f7f9e");
    g.addColorStop(0.56, "#9db2c2");
    g.addColorStop(0.66, "#c3c3b6");
    g.addColorStop(1, "#6d6d63");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // Лёгкая облачность у горизонта.
    for (let i = 0; i < 60; i++) {
      const y = s * (0.3 + Math.random() * 0.22);
      ctx.fillStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.05})`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * s, y, 30 + Math.random() * 70, 4 + Math.random() * 9, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  return { concrete, asphalt, dirt, metal, wood, sandbag, bulletHole, particle, flash, sky };
}

/** Текстура таблички с дистанцией — рисуется отдельно для каждого значения. */
export function makeDistanceSign(scene: Scene, label: string): DynamicTexture {
  return makeTexture(`tex-sign-${label}`, 256, scene, (ctx, s) => {
    ctx.fillStyle = "#c9a227";
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = "#1c1c1c";
    ctx.fillRect(6, 6, s - 12, s - 12);
    ctx.fillStyle = "#f2e3a8";
    ctx.font = "bold 108px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, s / 2, s / 2 - 10);
    ctx.font = "500 40px 'Segoe UI', sans-serif";
    ctx.fillText("МЕТРОВ", s / 2, s / 2 + 62);
  });
}

/** Лицевая сторона бумажной мишени с зонами. */
export function makePaperTarget(scene: Scene): DynamicTexture {
  return makeTexture("tex-paper-target", 512, scene, (ctx, s) => {
    ctx.fillStyle = "#e8e4d8";
    ctx.fillRect(0, 0, s, s);
    const c = s / 2;
    const rings: Array<[number, string]> = [
      [0.46, "#d8d2c2"],
      [0.36, "#c6bfa9"],
      [0.26, "#3b3b3b"],
      [0.17, "#2a2a2a"],
      [0.09, "#c8302a"],
    ];
    for (const [r, color] of rings) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(c, c, s * r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, s - 20, s - 20);
  });
}
