import os
import sys
import time
import urllib.request

token_file = '.github_token'
if not os.path.exists(token_file):
    print("Error: .github_token not found")
    sys.exit(1)

with open(token_file, 'r') as f:
    token = f.read().strip()

asset_path = 'dist-electron/HyperDrain-1.1.2.AppImage'
if not os.path.exists(asset_path):
    print(f"Error: {asset_path} not found")
    sys.exit(1)

file_size = os.path.getsize(asset_path)
print(f"Starting upload of {asset_path} ({file_size / 1024 / 1024:.2f} MB)...")

# 1. Check if asset already exists on release 424017438, and delete if so
rel_url = 'https://api.github.com/repos/darkangle4022211-cpu/hyperdrain/releases/424017438'
req_info = urllib.request.Request(rel_url, headers={
    'Authorization': f'token {token}',
    'User-Agent': 'HyperDrain-Uploader',
    'Accept': 'application/vnd.github.v3+json'
})

import json
resp = urllib.request.urlopen(req_info)
rel_data = json.loads(resp.read().decode())
for asset in rel_data.get('assets', []):
    if asset['name'] == 'HyperDrain-1.1.2.AppImage':
        print(f"Deleting existing asset id {asset['id']}...")
        del_req = urllib.request.Request(
            f"https://api.github.com/repos/darkangle4022211-cpu/hyperdrain/releases/assets/{asset['id']}",
            method='DELETE',
            headers={'Authorization': f'token {token}', 'User-Agent': 'HyperDrain-Uploader'}
        )
        urllib.request.urlopen(del_req)
        print("Existing asset deleted.")

# 2. Upload with a custom file reader wrapper that prints progress
class ProgressReader:
    def __init__(self, filename, total_size):
        self.f = open(filename, 'rb')
        self.total = total_size
        self.read_so_far = 0
        self.start_time = time.time()
        self.last_log = time.time()

    def read(self, size=-1):
        chunk = self.f.read(size)
        if chunk:
            self.read_so_far += len(chunk)
            now = time.time()
            if now - self.last_log >= 5.0 or self.read_so_far == self.total:
                pct = (self.read_so_far / self.total) * 100
                speed = (self.read_so_far / 1024) / max(0.1, (now - self.start_time))
                print(f"[Upload Progress] {self.read_so_far / 1024 / 1024:.1f}/{self.total / 1024 / 1024:.1f} MB ({pct:.1f}%) @ {speed:.1f} KB/s")
                self.last_log = now
        return chunk

    def len(self):
        return self.total

    def __len__(self):
        return self.total

upload_url = 'https://uploads.github.com/repos/darkangle4022211-cpu/hyperdrain/releases/424017438/assets?name=HyperDrain-1.1.2.AppImage'
reader = ProgressReader(asset_path, file_size)

upload_req = urllib.request.Request(
    upload_url,
    data=reader,
    headers={
        'Authorization': f'token {token}',
        'User-Agent': 'HyperDrain-Uploader',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/octet-stream',
        'Content-Length': str(file_size)
    }
)

print("Dispatching HTTP POST upload request...")
t0 = time.time()
try:
    with urllib.request.urlopen(upload_req) as upload_resp:
        result = upload_resp.read().decode()
        print(f"✅ AppImage upload successful! HTTP Status: {upload_resp.status} in {time.time() - t0:.1f}s")
        print(result[:200])
except Exception as e:
    print(f"❌ Upload failed: {e}")
    sys.exit(1)
finally:
    reader.f.close()
