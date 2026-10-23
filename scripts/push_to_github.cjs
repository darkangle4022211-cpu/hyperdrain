const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const tokenFile = path.join(root, '.github_token');
const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
const owner = 'darkangle4022211-cpu';
const repo = 'hyperdrain';
const branch = 'main';

function ghReq(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method: method,
      headers: {
        'User-Agent': 'HyperDrain-Pusher',
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json',
        ...(postData ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(d) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: d });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function uploadBlob(filePath) {
  const buf = fs.readFileSync(filePath);
  const base64 = buf.toString('base64');
  const res = await ghReq('POST', `/repos/${owner}/${repo}/git/blobs`, {
    content: base64,
    encoding: 'base64'
  });
  if (res.status !== 201) throw new Error(`Failed to create blob for ${filePath}: ${JSON.stringify(res)}`);
  return res.data.sha;
}

const fileList = [
  'assets/hyperdrain.png',
  'electron/main.cjs',
  'electron/preload.cjs',
  'engine/allocator_linux.go',
  'engine/allocator_windows.go',
  'engine/db.go',
  'engine/disk_space_test.go',
  'engine/downloader.go',
  'engine/extractor.go',
  'engine/notify.go',
  'engine/proc_unix.go',
  'engine/proc_windows.go',
  'engine/server.go',
  'engine/torrent.go',
  'engine/types.go',
  'extension/background.js',
  'extension/content.js',
  'extension/icons/icon16.png',
  'extension/icons/icon48.png',
  'extension/icons/icon128.png',
  'extension/manifest.json',
  'extension/popup.css',
  'extension/popup.html',
  'extension/popup.js',
  'extension/prompt.html',
  'extension/prompt.js',
  'go.mod',
  'go.sum',
  'HyperDrain.bat',
  'HyperDrain.desktop',
  'main.go',
  'package.json',
  'README.md',
  'scripts/build_deb.sh',
  'scripts/build_engine.sh',
  'scripts/build_release.sh',
  'scripts/push_to_github.cjs',
  'scripts/qa_runner.cjs',
  'scripts/upload_release_asset.cjs',
  'signal_unix.go',
  'signal_windows.go',
  'start.sh',
  'update.json',
  'webui/app.css',
  'webui/app.js',
  'webui/index.html',
  'webui/mini.html'
];

async function run() {
  const pkgVersion = require('../package.json').version;
  console.log(`⚡ Starting GitHub push for HyperDrain v${pkgVersion}...`);
  
  // 1. Get current branch ref
  const refRes = await ghReq('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (refRes.status !== 200 || !refRes.data.object) {
    throw new Error('Failed to get branch ref: ' + JSON.stringify(refRes));
  }
  const parentSha = refRes.data.object.sha;
  console.log('Parent commit:', parentSha);

  // 2. Prepare tree items
  const treeItems = [];
  for (const relPath of fileList) {
    const fullPath = path.join(root, relPath);
    if (!fs.existsSync(fullPath)) {
      console.warn('Skipping missing file:', relPath);
      continue;
    }
    const isBinary = relPath.endsWith('.png') || relPath.endsWith('.ico');
    if (isBinary) {
      const blobSha = await uploadBlob(fullPath);
      treeItems.push({
        path: relPath,
        mode: '100644',
        type: 'blob',
        sha: blobSha
      });
      console.log('📦 Uploaded binary:', relPath);
    } else {
      const content = fs.readFileSync(fullPath, 'utf8');
      treeItems.push({
        path: relPath,
        mode: (relPath.endsWith('.sh') || relPath.endsWith('.bat')) ? '100755' : '100644',
        type: 'blob',
        content: content
      });
      console.log('📄 Prepared:', relPath);
    }
  }

  // 3. Create Tree
  console.log(`Creating tree with ${treeItems.length} items...`);
  const treeRes = await ghReq('POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: parentSha,
    tree: treeItems
  });
  if (treeRes.status !== 201) throw new Error('Tree creation failed: ' + JSON.stringify(treeRes));
  const treeSha = treeRes.data.sha;
  console.log('Tree created:', treeSha);

  // 4. Create Commit
  const commitMsg = `Release v${pkgVersion}: IDM-style mini popup window, Linux background system tray daemon, and auto-start integration`;
  const commitRes = await ghReq('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: commitMsg,
    tree: treeSha,
    parents: [parentSha]
  });
  if (commitRes.status !== 201) throw new Error('Commit creation failed: ' + JSON.stringify(commitRes));
  const newCommitSha = commitRes.data.sha;
  console.log('Commit created:', newCommitSha);

  // 5. Update Branch Ref
  const updateRefRes = await ghReq('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    sha: newCommitSha,
    force: false
  });
  if (updateRefRes.status !== 200) throw new Error('Update ref failed: ' + JSON.stringify(updateRefRes));

  console.log(`✅ SUCCESS! Successfully pushed HyperDrain codebase v${pkgVersion} to GitHub main branch!`);
  console.log(`Commit URL: https://github.com/${owner}/${repo}/commit/${newCommitSha}`);
}

run().catch(err => {
  console.error('❌ Push error:', err);
  process.exit(1);
});
