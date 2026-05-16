const { Plugin, FileView, Notice, TFile } = require("obsidian");
const { shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const VIEW_TYPE = "archive-viewer-7zip-view";
const ARCHIVE_EXTENSIONS = ["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "iso", "wim", "cab", "arj", "lzh", "lha", "z", "001"];
const TEXT_EXTENSIONS = new Set(["txt", "md", "json", "csv", "tsv", "xml", "html", "htm", "css", "js", "ts", "py", "yaml", "yml", "ini", "conf", "log", "bat", "cmd", "ps1", "sh", "sql"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

module.exports = class ArchiveViewer7ZipPlugin extends Plugin {
  async onload() {
    this.opening = false;
    this.sevenZip = findSevenZip();
    this.sevenZipFM = findSevenZipFM() || this.sevenZip;

    this.registerView(VIEW_TYPE, leaf => new ArchiveView(leaf, this));

    try {
      if (typeof this.registerExtensions === "function") this.registerExtensions(ARCHIVE_EXTENSIONS, VIEW_TYPE);
    } catch (e) {
      console.warn("Archive Viewer for 7-Zip: registerExtensions failed", e);
    }

    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (!(file instanceof TFile) || !isArchive(file)) return;
      if (this.opening) return;
      window.setTimeout(() => this.openArchive(file), 0);
    }));

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || !isArchive(file)) return;
      menu.addItem(item => item.setTitle("View archive contents").setIcon("archive").onClick(() => this.openArchive(file)));
      menu.addItem(item => item.setTitle("Open in 7-Zip").setIcon("external-link").onClick(() => this.openIn7Zip(file)));
    }));

    this.addCommand({
      id: "open-active-archive-viewer-7zip",
      name: "Open active archive in Archive Viewer for 7-Zip",
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || !isArchive(file)) return false;
        if (!checking) this.openArchive(file);
        return true;
      }
    });
  }

  async openArchive(file) {
    if (!this.sevenZip) {
      new Notice("7-Zip not found. Install 7-Zip or add it to a standard Windows path.");
      return;
    }
    try {
      this.opening = true;
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
      if (leaf.view instanceof ArchiveView) await leaf.view.setArchiveFile(file);
    } finally {
      window.setTimeout(() => { this.opening = false; }, 100);
    }
  }

  async openIn7Zip(file) {
    const fullPath = this.fullPath(file);
    if (!fullPath) return new Notice("Cannot resolve archive path.");
    if (this.sevenZipFM) {
      run7z(this.sevenZipFM, [fullPath]).catch(err => new Notice("Cannot open 7-Zip: " + err.message));
      return;
    }
    shell.openPath(fullPath);
  }

  fullPath(file) {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getFullPath === "function") return adapter.getFullPath(file.path);
    return null;
  }
};

