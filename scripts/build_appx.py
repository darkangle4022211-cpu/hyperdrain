#!/usr/bin/env python3
"""
HyperDrain Windows AppX Package Builder
Creates a Microsoft Store compliant .appx package from win-unpacked.
Includes:
- AppxManifest.xml with runFullTrust & hyperdrain:// protocol
- [Content_Types].xml
- AppxBlockMap.xml with 64KB block SHA-256 hashes & correct LfhSize
- Full Windows Store visual assets (StoreLogo, Square150x150, Square44x44, Wide310x150)
- Flawless OPC ZIP packaging
"""

import os
import sys
import base64
import hashlib
import zipfile
from xml.etree import ElementTree as ET
from xml.dom import minidom
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
WIN_DIR = os.path.join(PROJECT_DIR, "dist-electron", "win-unpacked")
OUTPUT_APPX = os.path.join(PROJECT_DIR, "dist-electron", "HyperDrain-1.0.9.appx")
ASSETS_DIR = os.path.join(WIN_DIR, "assets")

BLOCK_SIZE = 65536  # Standard 64 KB block size for AppX
BLOCKMAP_NS = "http://schemas.microsoft.com/appx/2010/blockmap"

def generate_tile_assets():
    """Generates all required Windows Store tile images from assets/hyperdrain.png."""
    src_icon = os.path.join(PROJECT_DIR, "assets", "hyperdrain.png")
    if not os.path.exists(src_icon):
        raise FileNotFoundError(f"Source icon not found at {src_icon}")

    os.makedirs(ASSETS_DIR, exist_ok=True)
    orig_img = Image.open(src_icon).convert("RGBA")

    sizes = {
        "StoreLogo.png": (50, 50),
        "Square150x150Logo.png": (150, 150),
        "Square44x44Logo.png": (44, 44),
        "Square310x310Logo.png": (310, 310),
        "Square71x71Logo.png": (71, 71),
    }

    for name, sz in sizes.items():
        out_path = os.path.join(ASSETS_DIR, name)
        resized = orig_img.resize(sz, Image.Resampling.LANCZOS)
        resized.save(out_path, format="PNG")
        print(f"  ✓ Generated {name} ({sz[0]}x{sz[1]})")

    # Generate Wide 310x150 tile (centered logo on #070a13 dark canvas)
    wide_tile = Image.new("RGBA", (310, 150), (7, 10, 19, 255))
    inner_logo = orig_img.resize((120, 120), Image.Resampling.LANCZOS)
    offset_x = (310 - 120) // 2
    offset_y = (150 - 120) // 2
    wide_tile.paste(inner_logo, (offset_x, offset_y), inner_logo)
    wide_path = os.path.join(ASSETS_DIR, "Wide310x150Logo.png")
    wide_tile.save(wide_path, format="PNG")
    print(f"  ✓ Generated Wide310x150Logo.png (310x150)")

