// Native Electron integration check against the production bundle.
// Run after npm run build: electron scripts/test-m4.cjs
const { app, BrowserWindow, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const project = path.resolve(__dirname, '..');
const dist = path.join(project, 'dist');
const output = path.join(project, '.test-output', 'm4');
app.setPath('userData', path.join(output, 'electron-profile'));
app.commandLine.appendSwitch('ignore-gpu-blocklist');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
const deadline = setTimeout(() => { console.error('M4 test timed out'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  protocol.handle('app', request => {
    const relative = decodeURIComponent(new URL(request.url).pathname);
    const file = path.resolve(dist, `.${relative}`);
    if (!file.startsWith(dist + path.sep)) return new Response('Forbidden', { status: 403 });
    // Audio intentionally probes optional ogg/wav/mp3 files before synthesis.
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  const win = new BrowserWindow({ width: 1280, height: 720, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  const errors = [];
  win.webContents.on('console-message', details => {
    if (details.level === 'error') errors.push(details.message);
  });
  const run = code => win.webContents.executeJavaScript(code);
  await win.loadURL('app://range/index.html');
  await run(`new Promise((resolve, reject) => {
    const until = performance.now() + 30000;
    const check = () => window.game ? resolve() : performance.now() > until
      ? reject(new Error('Game did not initialize')) : setTimeout(check, 50);
    check();
  })`);
  await run(`
    window.g = window.game;
    g.engine.stopRenderLoop();
    g.input.requestLock = () => {};
    g.startNewSession();
    window.rifle = g.inventory.current;
    window.tick = (seconds) => {
      for (let i = 0; i < Math.ceil(seconds * 60); i++) {
        g.engine.beginFrame();
        g.updateGameplay(1 / 60);
        g.scene.render();
        g.engine.endFrame();
      }
    };
    window.check = (condition, message) => { if (!condition) throw new Error(message); };
    tick(0.5);
    check(rifle.displayName === 'M4', 'M4 not equipped');
    check(rifle.viewModel.model.meshes.length === 8, 'Missing GLB parts or optical glass');
    const receiverSize = rifle.viewModel.model.meshes[0].getBoundingInfo().boundingBox.extendSize.scale(2);
    check(receiverSize.z > 0.8 && receiverSize.z < 0.9 && receiverSize.y < 0.3,
      'Imported rifle bounds/orientation are incorrect');
    const V = g.player.position.constructor;
    const boreDirection = rifle.viewModel.model.body.getDirection(new V(0, 0, 1)).normalize();
    check(V.Dot(boreDirection, g.player.camera.getForwardRay().direction) > 0.999,
      'M4 barrel is tilted away from the camera direction at rest');
    const M = g.player.camera.getWorldMatrix().constructor;
    const viewport = g.player.camera.viewport.toGlobal(g.engine.getRenderWidth(), g.engine.getRenderHeight());
    const muzzleScreen = V.Project(rifle.viewModel.model.muzzle.getAbsolutePosition(),
      M.Identity(), g.scene.getTransformMatrix(), viewport);
    check(muzzleScreen.x / viewport.width > 0.58 && muzzleScreen.x / viewport.width < 0.68
      && muzzleScreen.y / viewport.height > 0.53 && muzzleScreen.y / viewport.height < 0.67,
      'M4 hip pose no longer matches the lower-right reference framing');
    const centerHit = g.scene.pickWithRay(g.player.camera.getForwardRay(3),
      mesh => rifle.viewModel.allMeshes.includes(mesh) && mesh.material.alpha === 1);
    check(!centerHit?.hit, 'Weapon or hands obstruct the hip crosshair');
    check(g.scene.getMeshByName('vm-left-glove-cuff') && g.scene.getMeshByName('vm-r-trigger-finger'),
      'Tactical glove geometry missing');
    for (const mesh of rifle.viewModel.model.meshes) {
      check(mesh.isEnabled() && mesh.isVisible, 'Hidden imported part: ' + mesh.name);
      check(!mesh.isPickable && !mesh.checkCollisions && mesh.renderingGroupId === 1,
        'GLB interferes with gameplay picking: ' + mesh.name);
      if (mesh.name !== 'vm-m4-optic-glass') {
        check(mesh.material?.albedoTexture?.isReady(), 'Missing color texture: ' + mesh.name);
        check(mesh.material?.bumpTexture?.isReady(), 'Missing normal texture: ' + mesh.name);
      }
    }
  `);
  const screenshot = async name => {
    await run(`g.scene.whenReadyAsync().then(() => new Promise(resolve => {
      let frames = 0;
      const render = () => {
        g.engine.beginFrame(); g.scene.render(); g.engine.endFrame();
        if (++frames < 4) requestAnimationFrame(render); else resolve();
      };
      requestAnimationFrame(render);
    }))`);
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(output, `${name}.png`), shot.toPNG());
  };
  await screenshot('hip');
  const geometry = await run(`(() => {
    const m = rifle.viewModel.model;
    return m.meshes.map(mesh => ({ name: mesh.name, position: mesh.position.asArray(),
      size: mesh.getBoundingInfo().boundingBox.extendSize.scale(2).asArray() }));
  })()`);
  await run(`
    window.hipFov = g.player.camera.fov;
    g.input.mousePressed.add(2); tick(0.6);
    check(rifle.aimProgress === 1 && g.player.camera.fov < hipFov, 'ADS failed');
    check(document.getElementById('reddot').classList.contains('on'), 'Missing reticle');
  `);
  await screenshot('ads');
  const optic = await run(`(() => {
    const ray = g.player.camera.getForwardRay(3);
    const hit = g.scene.pickWithRay(ray, mesh => rifle.viewModel.allMeshes.includes(mesh) && mesh.material.alpha === 1);
    check(!hit?.hit, 'Opaque geometry blocks the M4 reticle');
    return { blocked: hit?.hit, mesh: hit?.pickedMesh?.name, point: hit?.pickedPoint?.asArray() };
  })()`);
  console.log('Optic clearance:', JSON.stringify(optic));
  await run(`
    g.input.pressed.add('Digit2'); tick(0.7);
    window.pistol = g.inventory.current;
    check(pistol.displayName === 'G18', 'G18 not equipped');
    check(pistol.viewModel.model.meshes.length === 3, 'G18 parts missing');
    for (const mesh of pistol.viewModel.model.meshes) {
      check(mesh.isVisible && mesh.isEnabled(), 'Hidden G18 part: ' + mesh.name);
      check(!mesh.isPickable && !mesh.checkCollisions && mesh.renderingGroupId === 1,
        'G18 interferes with gameplay picking');
      check(mesh.material.albedoTexture.isReady(), 'G18 texture missing');
    }
    const magBounds = pistol.viewModel.model.magazine.getBoundingInfo().boundingBox;
    check(magBounds.extendSize.y < 0.07, 'Magazine includes unrelated geometry');
  `);
  await screenshot('g18-hip');
  await run(`g.input.mousePressed.add(2); tick(0.6); check(pistol.aimProgress === 1, 'G18 ADS failed');`);
  await screenshot('g18-ads');
  await run(`
    g.input.pressed.add('Digit1'); tick(0.7);
    g.input.mousePressed.add(2); tick(0.6);
  `);
  if (process.argv.includes('--visual')) {
    clearTimeout(deadline);
    win.destroy();
    app.exit(0);
    return;
  }
  await run(`
    window.boltRest = rifle.viewModel.model.bolt.position.z;
    g.input.mouseHeld.add(0); tick(1 / 60);
    check(rifle.mag === 29 && g.stats.shots === 1, 'Single shot failed');
    check(rifle.viewModel.model.bolt.position.z < boltRest, 'GLB bolt does not cycle');
    check(rifle.viewModel.flashPlane.isVisible, 'Muzzle flash missing');
    tick(0.4); g.input.mouseHeld.delete(0); tick(0.1);
    check(rifle.mag < 29 && g.stats.shots > 1, 'Automatic fire failed');
    window.beforeReload = rifle.mag;
    g.input.pressed.add('KeyR'); tick(0.55);
    check(!rifle.viewModel.model.magazine.isVisible, 'Original magazine did not detach');
    check(rifle.viewModel.fallingMags.length > 0, 'Dropped magazine missing');
    const dropped = rifle.viewModel.fallingMags.at(-1).mesh;
    check(dropped.geometry === rifle.viewModel.model.magazine.geometry,
      'Dropped magazine is not from the GLB');
    check(dropped.renderingGroupId === 0 && dropped.parent === null, 'Dropped magazine is not in world space');
  `);
  await screenshot('reload');
  await run(`
    tick(2);
    check(rifle.mag === 30 && rifle.reserveAmmo === 150 - (30 - beforeReload), 'Tactical reload ammo failed');
    check(rifle.viewModel.model.magazine.isVisible, 'Magazine did not return');
    g.input.mouseHeld.add(0); tick(3.5); g.input.mouseHeld.delete(0); tick(0.1);
    check(rifle.mag === 0, 'Cannot empty the magazine');
    window.handleRest = rifle.viewModel.model.chargingHandle.position.z;
    g.input.pressed.add('KeyR'); tick(2.25);
    check(rifle.viewModel.model.chargingHandle.position.z < handleRest - 0.005,
      'Charging handle does not animate during empty reload');
    tick(0.8);
    check(rifle.mag === 30 && !rifle.isReloading, 'Empty reload failed');
    check(Math.abs(rifle.viewModel.model.chargingHandle.position.z - handleRest) < 0.00001,
      'Charging handle did not reset');
    g.input.pressed.add('Digit2'); tick(0.7);
    check(g.inventory.current.config.id === 'pistol' && !rifle.viewModel.root.isEnabled(), 'Holster failed');
    g.input.pressed.add('Digit1'); tick(0.7);
    check(g.inventory.current === rifle && rifle.viewModel.root.isEnabled(), 'Re-equip M4 failed');
    g.input.pressed.add('Digit1'); tick(0.7);
    check(g.inventory.current.config.id === 'sniper', 'Primary cycling failed');
    g.input.pressed.add('Digit1'); tick(0.7);
    check(g.inventory.current === rifle, 'Return from sniper failed');
    g.input.pressed.add('Digit2'); tick(0.7);
    window.pistolBoltRest = pistol.viewModel.model.bolt.position.z;
    g.input.mouseHeld.add(0); tick(1 / 60);
    check(pistol.mag === 11, 'G18 shot failed');
    check(pistol.viewModel.model.bolt.position.z < pistolBoltRest, 'G18 slide does not cycle');
    tick(0.3);
    check(pistol.mag === 11, 'Pistol fire mode changed');
    g.input.mouseHeld.delete(0); tick(0.1);
    g.input.mouseHeld.add(0); tick(1 / 60);
    check(pistol.mag === 10, 'G18 follow-up shot failed');
    g.input.mouseHeld.delete(0); tick(0.1);
    g.input.pressed.add('KeyR'); tick(0.55);
    check(!pistol.viewModel.model.magazine.isVisible, 'G18 magazine did not detach');
    check(pistol.viewModel.fallingMags.length > 0, 'G18 dropped magazine missing');
    tick(2);
    check(pistol.mag === 12 && !pistol.isReloading, 'G18 reload failed');
    check(pistol.viewModel.model.magazine.isVisible, 'G18 magazine did not return');
    g.startDuel(); tick(3.2);
    check(g.inventory.current === rifle && rifle.viewModel.root.isEnabled(), 'M4 missing in duel');
  `);
  const result = { geometry, optic, errors, passed: true };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) throw new Error('Renderer errors: ' + errors.join('\n'));
  clearTimeout(deadline);
  win.destroy();
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