class ArchiveView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.entries = [];
    this.filtered = [];
    this.query = "";
    this.objectUrls = [];
    this.leftPaneWidth = 36;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.name : "Archive"; }
  getIcon() { return "archive"; }
  canAcceptExtension(extension) { return ARCHIVE_EXTENSIONS.includes(String(extension || "").toLowerCase()); }
  async onLoadFile(file) { await this.setArchiveFile(file); }
  getState() { return { file: this.file ? this.file.path : "", leftPaneWidth: this.leftPaneWidth }; }
  async onClose() { this.revokeUrls(); }

  async setState(state, result) {
    await super.setState(state, result);
    if (state && typeof state.leftPaneWidth === "number") this.leftPaneWidth = clamp(state.leftPaneWidth, 20, 75);
    if (state && state.file) {
      const f = this.app.vault.getAbstractFileByPath(state.file);
      if (f instanceof TFile) await this.setArchiveFile(f);
    }
  }

  async setArchiveFile(file) {
    this.file = file;
    this.entries = [];
    this.filtered = [];
    this.renderShell("Reading archive...");
    await this.loadEntries();
  }

  renderShell(status) {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("zip-viewer-root");

    const header = root.createDiv({ cls: "zip-viewer-header" });
    const titleBlock = header.createDiv({ cls: "zip-viewer-title-block" });
    titleBlock.createDiv({ cls: "zip-viewer-title", text: this.file ? this.file.name : "Archive" });
    this.statusEl = titleBlock.createDiv({ cls: "zip-viewer-status", text: status || "" });
    const controls = header.createDiv({ cls: "zip-viewer-controls" });
    controls.createEl("button", { text: "Reload" }).onclick = () => this.loadEntries();
    controls.createEl("button", { text: "Open in 7-Zip" }).onclick = () => this.plugin.openIn7Zip(this.file);

    const searchWrap = root.createDiv({ cls: "zip-viewer-search-wrap" });
    const input = searchWrap.createEl("input", { type: "search", placeholder: "Filter files", cls: "zip-viewer-search" });
    input.value = this.query;
    input.oninput = () => { this.query = input.value || ""; this.applyFilter(); };

    const body = root.createDiv({ cls: "zip-viewer-body" });
    this.bodyEl = body;
    this.listEl = body.createDiv({ cls: "zip-viewer-list" });
    this.splitterEl = body.createDiv({ cls: "zip-viewer-splitter", attr: { title: "Drag to resize" } });
    this.previewEl = body.createDiv({ cls: "zip-viewer-preview" });
    this.previewEl.createDiv({ cls: "zip-viewer-empty", text: "Select a file inside the archive." });
    this.applyPaneWidth();
    this.setupSplitter();
  }

  applyPaneWidth() {
    if (!this.bodyEl || !this.listEl || !this.previewEl) return;
    const left = clamp(this.leftPaneWidth, 20, 75);
    this.listEl.style.flexBasis = left + "%";
    this.previewEl.style.flexBasis = "calc(" + (100 - left) + "% - 6px)";
  }

  setupSplitter() {
    if (!this.splitterEl || !this.bodyEl) return;
    let dragging = false;
    const onMove = event => {
      if (!dragging) return;
      const rect = this.bodyEl.getBoundingClientRect();
      if (!rect.width) return;
      const x = event.clientX - rect.left;
      this.leftPaneWidth = clamp((x / rect.width) * 100, 20, 75);
      this.applyPaneWidth();
      event.preventDefault();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.removeClass("zip-viewer-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    this.splitterEl.onmousedown = event => {
      dragging = true;
      document.body.addClass("zip-viewer-resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      event.preventDefault();
    };
  }

  async loadEntries() {
    try {
      this.setStatus("Reading archive through 7-Zip...");
      const archivePath = this.plugin.fullPath(this.file);
      if (!archivePath) throw new Error("Cannot resolve archive path");
      const stdout = await exec7z(this.plugin.sevenZip, ["l", "-slt", "-ba", "-sccUTF-8", archivePath], { maxBuffer: 128 * 1024 * 1024 });
      this.entries = parse7zListing(stdout.toString("utf8"));
      this.filtered = this.entries.slice();
      this.renderList();
      this.setStatus(this.entries.length + " entries · 7-Zip backend");
    } catch (e) {
      console.error(e);
      this.listEl.empty();
      this.previewEl.empty();
      this.setStatus("Error");
      this.previewEl.createDiv({ cls: "zip-viewer-error", text: "Cannot read archive: " + e.message });
    }
  }

  setStatus(text) { if (this.statusEl) this.statusEl.setText(text || ""); }

  applyFilter() {
    const q = this.query.trim().toLowerCase();
    this.filtered = q ? this.entries.filter(e => e.path.toLowerCase().includes(q)) : this.entries.slice();
    this.renderList();
  }

  renderList() {
    this.listEl.empty();
    if (!this.filtered.length) {
      this.listEl.createDiv({ cls: "zip-viewer-empty", text: "Nothing found" });
      return;
    }
    this.listEl.createDiv({ cls: "zip-viewer-list-top", text: "Entries: " + this.filtered.length });
    const table = this.listEl.createDiv({ cls: "zip-viewer-table" });
    for (const entry of this.filtered) {
      const row = table.createDiv({ cls: "zip-viewer-row" });
      if (entry.isDirectory) row.addClass("zip-viewer-row-dir");
      row.onclick = () => this.preview(entry);
      row.createDiv({ cls: "zip-viewer-icon", text: entry.isDirectory ? "📁" : iconFor(entry.path) });
      const name = row.createDiv({ cls: "zip-viewer-name" });
      name.setText(entry.path);
      name.title = entry.path;
      row.createDiv({ cls: "zip-viewer-row-meta", text: entry.isDirectory ? "folder" : formatBytes(entry.size) });
    }
  }

  async preview(entry) {
    this.revokeUrls();
    this.previewEl.empty();
    const header = this.previewEl.createDiv({ cls: "zip-preview-header" });
    const title = header.createDiv({ cls: "zip-preview-title" });
    title.setText(entry.path);
    title.title = entry.path;
    const buttons = header.createDiv({ cls: "zip-preview-buttons" });
    buttons.createEl("button", { text: "Open archive in 7-Zip" }).onclick = () => this.plugin.openIn7Zip(this.file);

    this.previewEl.createDiv({ cls: "zip-preview-meta", text: entry.isDirectory ? "folder" : formatBytes(entry.size) });
    if (entry.isDirectory) return;

    const ext = extOf(entry.path);
    if (!TEXT_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(ext)) {
      this.previewEl.createDiv({ cls: "zip-viewer-empty", text: "Preview is available for text and images. Use 7-Zip for other files." });
      return;
    }

    try {
      this.setStatus("Extracting preview...");
      const archivePath = this.plugin.fullPath(this.file);
      const data = await exec7z(this.plugin.sevenZip, ["x", "-so", "-sccUTF-8", archivePath, entry.path], { maxBuffer: 128 * 1024 * 1024 });
      if (IMAGE_EXTENSIONS.has(ext)) return this.previewImage(data, ext);
      return this.previewText(data, ext);
    } catch (e) {
      this.previewEl.createDiv({ cls: "zip-viewer-error", text: "Cannot preview file: " + e.message });
    } finally {
      this.setStatus(this.entries.length + " entries · 7-Zip backend");
    }
  }

  previewText(buffer, ext) {
    let text = decodeText(buffer);
    if (ext === "json") {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
    }
    const controls = this.previewEl.createDiv({ cls: "zip-text-controls" });
    controls.createEl("button", { text: "Copy text" }).onclick = () => navigator.clipboard.writeText(text).then(() => new Notice("Copied"));
    const pre = this.previewEl.createEl("pre", { cls: "zip-text-preview" });
    pre.createEl("code").setText(text);
  }

  previewImage(buffer, ext) {
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/" + ext;
    const blob = new Blob([buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)], { type: mime });
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    const wrap = this.previewEl.createDiv({ cls: "zip-image-wrap" });
    const img = wrap.createEl("img", { cls: "zip-image-preview" });
    img.src = url;
  }

  revokeUrls() {
    for (const url of this.objectUrls) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    this.objectUrls = [];
  }
}

