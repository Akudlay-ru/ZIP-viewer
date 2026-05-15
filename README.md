# Archive Viewer for 7-Zip

Archive Viewer for 7-Zip — desktop-only plugin for Obsidian that uses an installed 7-Zip to view archive contents directly inside Obsidian.

The plugin does not try to become an archive editor. Obsidian shows the archive structure and previews common text/image files. Full archive editing is delegated to 7-Zip through the `Open in 7-Zip` action.

## Features

- Opens archive files from the Obsidian file explorer.
- Shows archive contents using installed 7-Zip.
- Adds archive actions to the Obsidian file context menu.
- Supports common archive formats through 7-Zip:
  - ZIP
  - 7z
  - RAR
  - TAR
  - GZ / TGZ
  - BZ2 / TBZ2
  - XZ / TXZ
  - ISO
  - WIM
  - CAB
  - ARJ
  - LZH / LHA
  - Z
  - 001
- Previews common text files.
- Formats JSON preview when possible.
- Previews common image files.
- Opens the selected archive in 7-Zip for editing or advanced operations.

## Requirements

This plugin requires 7-Zip installed on Windows.

The plugin looks for 7-Zip in standard locations:

```text
C:\Program Files\7-Zip\7z.exe
C:\Program Files\7-Zip\7zFM.exe
C:\Program Files (x86)\7-Zip\7z.exe
C:\Program Files (x86)\7-Zip\7zFM.exe
```

If 7-Zip is not found, the plugin shows a clear notice.

## What the plugin does not do

- It does not edit archives inside Obsidian.
- It does not add or delete files inside archives.
- It does not replace 7-Zip.
- It does not work on mobile.

For archive editing, use `Open in 7-Zip` from the context menu.

## Manual installation

Copy these files into your vault plugin folder:

```text
.obsidian/plugins/zip-content-viewer/manifest.json
.obsidian/plugins/zip-content-viewer/main.js
.obsidian/plugins/zip-content-viewer/styles.css
```

Then restart Obsidian or reload community plugins and enable `Archive Viewer for 7-Zip`.

## Status

Version: `1.1.0`

Current scope: archive viewing and forwarding advanced operations to installed 7-Zip.
