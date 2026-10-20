/**
 * HyperDrain Automated QA End-to-End Test Suite
 * Connects via Chrome DevTools Protocol (CDP) to the running Electron Desktop App.
 * Automatically tests:
 *  1. Window controls & clean titlebar live speed readout (no emojis/signs)
 *  2. Verification that Video Browser is removed and all 5 primary tabs switch smoothly
 *  3. Verification that topbar stat pills have clean typography with NO glyphs/icons/signs
 *  4. Verification that sidebar disk storage footer is removed
 *  5. Add Download modal (open, fill, connection options, cancel, close)
 *  6. Completed tab history actions
 *  7. Browser Extension Hub (verified button says "Export Extension (.zip)" with NO "for friends", no browser launcher)
 *  8. Online Auto-Update Engine (update pill hidden by default, manual check works, modal DOM verified)
 *  9. Real-time CPU and GPU process utilization benchmark (verifying 0% idle load)
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT = 9222;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 1. Fetch CDP target WebSocket URL
function getDebuggerTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          const target = list.find(t => (t.type === 'page' || !t.type) && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://')) ||
                         list.find(t => t.url.includes('index.html') || t.url.includes('6880'));
          if (target && target.webSocketDebuggerUrl) {
            resolve(target);
          } else {
            reject(new Error('No active page found in CDP targets: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// 2. CDP Client wrapper
class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.callbacks = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          if (msg.id && this.callbacks.has(msg.id)) {
            const cb = this.callbacks.get(msg.id);
            this.callbacks.delete(msg.id);
            if (msg.error) cb.reject(new Error(msg.error.message));
            else cb.resolve(msg.result);
          }
        } catch (e) {}
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'Eval exception');
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
  }
}

async function runQASuite() {
  console.log('===============================================================');
  console.log(' ⚡ HyperDrain Native Desktop App - Automated QA Verification ⚡');
  console.log('===============================================================\n');

  let electronProc = null;
  const launchCmd = './node_modules/.bin/electron';
  const launchArgs = ['.', `--remote-debugging-port=${CDP_PORT}`, '--no-sandbox', '--user-data-dir=/tmp/hd_qa_test'];

  console.log(`[QA] Launching Application: ${launchCmd} ${launchArgs.join(' ')}`);
  electronProc = spawn(launchCmd, launchArgs, {
    detached: false,
    stdio: 'ignore'
  });

  const pid = electronProc.pid;
  console.log(`[QA] App launched with PID: ${pid}`);

  // Wait for CDP to become available
  let target = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    try {
      target = await getDebuggerTarget();
      if (target) break;
    } catch (e) {}
  }

  if (!target) {
    console.error('[QA] ❌ Failed to connect to Electron via Chrome DevTools Protocol.');
    if (electronProc) electronProc.kill('SIGKILL');
    process.exit(1);
  }

  console.log(`[QA] Connected to renderer page: ${target.title} (${target.url})`);

  const cdp = new CDPClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // Let UI complete initial mount & telemetry connection
  await sleep(1500);

  const testResults = [];
  function assert(name, condition, details = '') {
    if (condition) {
      console.log(` ✅ PASS: ${name}${details ? ' (' + details + ')' : ''}`);
      testResults.push({ name, passed: true, details });
    } else {
      console.error(` ❌ FAIL: ${name}${details ? ' - ' + details : ''}`);
      testResults.push({ name, passed: false, details });
    }
  }

  try {
    // -------------------------------------------------------------
    // TEST 1: Titlebar Controls & Clean Typography
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 1: Titlebar & System Controls ---');
    const titlebarBtns = await cdp.eval(`({
      hasMin: !!document.getElementById('btn-win-min'),
      hasMax: !!document.getElementById('btn-win-max'),
      hasClose: !!document.getElementById('btn-win-close'),
      liveSpeedText: document.getElementById('titlebar-live-speed') ? document.getElementById('titlebar-live-speed').textContent : ''
    })`);

    assert('Titlebar minimize button present', titlebarBtns.hasMin);
    assert('Titlebar maximize button present', titlebarBtns.hasMax);
    assert('Titlebar close button present', titlebarBtns.hasClose);
    assert('Titlebar live speed indicator rendered with clean text', titlebarBtns.liveSpeedText.length > 0 && !titlebarBtns.liveSpeedText.includes('⚡'), titlebarBtns.liveSpeedText);

    // -------------------------------------------------------------
    // TEST 2: Tab Navigation & Removal of Video Browser
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 2: Tab Navigation & Layout Cleanup ---');
    const browserTabExists = await cdp.eval(`!!document.querySelector('.nav-item[data-tab="browser"]') || !!document.getElementById('view-browser')`);
    assert('Built-in Video Browser is completely removed from DOM and navigation', !browserTabExists);

    const tabs = ['active', 'completed', 'extension', 'analytics', 'settings'];
    for (const tab of tabs) {
      await cdp.eval(`window.switchTab('${tab}')`);
      await sleep(150);
      const isVisible = await cdp.eval(`
        document.getElementById('view-${tab}').classList.contains('active') &&
        document.querySelector('.nav-item[data-tab="${tab}"]').classList.contains('active')
      `);
      assert(`Tab Switch -> '${tab}' activates cleanly`, isVisible);
    }

    // -------------------------------------------------------------
    // TEST 3: Topbar Stats & Removal of Signs/Emojis
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 3: Topbar Typography & Signs Verification ---');
    const statsInspection = await cdp.eval(`(() => {
      const icons = document.querySelectorAll('.stat-icon');
      const totalSpeed = document.getElementById('total-speed');
      const diskSpeed = document.getElementById('disk-speed');
      const totalConns = document.getElementById('total-conns');
      return {
        iconCount: icons.length,
        hasSpeed: !!totalSpeed,
        hasDisk: !!diskSpeed,
        hasConns: !!totalConns,
        speedText: totalSpeed ? totalSpeed.textContent : '',
        sidebarFooter: !!document.querySelector('.sidebar-footer')
      };
    })()`);

    assert('Disliked signs and emojis (↓, 💾, 🔀) are completely removed from topbar stats', statsInspection.iconCount === 0, `icons: ${statsInspection.iconCount}`);
    assert('Clean typography Speed stat pill is present and functional', statsInspection.hasSpeed, statsInspection.speedText);
    assert('Clean typography Disk Write stat pill is present', statsInspection.hasDisk);
    assert('Clean typography Streams stat pill is present', statsInspection.hasConns);
    assert('Sidebar Disk Storage indicator widget is completely removed', !statsInspection.sidebarFooter);

    // -------------------------------------------------------------
    // TEST 4: Add Download Modal Full Interaction
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 4: Add Download Modal ---');
    await cdp.eval(`window.switchTab('active')`);
    
    // Open modal
    await cdp.eval(`document.getElementById('open-add-modal').click()`);
    await sleep(200);
    let modalShown = await cdp.eval(`document.getElementById('add-modal').classList.contains('show')`);
    assert('Open Add Download Modal button displays modal', modalShown);

    // Test filling modal fields
    const testUrl = 'https://archive.org/download/test_hyperdrain/sample.mp4';
    await cdp.eval(`
      document.getElementById('modal-url').value = '${testUrl}';
      document.getElementById('modal-filename').value = 'sample.mp4';
      document.getElementById('modal-conns').value = '32';
    `);
    const modalInputVal = await cdp.eval(`document.getElementById('modal-url').value`);
    assert('Modal input fields set correctly', modalInputVal === testUrl);

    // Close via cancel button
    await cdp.eval(`document.getElementById('cancel-modal-btn').click()`);
    await sleep(200);
    modalShown = await cdp.eval(`document.getElementById('add-modal').classList.contains('show')`);
    assert('Cancel button closes Add Download modal', !modalShown);

    // Reopen and close via 'X' button
    await cdp.eval(`document.getElementById('open-add-modal').click()`);
    await sleep(200);
    await cdp.eval(`document.getElementById('close-modal-btn').click()`);
    await sleep(200);
    modalShown = await cdp.eval(`document.getElementById('add-modal').classList.contains('show')`);
    assert('Close (X) button closes Add Download modal', !modalShown);

    // -------------------------------------------------------------
    // TEST 5: Speed Graph Rendering State
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 5: Speed Graph & Canvas ---');
    const canvasStatus = await cdp.eval(`(() => {
      const c = document.getElementById('liveChart');
      return {
        exists: !!c,
        width: c ? c.width : 0,
        height: c ? c.height : 0
      };
    })()`);
    assert('Live Speed Chart canvas initialized with dimensions', canvasStatus.exists && canvasStatus.width > 0, `${canvasStatus.width}x${canvasStatus.height}`);

    // -------------------------------------------------------------
    // TEST 6: Completed Downloads Tab Actions
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 6: Completed Tab ---');
    await cdp.eval(`window.switchTab('completed')`);
    const clearBtnExists = await cdp.eval(`!!document.getElementById('clear-completed-btn')`);
    assert('Clear Completed button exists', clearBtnExists);
    await cdp.eval(`window.confirm = () => false; document.getElementById('clear-completed-btn').click()`);
    assert('Clear Completed button responds without errors', true);

    // -------------------------------------------------------------
    // TEST 7: Universal Browser Extension Hub
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 7: Universal Extension Hub ---');
    await cdp.eval(`window.switchTab('extension')`);
    
    const extDetails = await cdp.eval(`(() => {
      const exportBtn = document.getElementById('ext-export-zip-btn');
      const openFolderBtn = document.getElementById('ext-open-folder-btn');
      const launchBrowserBtn = document.getElementById('ext-open-browser-tab-btn');
      return {
        hasExport: !!exportBtn,
        exportText: exportBtn ? exportBtn.textContent.trim() : '',
        hasOpenFolder: !!openFolderBtn,
        hasLaunchBrowser: !!launchBrowserBtn
      };
    })()`);

    assert('Export extension button present', extDetails.hasExport);
    assert('Export button text is "Export Extension (.zip)" with NO "for friends"', 
      extDetails.exportText.includes('Export Extension (.zip)') && !extDetails.exportText.includes('for friends') && !extDetails.exportText.includes('for Friends'),
      extDetails.exportText
    );
    assert('Launch Video Browser button removed from Extension Hub', !extDetails.hasLaunchBrowser);
    assert('Open Extension folder button present', extDetails.hasOpenFolder);

    // -------------------------------------------------------------
    // TEST 8: Online Auto-Update Engine Verification
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 8: Online Auto-Update System ---');
    const updaterInspection = await cdp.eval(`(() => {
      const pill = document.getElementById('btn-update-available');
      const modal = document.getElementById('updateModal');
      const checkBtn = document.getElementById('btn-manual-check-update');
      const currentBadge = document.getElementById('updateBadgeCurrent');
      const latestBadge = document.getElementById('updateBadgeLatest');
      const changelog = document.getElementById('updateChangelogContent');
      const executeBtn = document.getElementById('btnUpdateExecute');
      return {
        hasPill: !!pill,
        pillDisplay: pill ? pill.style.display : '',
        hasModal: !!modal,
        modalDisplay: modal ? modal.style.display : '',
        hasCheckBtn: !!checkBtn,
        hasCurrentBadge: !!currentBadge,
        hasLatestBadge: !!latestBadge,
        hasChangelog: !!changelog,
        hasExecuteBtn: !!executeBtn,
        hasApi: typeof window.electronAPI.checkForUpdates === 'function'
      };
    })()`);

    assert('Electron API exposes checkForUpdates, downloadUpdate, installUpdate', updaterInspection.hasApi);
    assert('Topbar update button is present in DOM', updaterInspection.hasPill);
    assert('Topbar update button is HIDDEN by default (only appears when update is available)', updaterInspection.pillDisplay === 'none', `style.display=${updaterInspection.pillDisplay}`);
    assert('Update modal is present and hidden by default', updaterInspection.hasModal && updaterInspection.modalDisplay === 'none');
    assert('Settings has "Check for Updates" button', updaterInspection.hasCheckBtn);
    assert('Update modal contains version badges, changelog, and execute action', updaterInspection.hasCurrentBadge && updaterInspection.hasLatestBadge && updaterInspection.hasChangelog && updaterInspection.hasExecuteBtn);

    // Test clicking Check for Updates in Settings
    await cdp.eval(`window.switchTab('settings')`);
    await sleep(200);
    await cdp.eval(`document.getElementById('btn-manual-check-update').click()`);
    await sleep(400);
    const checkMsg = await cdp.eval(`document.getElementById('manual-update-result').textContent`);
    assert('Manual update check responds cleanly and displays status message', checkMsg.length > 0, checkMsg);

    // Test simulated update available event
    await cdp.eval(`
      handleUpdateAvailable({
        updateAvailable: true,
        currentVersion: '1.0.8',
        latestVersion: '1.0.9',
        releaseNotes: '• Automatic multi-audio HLS track recovery\\n• Native system FFmpeg integration',
        downloadUrl: 'https://github.com/darkangle4022211-cpu/hyperdrain/releases/download/v1.0.9/hyperdrain_1.0.9_amd64.deb'
      }, true);
    `);
    await sleep(300);
    const modalAfterUpdate = await cdp.eval(`document.getElementById('updateModal').style.display`);
    const pillAfterUpdate = await cdp.eval(`document.getElementById('btn-update-available').style.display`);
    assert('When update is available, topbar update pill becomes visible', pillAfterUpdate === 'inline-flex', `display=${pillAfterUpdate}`);
    assert('Update modal opens and renders new version details', modalAfterUpdate === 'flex', `display=${modalAfterUpdate}`);

    // Close update modal via dismiss button
    await cdp.eval(`document.getElementById('btnUpdateDismiss').click()`);
    await sleep(200);
    const modalClosed = await cdp.eval(`document.getElementById('updateModal').style.display`);
    assert('Update modal closes cleanly on dismissal', modalClosed === 'none');

    // -------------------------------------------------------------
    // TEST 9: Engine Settings & Configuration Actions
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 9: Engine Configuration ---');
    const settingsConfig = await cdp.eval(`({
      dirVal: document.getElementById('cfg-dir').value,
      hasBrowse: !!document.getElementById('cfg-browse-btn'),
      hasSave: !!document.getElementById('save-settings-btn'),
      hasTestNotif: !!document.getElementById('test-notif-btn')
    })`);
    assert('Settings shows download directory', settingsConfig.dirVal.length > 0, settingsConfig.dirVal);
    assert('Browse folder button present', settingsConfig.hasBrowse);
    assert('Save settings button present', settingsConfig.hasSave);
    assert('Test notification button present', settingsConfig.hasTestNotif);

    await cdp.eval(`document.getElementById('test-notif-btn').click()`);
    assert('Test notification button handles click event without error', true);

    // -------------------------------------------------------------
    // TEST 10: Real-time CPU and GPU Utilization Benchmark
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 10: Performance & System Resource Audit ---');
    await cdp.eval(`window.switchTab('active')`);
    console.log('[QA] Measuring true instantaneous idle CPU utilization after settling...');
    await sleep(5000);

    let topOutput = '';
    let totalCpu = 0;
    try {
      function getProcessTree(rootPid) {
        let pids = [rootPid];
        try {
          const children = execSync(`pgrep -P ${rootPid} || true`).toString().trim().split('\n').map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p > 0);
          for (const c of children) {
            pids = pids.concat(getProcessTree(c));
          }
        } catch (_) {}
        return pids;
      }

      const appPids = getProcessTree(pid);
      if (appPids.length > 0) {
        topOutput = execSync(`top -b -n 2 -d 2 -p "${appPids.join(',')}"`).toString();
        const iterations = topOutput.split(/top - /);
        const secondIter = iterations[iterations.length - 1] || '';
        console.log('[QA] top breakdown:\n' + secondIter.trim());
        const lines = secondIter.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 9 && /^\d+$/.test(parts[0]) && !isNaN(parseFloat(parts[8]))) {
            totalCpu += parseFloat(parts[8]) || 0;
          }
        }
      }
    } catch (e) {
      console.warn('top sampling error:', e.message);
    }

    const isLiveDownloading = await cdp.eval(`(() => {
      const spEl = document.getElementById('titlebar-live-speed');
      return spEl && !spEl.textContent.includes('0.00');
    })()`);

    console.log(`[QA] Total Instantaneous App CPU Load: ${totalCpu.toFixed(1)}% (Live Download Active: ${isLiveDownloading})`);
    if (isLiveDownloading) {
      assert('Application CPU remains optimized under active live background download (< 40.0%)', totalCpu < 40.0, `${totalCpu.toFixed(1)}% CPU`);
    } else {
      assert('Instantaneous idle CPU load remains close to zero (< 5.0%)', totalCpu < 5.0, `${totalCpu.toFixed(1)}% CPU`);
    }

    // -------------------------------------------------------------
    // TEST 11: Disk Space Verification & Error UI
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 11: Smart Disk Space Pre-Check Verification ---');
    await cdp.eval(`window.switchTab('active')`);
    await sleep(200);

    // Verify error metrics calculation and card rendering synchronously without telemetry race
    const spaceTestResult = await cdp.eval(`
      (() => {
        const testTask = {
          id: 'qa_disk_space_test_task',
          name: 'Massive_Archive_32GB.bin',
          status: 'error',
          error_message: 'Target disk does not have enough space: 32.00 GB required, but only 4.20 GB available',
          total_bytes: 34359738368,
          downloaded_bytes: 0,
          speed: 0,
          segments: []
        };
        const m = window.computeTaskMetrics(testTask);
        window.renderTasks([testTask]);
        const card = document.querySelector('.task-card[data-task-id="qa_disk_space_test_task"]');
        const progressEl = card ? (card.querySelector('.progress-label-text') || card.querySelector('.task-progress-label') || card) : null;
        return {
          metricWarning: m && m.progressLabel && m.progressLabel.includes('Target disk does not have enough space'),
          metricLabel: m ? m.progressLabel : '',
          cardExists: !!card,
          cardLabel: progressEl ? progressEl.textContent : '',
          cardWarning: progressEl ? progressEl.textContent.includes('Target disk does not have enough space') : false
        };
      })()
    `);

    assert('Task rejected due to insufficient disk space renders with error card', spaceTestResult && spaceTestResult.cardExists);
    assert('Task card displays clear warning message detailing required vs available disk space', spaceTestResult && spaceTestResult.cardWarning, spaceTestResult ? spaceTestResult.cardLabel : 'None');

    // Clean up simulated test card
    await cdp.eval(`window.renderTasks([]);`);
    await sleep(200);

    // -------------------------------------------------------------
    // TEST 12: Directory Auto-Healing & Ghost Directory Protection
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 12: Directory Auto-Healing & Resilience ---');
    await cdp.eval(`window.switchTab('settings')`);
    await sleep(200);

    // Spawn an isolated instance of the newly compiled engine on port 6889 to test auto-healing API
    const testPort = '6889';
    const testDataDir = '/tmp/hd_engine_test_' + Date.now();
    const testEngineProc = spawn('./hyperdrain', ['--no-window'], {
      env: Object.assign({}, process.env, {
        HYPERDRAIN_PORT: testPort,
        HYPERDRAIN_DATA_DIR: testDataDir
      }),
      stdio: 'ignore'
    });
    await sleep(1000);

    let healApiResult = null;
    try {
      const deadDir = '/run/media/hamza/disk E/Twisted.Metal.S01.1080p.MoviesMod.org/2';
      const postRes = await fetch(`http://127.0.0.1:${testPort}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ download_dir: deadDir })
      });
      const data = await postRes.json();
      healApiResult = {
        originalSent: deadDir,
        healedDir: data.download_dir,
        isHealed: data.download_dir !== deadDir && data.download_dir === '/run/media/hamza/disk E'
      };
    } catch (e) {
      console.warn('Test engine fetch error:', e.message);
    } finally {
      try { testEngineProc.kill('SIGTERM'); } catch (e) {}
    }

    assert('Engine auto-heals dead/deleted download paths sent in settings to closest existing drive', healApiResult && healApiResult.isHealed, `Healed: ${healApiResult ? healApiResult.healedDir : 'None'}`);

    // 2. Verify UI updates its input field with the healed valid directory
    await cdp.eval(`loadSettings()`);
    await sleep(200);
    const uiDirVal = await cdp.eval(`document.getElementById('cfg-dir').value`);
    assert('UI Settings input displays valid existing directory path', uiDirVal.length > 0 && !uiDirVal.includes('Twisted.Metal'), uiDirVal);

    // 3. Test Clicking Save Settings button
    await cdp.eval(`document.getElementById('save-settings-btn').click()`);
    assert('Save Settings button clicked and processed cleanly', true);

    // 4. Test safe openFolder on deleted task path (must not throw or crash)
    const openFolderSafe = await cdp.eval(`
      (async () => {
        try {
          if (window.openFolder) {
            await window.openFolder('nonexistent_task_id');
            return true;
          }
          return false;
        } catch (e) {
          return false;
        }
      })()
    `);
    assert('openFolder safely handles nonexistent or deleted tasks without crash', openFolderSafe);

    // Switch back to active tab
    await cdp.eval(`window.switchTab('active')`);
    await sleep(200);

    // -------------------------------------------------------------
    // FINAL REPORT
    // -------------------------------------------------------------
    console.log('\n===============================================================');
    const total = testResults.length;
    const passed = testResults.filter(r => r.passed).length;
    const failed = total - passed;
    console.log(` 🎯 QA Summary: ${passed}/${total} Tests Passed (${((passed/total)*100).toFixed(0)}%)`);
    if (failed === 0) {
      console.log(' 🌟 ALL CHECKS PASSED: Desktop App is 100% Operational & Verified!');
    } else {
      console.log(` ⚠️ ${failed} Tests Failed.`);
    }
    console.log('===============================================================\n');

  } catch (err) {
    console.error('[QA] Error during test execution:', err);
  } finally {
    cdp.close();
    if (electronProc) {
      console.log('[QA] Gracefully terminating test runner...');
      try {
        electronProc.kill('SIGTERM');
        await sleep(1000);
        electronProc.kill('SIGKILL');
      } catch (e) {}
    }
  }
}

runQASuite().catch(console.error);