function isArchive(file) { return ARCHIVE_EXTENSIONS.includes(String(file.extension || "").toLowerCase()); }
function extOf(name) { const i = String(name).lastIndexOf("."); return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ""; }
function iconFor(name) { const ext = extOf(name); if (IMAGE_EXTENSIONS.has(ext)) return "🖼"; if (TEXT_EXTENSIONS.has(ext)) return "📄"; return "📦"; }
function formatBytes(n) { n = Number(n || 0); if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(1) + " KB"; if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB"; return (n / 1073741824).toFixed(1) + " GB"; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || min)); }

function decodeText(buffer) {
  const encodings = ["utf-8", "windows-1251", "ibm866"];
  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding).decode(buffer);
      if (!text.includes("�")) return text;
    } catch (e) {}
  }
  return buffer.toString("utf8");
}

function parse7zListing(text) {
  const entries = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      if (current && current.path) entries.push(normalizeEntry(current));
      current = null;
      continue;
    }
    const m = line.match(/^([^=]+) = (.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2];
    if (key === "Path") {
      if (current && current.path) entries.push(normalizeEntry(current));
      current = { path: value, size: 0, attributes: "" };
    } else if (current) {
      if (key === "Size") current.size = Number(value) || 0;
      if (key === "Attributes") current.attributes = value || "";
      if (key === "Modified") current.modified = value || "";
    }
  }
  if (current && current.path) entries.push(normalizeEntry(current));
  return entries.filter(e => e.path && e.path !== ".").sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeEntry(entry) {
  entry.isDirectory = /D/.test(entry.attributes) || entry.path.endsWith("/") || entry.path.endsWith("\\");
  return entry;
}

function findSevenZip() {
  return firstExisting([
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "7-Zip", "7z.exe"),
    "7z"
  ]);
}

function findSevenZipFM() {
  return firstExisting([
    "C:\\Program Files\\7-Zip\\7zFM.exe",
    "C:\\Program Files (x86)\\7-Zip\\7zFM.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "7-Zip", "7zFM.exe")
  ]);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === "7z") return candidate;
    try { if (fs.existsSync(candidate)) return candidate; } catch (e) {}
  }
  return null;
}

function exec7z(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "buffer", windowsHide: true, maxBuffer: options.maxBuffer || 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const msg = (stderr && stderr.toString("utf8")) || error.message || String(error);
        reject(new Error(msg.trim()));
        return;
      }
      resolve(stdout || Buffer.alloc(0));
    });
  });
}

function run7z(file, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: false }, error => error ? reject(error) : resolve());
    if (child && child.unref) child.unref();
  });
}