def write_appx_manifest():
    """Writes Microsoft Store compliant AppxManifest.xml."""
    manifest_path = os.path.join(WIN_DIR, "AppxManifest.xml")
    content = """<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10">
  <Identity Name="HyperDrain.HighSpeedDownloader"
            ProcessorArchitecture="x64"
            Publisher="CN=HyperDrain, O=HyperDrain, L=San Francisco, S=CA, C=US"
            Version="1.0.9.0" />
  <Properties>
    <DisplayName>HyperDrain</DisplayName>
    <PublisherDisplayName>HyperDrain</PublisherDisplayName>
    <Logo>assets\\StoreLogo.png</Logo>
    <Description>Accelerated 32-stream multi-threaded downloader tailored for massive files, web series, and video streams.</Description>
  </Properties>
  <Resources>
    <Resource Language="en-US" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
  <Applications>
    <Application Id="HyperDrain"
                 Executable="HyperDrain.exe"
                 EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="HyperDrain"
                          Description="Accelerated 32-stream multi-threaded downloader tailored for massive files, web series, and video streams."
                          BackgroundColor="#070a13"
                          Square150x150Logo="assets\\Square150x150Logo.png"
                          Square44x44Logo="assets\\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png"
                         Square310x310Logo="assets\\Square310x310Logo.png"
                         Square71x71Logo="assets\\Square71x71Logo.png">
          <uap:ShowNameOnTiles>
            <uap:ShowOn Tile="square150x150Logo" />
            <uap:ShowOn Tile="wide310x150Logo" />
          </uap:ShowNameOnTiles>
        </uap:DefaultTile>
        <uap:SplashScreen Image="assets\\Wide310x150Logo.png" BackgroundColor="#070a13" />
      </uap:VisualElements>
      <Extensions>
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="hyperdrain">
            <uap:DisplayName>HyperDrain Download Protocol</uap:DisplayName>
          </uap:Protocol>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
"""
    with open(manifest_path, "w", encoding="utf-8") as f:
        f.write(content.strip() + "\n")
    print(f"  ✓ Written AppxManifest.xml")

def write_content_types():
    """Writes OPC compliant [Content_Types].xml."""
    types_path = os.path.join(WIN_DIR, "[Content_Types].xml")
    content = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/vnd.ms-appx.manifest+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="ico" ContentType="image/x-icon"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="exe" ContentType="application/x-msdownload"/>
  <Default Extension="dll" ContentType="application/x-msdownload"/>
  <Default Extension="bin" ContentType="application/octet-stream"/>
  <Default Extension="pak" ContentType="application/octet-stream"/>
  <Default Extension="dat" ContentType="application/octet-stream"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="html" ContentType="text/html"/>
  <Default Extension="css" ContentType="text/css"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="txt" ContentType="text/plain"/>
  <Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml"/>
  <Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml"/>
