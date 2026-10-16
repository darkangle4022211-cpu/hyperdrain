const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const tokenFile = path.join(root, '.github_token');
const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
const owner = 'darkangle4022211-cpu';
const repo = 'hyperdrain';
const tag = process.argv[2] || 'v1.0.6';
const ver = tag.replace(/^v/, '');

function apiReq(method, apiPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const postBuffer = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method: method,
      headers: {
        'User-Agent': 'HyperDrain-Release-Uploader',
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json',
        ...(postBuffer ? {
          'Content-Length': postBuffer.length,
          'Content-Type': 'application/json'
        } : {}),
        ...headers
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
    if (postBuffer) req.write(postBuffer);
    req.end();
  });
}

function uploadAsset(uploadUrlRaw, filename, filePath, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const cleanUrl = uploadUrlRaw.replace(/\{.*\}/, '');
    const targetUrl = new URL(cleanUrl);
    targetUrl.searchParams.set('name', filename);

    const fileStream = fs.createReadStream(filePath);
    const stats = fs.statSync(filePath);

    console.log(`Uploading ${filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)...`);

    const req = https.request({
      hostname: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      method: 'POST',
      headers: {
        'User-Agent': 'HyperDrain-Release-Uploader',
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': contentType,
        'Content-Length': stats.size
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
    fileStream.pipe(req);
  });
}

async function run() {
  console.log(`Checking release ${tag}...`);
  let relRes = await apiReq('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`);
  let rel;

  if (relRes.status === 404) {
    console.log(`Release ${tag} not found. Creating release ${tag}...`);
    const createRes = await apiReq('POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: `${tag} - Production Release`,
      body: `### HyperDrain ${tag}\n\n• Smart Pre-flight Disk Space Verification: Checks available space on target drive before starting download; prevents starting if space is insufficient and alerts the user with exact required vs available storage.\n• UI & Desktop Notification Alerts: Clear visual warning badges and error notifications for storage limits.\n• Resilient Multi-Threaded Engine: High-speed download optimizations with 6-worker chunking and SQLite WAL state journaling.`,
      draft: false,
      prerelease: false
    });
    if (createRes.status !== 201) {
      throw new Error(`Failed to create release ${tag}: ` + JSON.stringify(createRes));
    }
    rel = createRes.data;
    console.log(`Created release ${rel.name} (id: ${rel.id})`);
  } else if (relRes.status === 200) {
    rel = relRes.data;
    console.log(`Found release ${rel.name} (id: ${rel.id})`);
  } else {
    throw new Error(`Unexpected release status for ${tag}: ` + JSON.stringify(relRes));
  }

  // 1. Delete existing assets that conflict
  if (rel.assets && rel.assets.length > 0) {
    for (const asset of rel.assets) {
      console.log(`Removing old release asset: ${asset.name} (id: ${asset.id})...`);
      await apiReq('DELETE', `/repos/${owner}/${repo}/releases/assets/${asset.id}`);
    }
  }

  // 2. Upload deb package
  const debFilename = `hyperdrain_${ver}_amd64.deb`;
  let debPath = path.resolve(__dirname, `../dist-electron/${debFilename}`);
  if (!fs.existsSync(debPath)) {
    debPath = path.resolve(__dirname, `../releases/${debFilename}`);
  }
  if (!fs.existsSync(debPath)) {
    throw new Error(`Deb package not found at: ${debPath}`);
  }

  const uploadDebRes = await uploadAsset(rel.upload_url, debFilename, debPath, 'application/vnd.debian.binary-package');
  if (uploadDebRes.status !== 201) {
    throw new Error('Failed to upload deb asset: ' + JSON.stringify(uploadDebRes));
  }
  console.log(`✅ ${debFilename} uploaded successfully!`);

  // 3. Upload update.json
  const updateJsonPath = path.resolve(__dirname, '../update.json');
  const uploadJsonRes = await uploadAsset(rel.upload_url, 'update.json', updateJsonPath, 'application/json');
  if (uploadJsonRes.status !== 201) {
    throw new Error('Failed to upload update.json: ' + JSON.stringify(uploadJsonRes));
  }
  console.log('✅ update.json uploaded successfully!');
}

run().catch(err => {
  console.error('❌ Upload error:', err);
  process.exit(1);
});
