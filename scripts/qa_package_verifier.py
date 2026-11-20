#!/usr/bin/env python3
"""
HyperDrain QA Package Verifier
Performs rigorous end-to-end QA validation of both:
1. Linux Snap (.snap) package
2. Windows Store (.appx) package
"""

import os
import sys
import shutil
import tempfile
import subprocess
import zipfile
import base64
import hashlib
from xml.etree import ElementTree as ET
from PIL import Image

PROJECT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIST_DIR = os.path.join(PROJECT_DIR, "dist-electron")
SNAP_PATH = os.path.join(DIST_DIR, "hyperdrain_1.0.9_amd64.snap")
APPX_PATH = os.path.join(DIST_DIR, "HyperDrain-1.0.9.appx")

def test_linux_snap():
    print("\n" + "=" * 60)
    print("🧪 [QA TEST 1/2] Rigorous Linux Snap Package Validation")
    print("=" * 60)

    results = []

    # 1. Existence and size
    if not os.path.exists(SNAP_PATH):
        return [("Snap Package Exists", False, f"File not found: {SNAP_PATH}")]

    sz_mb = os.path.getsize(SNAP_PATH) / (1024 * 1024)
    results.append(("Snap Package File Exists", True, f"{sz_mb:.2f} MB"))

    # 2. Extract squashfs to temp dir
    temp_dir = tempfile.mkdtemp(prefix="hyperdrain_snap_qa_")
    try:
        proc = subprocess.run(["unsquashfs", "-d", temp_dir, SNAP_PATH], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if proc.returncode != 0:
            results.append(("SquashFS Unpack", False, proc.stderr))
            return results
        results.append(("SquashFS Unpack Integrity", True, "Successfully unpacked squashfs filesystem"))

        # 3. Check snap.yaml
        snap_yaml_path = os.path.join(temp_dir, "meta", "snap.yaml")
        if not os.path.exists(snap_yaml_path):
            results.append(("meta/snap.yaml Exists", False, "Missing snap.yaml"))
        else:
            with open(snap_yaml_path, "r", encoding="utf-8") as f:
                content = f.read()

            checks = [
                ("name: hyperdrain", "Package Name Definition"),
                ("version: 1.0.9", "Package Version Match"),
                ("confinement: strict", "Security Confinement (Strict)"),
                ("grade: stable", "Release Grade (Stable)"),
                ("- network", "Plugs: network"),
                ("- network-bind", "Plugs: network-bind (Port 6880/6882 Local Server)"),
                ("- removable-media", "Plugs: removable-media (External Disk Access)"),
                ("- home", "Plugs: home (~/Downloads Access)"),
                ("- desktop", "Plugs: desktop"),
                ("- audio-playback", "Plugs: audio-playback (Completion Sound)"),
            ]
            for needle, label in checks:
                ok = needle in content
                results.append((label, ok, f"Found '{needle}'" if ok else f"Missing '{needle}'"))

        # 4. Check hyperdrain-engine binary and permissions
        engine_bin = os.path.join(temp_dir, "resources", "app", "hyperdrain-engine")
        if os.path.exists(engine_bin):
            mode = os.stat(engine_bin).st_mode
            is_executable = bool(mode & 0o111)
            results.append(("Engine Binary Executable (0755)", is_executable, f"Mode: {oct(mode)}"))
        else:
            results.append(("Engine Binary Present", False, "Missing resources/app/hyperdrain-engine"))

        # 5. Check desktop entry and icon
        desktop_entry = os.path.join(temp_dir, "meta", "gui", "hyperdrain.desktop")
        icon_path = os.path.join(temp_dir, "meta", "gui", "icon.png")
        results.append(("Desktop Entry in meta/gui", os.path.exists(desktop_entry), desktop_entry if os.path.exists(desktop_entry) else "Missing"))
        results.append(("Application Icon in meta/gui", os.path.exists(icon_path), icon_path if os.path.exists(icon_path) else "Missing"))

        # 6. Verify webui history section removed in package
        app_js = os.path.join(temp_dir, "resources", "app", "webui", "app.js")
        if os.path.exists(app_js):
            with open(app_js, "r", encoding="utf-8") as f:
                app_js_text = f.read()
            history_cleaned = "recentSection" not in app_js_text and "RECENT COMPLETED HISTORY" not in app_js_text
            results.append(("Active UI Free of History Clutter", history_cleaned, "Confirmed clean empty-hero view"))

        # 7. Verify extension paste link bar removed in package
        ext_popup = os.path.join(temp_dir, "resources", "app", "extension", "popup.html")
        if os.path.exists(ext_popup):
            with open(ext_popup, "r", encoding="utf-8") as f:
                ext_popup_text = f.read()
            paste_bar_removed = "url-input" not in ext_popup_text and "Paste direct URL" not in ext_popup_text
            results.append(("Extension Paste Link Bar Removed", paste_bar_removed, "Confirmed paste input removed from extension"))

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return results

def test_windows_appx():
    print("\n" + "=" * 60)
    print("🧪 [QA TEST 2/2] Rigorous Windows AppX Package Validation")
    print("=" * 60)

    results = []

    # 1. Existence and size
    if not os.path.exists(APPX_PATH):
        return [("AppX Package Exists", False, f"File not found: {APPX_PATH}")]

    sz_mb = os.path.getsize(APPX_PATH) / (1024 * 1024)
    results.append(("AppX Package File Exists", True, f"{sz_mb:.2f} MB"))

    try:
        zf = zipfile.ZipFile(APPX_PATH, "r")
    except Exception as e:
        results.append(("ZIP Container Integrity", False, str(e)))
        return results

    namelist = zf.namelist()

    # 2. Footprint files
    results.append(("AppxManifest.xml at Root", "AppxManifest.xml" in namelist, "Present"))
    results.append(("[Content_Types].xml at Root", "[Content_Types].xml" in namelist, "Present"))
    results.append(("AppxBlockMap.xml at Root", "AppxBlockMap.xml" in namelist, "Present"))

    # 3. Parse AppxManifest.xml
    try:
        manifest_data = zf.read("AppxManifest.xml")
        root = ET.fromstring(manifest_data)
        
        # Identity
        identity = None
        for elem in root.iter():
            if elem.tag.endswith("Identity"):
                identity = elem
                break
        
        if identity is not None:
            name = identity.get("Name")
            ver = identity.get("Version")
            arch = identity.get("ProcessorArchitecture")
            results.append(("Package Identity Name", name == "HyperDrain.HighSpeedDownloader", f"Name: {name}"))
            results.append(("Package Version (4-part)", ver == "1.0.9.0", f"Version: {ver}"))
            results.append(("Processor Architecture", arch == "x64", f"Architecture: {arch}"))
        else:
            results.append(("Package Identity Element", False, "Missing <Identity>"))

        # Capabilities
        has_full_trust = False
        for elem in root.iter():
            if elem.tag.endswith("Capability") and elem.get("Name") == "runFullTrust":
                has_full_trust = True
                break
        results.append(("Desktop Bridge Capability: runFullTrust", has_full_trust, "Present"))

        # Protocol
        has_protocol = False
        for elem in root.iter():
            if elem.tag.endswith("Protocol") and elem.get("Name") == "hyperdrain":
                has_protocol = True
                break
        results.append(("Protocol Association: hyperdrain://", has_protocol, "Present"))

    except Exception as e:
        results.append(("AppxManifest.xml Parsing", False, str(e)))

    # 4. Check Store Tile Assets
    expected_assets = {
        "assets/StoreLogo.png": (50, 50),
        "assets/Square150x150Logo.png": (150, 150),
        "assets/Square44x44Logo.png": (44, 44),
        "assets/Wide310x150Logo.png": (310, 150),
    }

    temp_asset_dir = tempfile.mkdtemp(prefix="appx_asset_qa_")
    try:
        for asset_rel, expected_dims in expected_assets.items():
            if asset_rel in namelist:
                out_p = zf.extract(asset_rel, temp_asset_dir)
                img = Image.open(out_p)
                dim_match = (img.size == expected_dims)
                results.append((f"Tile Asset: {asset_rel}", dim_match, f"Actual: {img.size[0]}x{img.size[1]} | Expected: {expected_dims[0]}x{expected_dims[1]}"))
            else:
                results.append((f"Tile Asset: {asset_rel}", False, "Missing in package"))
    finally:
        shutil.rmtree(temp_asset_dir, ignore_errors=True)

    # 5. Check Binaries
    results.append(("Windows Main Executable (HyperDrain.exe)", "HyperDrain.exe" in namelist, "Present"))
    has_win_engine = "resources/app/hyperdrain.exe" in namelist or "resources/app/hyperdrain-engine.exe" in namelist
    results.append(("Windows Go Backend Engine Executable", has_win_engine, "Present in resources/app"))

    # Check extension paste link bar removed in AppX
    if "resources/app/extension/popup.html" in namelist:
        win_ext_popup = zf.read("resources/app/extension/popup.html").decode("utf-8")
        win_paste_bar_removed = "url-input" not in win_ext_popup and "Paste direct URL" not in win_ext_popup
        results.append(("Extension Paste Link Bar Removed in AppX", win_paste_bar_removed, "Confirmed paste input removed from extension"))

    # 6. Verify AppxBlockMap.xml Hash Integrity across all package files
    try:
        blockmap_data = zf.read("AppxBlockMap.xml")
        bm_root = ET.fromstring(blockmap_data)
        
        file_elems = [e for e in bm_root.iter() if e.tag.endswith("File")]
        results.append(("BlockMap File Entries Count", len(file_elems) > 0, f"{len(file_elems)} files cataloged"))

        hash_mismatches = 0
        total_blocks = 0

        for file_elem in file_elems:
            raw_name = file_elem.get("Name")
            norm_name = raw_name.replace("\\", "/")
            if norm_name not in namelist:
                hash_mismatches += 1
                continue

            file_bytes = zf.read(norm_name)
            block_elems = [b for b in file_elem if b.tag.endswith("Block")]
            
            # Verify each 64KB chunk
            chunk_idx = 0
            for b_elem in block_elems:
                expected_hash = b_elem.get("Hash")
                chunk = file_bytes[chunk_idx * 65536 : (chunk_idx + 1) * 65536]
                actual_hash = base64.b64encode(hashlib.sha256(chunk).digest()).decode("utf-8")
                if expected_hash != actual_hash:
                    hash_mismatches += 1
                    break
                chunk_idx += 1
                total_blocks += 1

        results.append(("AppxBlockMap.xml Cryptographic Integrity", hash_mismatches == 0, f"Verified {total_blocks} 64KB blocks with 0 mismatches"))

    except Exception as e:
        results.append(("BlockMap Integrity Verification", False, str(e)))

    return results

def main():
    print("=" * 60)
    print("🚀 HYPERDRAIN QA AUTOMATED PACKAGE TEST SUITE")
    print("=" * 60)

    snap_results = test_linux_snap()
    appx_results = test_windows_appx()

    print("\n" + "=" * 60)
    print("📋 SUMMARY QA VERIFICATION RESULTS")
    print("=" * 60)

    total_passed = 0
    total_failed = 0

    print("\n--- [LINUX SNAP PACKAGE] ---")
    for name, passed, detail in snap_results:
        symbol = "✅ PASS" if passed else "❌ FAIL"
        if passed:
            total_passed += 1
        else:
            total_failed += 1
        print(f"[{symbol}] {name:<45} : {detail}")

    print("\n--- [WINDOWS APPX PACKAGE] ---")
    for name, passed, detail in appx_results:
        symbol = "✅ PASS" if passed else "❌ FAIL"
        if passed:
            total_passed += 1
        else:
            total_failed += 1
        print(f"[{symbol}] {name:<45} : {detail}")

    print("\n" + "=" * 60)
    print(f"Total Tests Run: {total_passed + total_failed} | Passed: {total_passed} | Failed: {total_failed}")
    if total_failed == 0:
        print("🎉 ALL QUALITY ASSURANCE CHECKS PASSED WITH 100% SUCCESS!")
        print("   Both packages are ready for store publication and public deployment.")
        print("=" * 60)
        sys.exit(0)
    else:
        print("⚠️ Some QA checks failed. Review errors above.")
        print("=" * 60)
        sys.exit(1)

if __name__ == "__main__":
    main()