</Types>
"""
    with open(types_path, "w", encoding="utf-8") as f:
        f.write(content.strip() + "\n")
    print(f"  ✓ Written [Content_Types].xml")

def generate_block_map(file_list):
    """
    Generates AppxBlockMap.xml based on 64KB block SHA-256 hashes and ZIP LfhSize.
    file_list is a list of tuples: (rel_path_in_zip, abs_disk_path, lfh_size)
    """
    ET.register_namespace('', BLOCKMAP_NS)
    root = ET.Element(f"{{{BLOCKMAP_NS}}}BlockMap")
    root.set("HashMethod", "http://www.w3.org/2001/xmlenc#sha256")

    for rel_path, abs_path, lfh_size in file_list:
        if rel_path in ("AppxBlockMap.xml", "AppxSignature.p7x"):
            continue

        file_size = os.path.getsize(abs_path)
        file_elem = ET.SubElement(root, f"{{{BLOCKMAP_NS}}}File")
        # In AppX BlockMap, paths are Windows style backslashes
        file_elem.set("Name", rel_path.replace("/", "\\"))
        file_elem.set("Size", str(file_size))
        file_elem.set("LfhSize", str(lfh_size))

        if file_size == 0:
            continue

        with open(abs_path, "rb") as f:
            while True:
                chunk = f.read(BLOCK_SIZE)
                if not chunk:
                    break
                sha256_digest = hashlib.sha256(chunk).digest()
                b64_hash = base64.b64encode(sha256_digest).decode("utf-8")
                block_elem = ET.SubElement(file_elem, f"{{{BLOCKMAP_NS}}}Block")
                block_elem.set("Hash", b64_hash)

    rough_string = ET.tostring(root, encoding="utf-8")
    reparsed = minidom.parseString(rough_string)
    pretty_xml = reparsed.toprettyxml(indent="  ", encoding="utf-8")
    lines = [line for line in pretty_xml.split(b"\n") if line.strip()]
    cleaned_xml = b"\n".join(lines) + b"\n"

    blockmap_path = os.path.join(WIN_DIR, "AppxBlockMap.xml")
    with open(blockmap_path, "wb") as f:
        f.write(cleaned_xml)
    print(f"  ✓ Generated AppxBlockMap.xml ({len(file_list)} files hashed)")
    return blockmap_path

def build_appx_package():
    print("=" * 60)
    print("⚡ Building Production-Grade Windows AppX Package...")
    print("=" * 60)

    if not os.path.isdir(WIN_DIR):
        print(f"Error: {WIN_DIR} does not exist. Run electron-builder --win --dir --x64 first.")
        sys.exit(1)

    # 1. Tile assets
    print("\n[Step 1/5] Generating Microsoft Store Tile Assets...")
    generate_tile_assets()

    # 2. Manifest & Content Types
    print("\n[Step 2/5] Creating AppxManifest.xml & [Content_Types].xml...")
    write_appx_manifest()
    write_content_types()

    # 3. Collect all files to be packaged
    print("\n[Step 3/5] Cataloging payload files and calculating LFH headers...")
    items = []
    # Ensure footprint files are included
    for root, _, files in os.walk(WIN_DIR):
        for f in files:
            if f in ("AppxBlockMap.xml", "AppxSignature.p7x"):
                continue
            abs_p = os.path.join(root, f)
            rel_p = os.path.relpath(abs_p, WIN_DIR).replace("\\", "/")
            # LFH size: 30 bytes + length of UTF-8 encoded filename (no extra fields in standard zip)
            lfh_size = 30 + len(rel_p.encode("utf-8"))
            items.append((rel_p, abs_p, lfh_size))

    # Sort files: [Content_Types].xml, AppxManifest.xml, assets, others
    def sort_key(item):
        rel = item[0]
        if rel == "[Content_Types].xml":
            return (0, rel)
        if rel == "AppxManifest.xml":
            return (1, rel)
        if rel.startswith("assets/"):
            return (2, rel)
        return (3, rel)

    items.sort(key=sort_key)

    # 4. Generate BlockMap
    print("\n[Step 4/5] Computing SHA-256 block hashes (64KB chunks) for BlockMap...")
    blockmap_path = generate_block_map(items)

    # Add blockmap to items for zip packaging (it goes right after AppxManifest.xml)
    bm_rel = "AppxBlockMap.xml"
    bm_lfh = 30 + len(bm_rel.encode("utf-8"))
    zip_items = []
    for item in items:
        if item[0] == "AppxManifest.xml":
            zip_items.append(item)
            zip_items.append((bm_rel, blockmap_path, bm_lfh))
        else:
            zip_items.append(item)

    # 5. Pack into OPC ZIP (.appx)
    print(f"\n[Step 5/5] Packaging into {os.path.basename(OUTPUT_APPX)}...")
    if os.path.exists(OUTPUT_APPX):
        os.remove(OUTPUT_APPX)

    with zipfile.ZipFile(OUTPUT_APPX, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for rel_p, abs_p, _ in zip_items:
            # Create ZipInfo with fixed timestamp for reproducible builds
            zinfo = zipfile.ZipInfo(rel_p, (2026, 11, 1, 12, 0, 0))
            zinfo.compress_type = zipfile.ZIP_DEFLATED
            zinfo.external_attr = 0o644 << 16
            if rel_p.endswith(".exe") or rel_p.endswith(".dll"):
                zinfo.external_attr = 0o755 << 16

            with open(abs_p, "rb") as fp:
                zf.writestr(zinfo, fp.read())

    appx_size_mb = os.path.getsize(OUTPUT_APPX) / (1024 * 1024)
    print(f"\n✅ [SUCCESS] Windows AppX Package successfully created!")
    print(f"   Path: {OUTPUT_APPX}")
    print(f"   Size: {appx_size_mb:.2f} MB")
    print(f"   Store Architecture: x64 | Target: Windows 10/11 Desktop Bridge")

if __name__ == "__main__":
    build_appx_package()
