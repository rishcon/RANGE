// Native Electron integration check against the production bundle.
// Run after npm run build: electron scripts/test-m4.cjs
const { app, BrowserWindow, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const project = path.resolve(__dirname, '..');
const dist = path.join(project, 'dist');
const output = path.join(project, '.test-output', 'arsenal-human');
app.setPath('userData', path.join(output, 'electron-profile'));
app.commandLine.appendSwitch('ignore-gpu-blocklist');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
const deadline = setTimeout(() => { console.error('M4 test timed out'); app.exit(1); }, 120000);

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
    window.g = window.game; g.engine.stopRenderLoop(); g.input.requestLock = () => {};
    g.startNewSession();
    window.tick = seconds => {
      for (let i = 0; i < Math.ceil(seconds * 60); i++) {
        g.engine.beginFrame(); g.updateGameplay(1 / 60); g.scene.render(); g.engine.endFrame();
      }
    };
    window.check = (value, label) => { if (!value) throw new Error(label); };
    window.V = g.player.position.constructor;
    tick(0.5); g.input.pressed.add('Digit1'); tick(0.7);
    window.sniper = g.inventory.current;
    check(sniper.config.id === 'sniper', 'Sniper equip failed');
    check(sniper.viewModel.model.meshes.length === 7, 'Sniper GLB parts missing');
    check(sniper.viewModel.model.meshes.every(m => m.material.albedoTexture?.isReady()), 'Sniper textures missing');
    check(!sniper.viewModel.model.magazine.isPickable, 'Sniper magazine affects raycasts');
    const mag = sniper.viewModel.model.magazine;
    check(mag.position.length() < 0.3 && mag.getBoundingInfo().boundingBox.extendSize.length() < 0.15,
      'Sniper magazine pivot/bounds are not local to the weapon');
    window.boltCycles = 0;
    const cycle = g.audio.boltPull.bind(g.audio);
    g.audio.boltPull = () => { boltCycles++; cycle(); };
    void 0;
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

  await screenshot('sniper-hip');
  await run(`
    g.input.mousePressed.add(2); tick(0.7);
    check(sniper.aimProgress === 1 && sniper.usesScope, 'Sniper scope failed');
    check(sniper.viewModel.model.meshes.every(m => !m.isVisible), 'Scoped weapon did not hide');
  `);
  await screenshot('sniper-ads');
  await run(`
    g.input.mousePressed.add(2); tick(0.7);
    g.input.mouseHeld.add(0); tick(0.1); g.input.mouseHeld.delete(0);
    check(sniper.mag === 4, 'Sniper shot failed');
    tick(1.6); check(boltCycles > 0, 'Sniper bolt did not cycle');
    g.input.pressed.add('KeyR'); tick(0.8);
    check(!sniper.viewModel.model.magazine.isVisible, 'Sniper magazine did not detach');
  `);
  await screenshot('sniper-reload');
  await run(`
    tick(4); check(sniper.mag === 5 && !sniper.isReloading, 'Sniper reload failed');
    g.input.pressed.add('Digit3'); tick(0.7);
    window.knife = g.inventory.current;
    check(knife.viewModel.model.meshes.length === 1 && knife.viewModel.model.meshes[0].name.includes('M9'), 'M9 not loaded');
    check(knife.viewModel.model.meshes[0].material.albedoTexture.isReady(), 'M9 texture missing');
  `);
  await screenshot('m9-hip');
  await run(`
    window.shotsBeforeKnife = g.stats.shots;
    g.input.mouseHeld.add(0); tick(0.25); g.input.mouseHeld.delete(0);
    check(knife.viewModel.actionKeys, 'Knife light animation missing');
  `);
  await screenshot('m9-slash');
  await run(`
    tick(0.8); check(g.stats.shots > shotsBeforeKnife, 'Knife light hit did not resolve');
    window.shotsBeforeHeavy = g.stats.shots;
    g.input.mouseHeld.add(2); tick(0.35); g.input.mouseHeld.delete(2);
    check(knife.viewModel.actionKeys, 'Knife heavy animation missing');
    tick(1.1); check(g.stats.shots > shotsBeforeHeavy, 'Knife heavy hit did not resolve');
    g.player.pitch = 1.25; tick(0.5);
    check(g.playerBody.meshes.every(m => !m.isPickable), 'Player body affects raycasts');
    check(g.playerBody.character.firstPersonHidden.every(m => !m.isVisible), 'Face or body arms visible in first person');
  `);
  await screenshot('player-body');
  await run(`
    g.input.held.add('ControlLeft'); tick(0.8);
  `);
  await screenshot('player-crouch');
  await run(`
    knife.viewModel.root.setEnabled(false);
    window.actor = g.enemies.all[0].character;
    actor.reset(); actor.root.position.set(0, 0, 5); actor.root.rotation.y = Math.PI;
    window.neutral = {speed:0,crouch:0,grounded:true,verticalVelocity:0,lookPitch:0,lean:0,death:0};
    actor.update(1/60, neutral);
    g.player.camera.position.set(0, 1.05, 2.3);
    g.player.camera.setTarget(new V(0, 1.02, 5));
    check(actor.meshes.every(m => m.metadata.hittable === g.enemies.all[0]), 'Character hit owners missing');
    check(actor.meshes.some(m => m.metadata.zone === 'head'), 'Head hit zone missing');
    check(actor.meshes.length < 65, 'Too many character draw calls');
    const torso = actor.meshes.find(m => m.name === 'torso');
    check(torso.getVerticesData('normal')[0] > 0, 'Body surface normals point inward');
    for (const side of [0, 1]) {
      const localGrip = side === 1 ? new V(0,-0.055,0.013) : new V(-0.015,-0.008,0.28);
      const gripWorld = V.TransformCoordinates(localGrip, actor.weaponHolder.computeWorldMatrix(true));
      actor.handMesh[side].computeWorldMatrix(true);
      check(V.Distance(gripWorld, actor.handMesh[side].getAbsolutePosition()) < 0.025,
        'Bot palm does not meet weapon grip');
    }
  `);
  await screenshot('human-front');
  await run(`
    actor.root.rotation.y = Math.PI * 0.65;
    actor.update(1/60, neutral);
  `);
  await screenshot('human-three-quarter');
  await run(`
    for(let i=0;i<60;i++) actor.update(1/60, {...neutral,crouch:1});
  `);
  await screenshot('human-crouch');
  await run(`
    actor.startRagdoll(new V(0,0,0), new V(0,1,2), actor.root.position.add(new V(0,1.2,0)));
    for(let i=0;i<120;i++) actor.update(1/60,neutral);
    check(actor.isRagdollActive, 'Human ragdoll failed');
    check(actor.meshes.every(m => m.getAbsolutePosition().asArray().every(Number.isFinite)), 'Invalid ragdoll transform');
  `);
  await screenshot('human-ragdoll');
  await run(`
    actor.reset(); actor.update(1/60,neutral);
    check(!actor.isRagdollActive, 'Human respawn failed');
  `);
  const result = await run(`({characterMeshes:actor.meshes.length, sniperParts:sniper.viewModel.model.meshes.length, passed:true})`);
  console.log(JSON.stringify({ ...result, errors }));
  if (errors.length) throw new Error(errors.join('\n'));
  clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
