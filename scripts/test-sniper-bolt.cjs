// Native Electron integration check against the production bundle.
// Run after npm run build: electron scripts/test-m4.cjs
const { app, BrowserWindow, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const project = path.resolve(__dirname, '..');
const dist = path.join(project, 'dist');
const output = path.join(project, '.test-output', 'sniper-bolt');
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
        g.engine.beginFrame(); g.updateGameplay(1/60); g.scene.render(); g.engine.endFrame();
      }
    };
    window.check = (value, label) => { if (!value) throw new Error(label); };
    tick(0.5); g.input.pressed.add('Digit1'); tick(0.7);
    window.sniper = g.inventory.current; window.vm = sniper.viewModel;
    window.bolt = vm.model.bolt; window.rest = bolt.position.z;
    window.ejections = 0; window.pulls = 0; window.closes = 0;
    const eject = g.effects.ejectShell.bind(g.effects);
    g.effects.ejectShell = (...args) => { ejections++; eject(...args); };
    const pull = g.audio.boltPull.bind(g.audio), close = g.audio.boltRelease.bind(g.audio);
    g.audio.boltPull = () => { pulls++; pull(); };
    g.audio.boltRelease = () => { closes++; close(); };
    g.input.mousePressed.add(2); tick(0.6);
    check(sniper.aimProgress === 1 && vm.isHiddenByScope, 'Initial scope failed');
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


  await screenshot('01-aim');
  await run(`
    g.input.mouseHeld.add(0); tick(1/60); g.input.mouseHeld.delete(0);
    check(sniper.mag === 4 && sniper.cycleTimer > 0, 'Shot did not start bolt cycle');
    check(Math.abs(bolt.position.z-rest) < 0.00001, 'Manual bolt opened automatically at firing');
    tick(0.4);
    check(sniper.aimProgress === 0 && !vm.isHiddenByScope, 'Scope did not lower for the hand');
    check(sniper.isAimingToggled, 'ADS return intent was lost');
    check(vm.rightArm.position.length() > 0.06, 'Right hand did not leave the grip');
    check(vm.leftArm.position.length() < 0.001, 'Support hand left the rifle');
    check(ejections === 0, 'Shell ejected before bolt pull');
  `);
  await screenshot('02-hand-reaches');
  await run(`
    tick(0.3);
    check(bolt.position.z < rest - 0.065 && bolt.rotation.z > 0.9, 'Bolt did not lift and pull back');
    check(ejections === 1 && pulls === 1, 'Shell/pull audio not synchronized');
    const V = g.player.position.constructor;
    const palm = new V(0.006,-0.01,0.026);
    const handNode = vm.rightArm.getChildren().find(n => n.name === 'vm-right-hand');
    const palmWorld = V.TransformCoordinates(palm, handNode.computeWorldMatrix(true));
    const handleWorld = V.TransformCoordinates(vm.model.manualBolt.handle, bolt.computeWorldMatrix(true));
    check(V.Distance(palmWorld,handleWorld) < 0.003, 'Hand detached from moving bolt handle');
    g.input.mouseHeld.add(0); tick(1/60); g.input.mouseHeld.delete(0);
    check(sniper.mag === 4, 'Can fire with bolt open');
  `);
  await screenshot('03-bolt-back');
  await run(`
    tick(0.37);
    check(Math.abs(bolt.position.z-rest) < 0.00001 && Math.abs(bolt.rotation.z) < 0.00001, 'Bolt did not lock');
    check(closes === 1, 'Closing sound missing');
  `);
  await screenshot('04-bolt-closed');
  await run(`
    tick(0.6);
    check(sniper.aimProgress === 1 && vm.isHiddenByScope, 'Did not automatically return to scope');
    check(vm.rightArm.position.length() < 0.00001 && vm.rightArm.rotation.length() < 0.00001, 'Hand did not return to grip');
    check(ejections === 1 && pulls === 1 && closes === 1, 'Duplicate cycle events');
  `);
  await screenshot('05-aim-restored');
  await run(`
    // User cancels ADS during a scoped shot cycle.
    g.input.mouseHeld.add(0); tick(1/60); g.input.mouseHeld.delete(0); tick(0.3);
    g.input.mousePressed.add(2); tick(1.5);
    check(!sniper.isAimingToggled && sniper.aimProgress === 0, 'RMB did not cancel return');
    // A hip shot must never enable the scope by itself.
    g.input.mouseHeld.add(0); tick(1/60); g.input.mouseHeld.delete(0); tick(1.6);
    check(sniper.aimProgress === 0, 'Hip shot unexpectedly enabled scope');
    // Reload can interrupt an open bolt without leaving the hand displaced.
    g.input.mouseHeld.add(0); tick(1/60); g.input.mouseHeld.delete(0); tick(0.65);
    g.input.pressed.add('KeyR'); tick(0.1);
    check(sniper.isReloading && vm.rightArm.position.length() < 0.001, 'Reload interruption left hand displaced');
    tick(4.8); check(sniper.mag === 5 && !sniper.isReloading && sniper.cycleTimer === 0, 'Reload/chamber failed');
    check(sniper.aimProgress === 0, 'Reload restored cancelled scope intent');
    // Switching cancels the cycle and its future scope return.
    g.input.mousePressed.add(2); tick(0.5);
    g.input.mouseHeld.add(0); tick(1/60); g.input.mouseHeld.delete(0); tick(0.55);
    g.input.pressed.add('Digit2'); tick(0.7);
    check(g.inventory.current.config.id === 'pistol', 'Cannot switch during bolt animation');
    check(vm.rightArm.position.length() < 0.001 && sniper.cycleTimer === 0, 'Holster did not clear cycle');
    g.input.pressed.add('Digit1'); tick(0.7);
    check(g.inventory.current === sniper && sniper.aimProgress === 0, 'Re-equip unexpectedly restored scope');
    g.startNewSession(); tick(0.5);
    check(sniper.cycleTimer === 0 && !sniper.isAimingToggled, 'Session reset kept cycle state');
  `);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({passed:true,errors}));
  clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
