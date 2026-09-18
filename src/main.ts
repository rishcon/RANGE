import { Game } from "./core/Game";

const canvas = document.getElementById("render-canvas") as HTMLCanvasElement | null;

if (!canvas) {
  throw new Error("Не найден canvas #render-canvas");
}

const loading = document.createElement("div");
loading.style.cssText =
  "position:fixed;inset:0;display:grid;place-items:center;background:#101419;" +
  "color:#e4e6e8;font:16px 'Segoe UI',sans-serif;z-index:100";
loading.textContent = "Загрузка оружия…";
document.body.appendChild(loading);

async function start(renderCanvas: HTMLCanvasElement): Promise<void> {
  try {
    const game = await Game.create(renderCanvas);
    game.run();
    // Удобно для отладки из консоли DevTools.
    (window as unknown as { game: Game }).game = game;
  } catch (error) {
    console.error("Не удалось запустить игру:", error);
    const message = document.createElement("div");
    message.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "color:#ff6b4a;font:14px 'Segoe UI',sans-serif;text-align:center;padding:40px;z-index:99";
    message.textContent = `Ошибка запуска: ${error instanceof Error ? error.message : String(error)}`;
    document.body.appendChild(message);
  } finally {
    loading.remove();
  }
}

void start(canvas);
