const { Plugin, FileView, Notice, TFile, normalizePath } = require("obsidian");
const { shell } = require("electron");
const zlib = require("zlib");
const { Buffer } = require("buffer");

const VIEW_TYPE = "zip-content-viewer-view";

module.exports = class ZipContentViewerPlugin extends Plugin {
  async onload() {
    this.opening = false;
    this.registerView(VIEW_TYPE, (leaf) => new ZipContentView(leaf, this));

    try {
      if (typeof this.registerExtensions === "function") this.registerExtensions(["zip"], VIEW_TYPE);
    } catch (e) {
      console.warn("ZIP Content Viewer: registerExtensions failed", e);
    }

    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (!(file instanceof TFile)) return;
      if (file.extension.toLowerCase() !== "zip") return;
      if (this.opening) return;
      const activeView = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
      if (activeView instanceof ZipContentView && activeView.file && activeView.file.path === file.path) return;
      window.setTimeout(() => this.openZipInPane(file), 0);
    }));

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof TFile && file.extension.toLowerCase() === "zip") {
        menu.addItem((item) => item.setTitle("View ZIP contents").setIcon("archive").onClick(() => this.openZipInPane(file)));
        menu.addItem((item) => item.setTitle("Open ZIP in system app").setIcon("external-link").onClick(() => this.openExternal(file)));
      }
    }));

    this.addCommand({
      id: "open-active-zip-in-viewer",
      name: "Open active ZIP in ZIP Content Viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "zip") return false;
        if (!checking) this.openZipInPane(file);
        return true;
      }
    });
  }

  async openZipInPane(file) {
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.activeLeaf || this.app.workspace.getLeaf(false);
    if (!leaf) return new Notice("No active pane for ZIP viewer");

    try {
      this.opening = true;
      await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
      const view = leaf.view;
      if (view instanceof ZipContentView) await view.setZipFile(file);
    } catch (e) {
      console.error(e);
      new Notice("Could not open ZIP viewer: " + (e && e.message ? e.message : e));
    } finally {
      window.setTimeout(() => { this.opening = false; }, 100);
    }
  }

  async openExternal(file) {
    if (!(file instanceof TFile)) return new Notice("ZIP file not found");
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.getFullPath !== "function") return new Notice("External opening is available only in Obsidian Desktop");
    const error = await shell.openPath(adapter.getFullPath(file.path));
    if (error) new Notice("Could not open ZIP: " + error);
  }
};

class ZipContentView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.archiveBuffer = null;
    this.entries = [];
    this.filteredEntries = [];
    this.selectedEntry = null;
    this.query = "";
    this.objectUrls = [];
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.name : "ZIP"; }
  getIcon() { return "archive"; }
  canAcceptExtension(extension) { return String(extension || "").toLowerCase() === "zip"; }
  async onLoadFile(file) { await this.setZipFile(file); }

  async setState(state, result) {
    await super.setState(state, result);
    if (state && state.file) {
      const f = this.app.vault.getAbstractFileByPath(state.file);
      if (f instanceof TFile) await this.setZipFile(f);
    }
  }

  getState() { return { file: this.file ? this.file.path : "" }; }
  async onClose() { this.revokeObjectUrls(); }
  async onUnloadFile() { this.revokeObjectUrls(); }

  async setZipFile(file) {
    this.file = file;
    this.entries = [];
    this.filteredEntries = [];
    this.selectedEntry = null;
    this.renderShell();
    await this.loadArchive();
  }

  revokeObjectUrls() {
    for (const url of this.objectUrls) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    this.objectUrls = [];
  }

  renderShell() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("zip-viewer-root");

    const header = container.createDiv({ cls: "zip-viewer-header" });
    const titleBlock = header.createDiv({ cls: "zip-viewer-title-block" });
    titleBlock.createDiv({ cls: "zip-viewer-title", text: this.file ? this.file.name : "ZIP archive" });
    this.statusEl = titleBlock.createDiv({ cls: "zip-viewer-status", text: "Loading..." });

    const controls = header.createDiv({ cls: "zip-viewer-controls" });
    controls.createEl("button", { text: "Reload" }).onclick = () => this.loadArchive();
    controls.createEl("button", { text: "Open ZIP" }).onclick = () => this.plugin.openExternal(this.file);

    const searchWrap = container.createDiv({ cls: "zip-viewer-search-wrap" });
    const search = searchWrap.createEl("input", { type: "search", placeholder: "Фильтр по имени файла", cls: "zip-viewer-search" });
    search.value = this.query;
    search.oninput = () => { this.query = search.value || ""; this.applyFilter(); };

    const body = container.createDiv({ cls: "zip-viewer-body" });
    this.listEl = body.createDiv({ cls: "zip-viewer-list" });
    this.previewEl = body.createDiv({ cls: "zip-viewer-preview" });
    this.previewEl.createDiv({ cls: "zip-viewer-empty", text: "Выбери файл в архиве." });
  }

  async loadArchive() {
    if (!this.file) return;
    this.setStatus("Reading archive...");
    try {
      const ab = await readBinaryFromVault(this.app, this.file);
      this.archiveBuffer = Buffer.from(ab);
      this.entries = parseZipEntries(this.archiveBuffer).entries;
      this.filteredEntries = this.entries.slice();
      this.selectedEntry = null;
      this.renderList();

      const files = this.entries.filter((e) => !e.isDirectory).length;
      const dirs = this.entries.filter((e) => e.isDirectory).length;
      const unsupported = this.entries.filter((e) => !e.isDirectory && !isSupportedMethod(e)).length;
      let status = files + " files";
      if (dirs) status += " · " + dirs + " folders";
      if (unsupported) status += " · " + unsupported + " unsupported";
      this.setStatus(status);

      const first = this.entries.find((e) => !e.isDirectory);
      if (first) this.selectEntry(first);
    } catch (e) {
      console.error(e);
      this.setStatus("Error");
      if (this.listEl) this.listEl.empty();
      if (this.previewEl) {
        this.previewEl.empty();
        this.previewEl.createDiv({ cls: "zip-viewer-error", text: "Не удалось прочитать ZIP: " + (e && e.message ? e.message : e) });
      }
    }
  }

  setStatus(text) { if (this.statusEl) this.statusEl.setText(text || ""); }

  applyFilter() {
    const q = this.query.trim().toLowerCase();
    this.filteredEntries = q ? this.entries.filter((e) => e.path.toLowerCase().includes(q)) : this.entries.slice();
    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();
    if (!this.filteredEntries.length) return this.listEl.createDiv({ cls: "zip-viewer-empty", text: "Ничего не найдено" });

    const top = this.listEl.createDiv({ cls: "zip-viewer-list-top" });
    top.createSpan({ text: "Entries: " + this.filteredEntries.length });
    const table = this.listEl.createDiv({ cls: "zip-viewer-table" });

    for (const entry of this.filteredEntries) {
      const row = table.createDiv({ cls: "zip-viewer-row" });
      if (entry.isDirectory) row.addClass("zip-viewer-row-dir");
      if (this.selectedEntry && this.selectedEntry.path === entry.path) row.addClass("zip-viewer-row-selected");
      row.onclick = () => this.selectEntry(entry);
      row.ondblclick = () => { if (!entry.isDirectory) this.extractAndOpen(entry, true); };
      row.createDiv({ cls: "zip-viewer-icon", text: iconForEntry(entry) });
      const name = row.createDiv({ cls: "zip-viewer-name" });
      name.setText(entry.path);
      name.title = entry.path;
      row.createDiv({ cls: "zip-viewer-row-meta", text: entry.isDirectory ? "folder" : formatBytes(entry.uncompressedSize) });
    }
  }

  async selectEntry(entry) {
    this.selectedEntry = entry;
    this.renderList();
    await this.renderPreview(entry);
  }

  async renderPreview(entry) {
    if (!this.previewEl) return;
    this.revokeObjectUrls();
    this.previewEl.empty();

    const header = this.previewEl.createDiv({ cls: "zip-preview-header" });
    const title = header.createDiv({ cls: "zip-preview-title" });
    title.setText(entry.path);
    title.title = entry.path;

    const buttons = header.createDiv({ cls: "zip-preview-buttons" });
    if (!entry.isDirectory) {
      buttons.createEl("button", { text: "Extract" }).onclick = () => this.extractAndOpen(entry, false);
      buttons.createEl("button", { text: "Extract & open" }).onclick = () => this.extractAndOpen(entry, true);
      buttons.createEl("button", { text: "Copy name" }).onclick = () => copyText(entry.path);
    }

    this.previewEl.createDiv({ cls: "zip-preview-meta", text: buildEntryMeta(entry) });

    if (entry.isDirectory) return this.previewEl.createDiv({ cls: "zip-viewer-empty", text: "Папка внутри архива" });
    if (entry.encrypted) return this.previewEl.createDiv({ cls: "zip-viewer-error", text: "Файл зашифрован. Просмотр не поддерживается." });
    if (!isSupportedMethod(entry)) return this.previewEl.createDiv({ cls: "zip-viewer-error", text: "Метод сжатия не поддерживается: " + entry.method });

    try {
      const data = extractEntryData(this.archiveBuffer, entry);
      const type = detectPreviewType(entry.path, data);
      if (type.kind === "image") return this.renderImagePreview(data, type.mime);
      if (type.kind === "text") return this.renderTextPreview(data, type.syntax);
      this.previewEl.createDiv({ cls: "zip-viewer-empty", text: "Предпросмотр для этого типа файла не сделан. Можно извлечь и открыть внешней программой." });
    } catch (e) {
      console.error(e);
      this.previewEl.createDiv({ cls: "zip-viewer-error", text: "Не удалось прочитать файл: " + (e && e.message ? e.message : e) });
    }
  }

  renderImagePreview(data, mime) {
    const blob = new Blob([bufferToArrayBuffer(data)], { type: mime });
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    const wrap = this.previewEl.createDiv({ cls: "zip-image-wrap" });
    const img = wrap.createEl("img", { cls: "zip-image-preview" });
    img.src = url;
  }

  renderTextPreview(data, syntax) {
    let text = decodeText(data);
    if (syntax === "json") {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
    }
    const controls = this.previewEl.createDiv({ cls: "zip-text-controls" });
    controls.createEl("button", { text: "Copy text" }).onclick = () => copyText(text);
    const pre = this.previewEl.createEl("pre", { cls: "zip-text-preview" });
    pre.createEl("code").setText(text);
  }

  async extractAndOpen(entry, openAfter) {
    try {
      const data = extractEntryData(this.archiveBuffer, entry);
      const archiveName = this.file.basename.replace(/\.zip$/i, "");
      const targetRoot = normalizePath("_zip_extract/" + sanitizePathPart(archiveName));
      const safeRel = safeZipPath(entry.path);
      if (!safeRel) return new Notice("Unsafe ZIP path");
      const targetPath = await getUniqueVaultPath(this.app, normalizePath(targetRoot + "/" + safeRel));
      await writeBinaryToVault(this.app, targetPath, data);
      new Notice("Extracted: " + targetPath);
      if (openAfter !== false) {
        window.setTimeout(async () => {
          const f = this.app.vault.getAbstractFileByPath(targetPath);
          if (f instanceof TFile) await this.app.workspace.getLeaf(true).openFile(f);
        }, 150);
      }
    } catch (e) {
      console.error(e);
      new Notice("Could not extract file: " + (e && e.message ? e.message : e));
    }
  }
}

async function readBinaryFromVault(app, file) {
  if (app.vault && typeof app.vault.readBinary === "function") return await app.vault.readBinary(file);
  if (app.vault && app.vault.adapter && typeof app.vault.adapter.readBinary === "function") return await app.vault.adapter.readBinary(file.path);
  throw new Error("Binary read is not available in this Obsidian build");
}

function parseZipEntries(buffer) {
  const eocd = findEOCD(buffer);
  if (eocd < 0) throw new Error("End of central directory not found");
  const totalEntries = readU16(buffer, eocd + 10);
  const cdSize = readU32(buffer, eocd + 12);
  const cdOffset = readU32(buffer, eocd + 16);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error("ZIP64 is not supported in this lightweight viewer");
  if (cdOffset < 0 || cdOffset >= buffer.length) throw new Error("Invalid central directory offset");

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (readU32(buffer, offset) !== 0x02014b50) break;
    const flags = readU16(buffer, offset + 8);
    const method = readU16(buffer, offset + 10);
    const modTime = readU16(buffer, offset + 12);
    const modDate = readU16(buffer, offset + 14);
    const compressedSize = readU32(buffer, offset + 20);
    const uncompressedSize = readU32(buffer, offset + 24);
    const nameLen = readU16(buffer, offset + 28);
    const extraLen = readU16(buffer, offset + 30);
    const commentLen = readU16(buffer, offset + 32);
    const localHeaderOffset = readU32(buffer, offset + 42);
    const nameBytes = buffer.slice(offset + 46, offset + 46 + nameLen);
    const path = decodeFileName(nameBytes, flags);

    entries.push({
      path,
      method,
      flags,
      encrypted: Boolean(flags & 1),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: path.endsWith("/"),
      modified: dosDateTimeToDate(modDate, modTime)
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries };
}

function findEOCD(buffer) {
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= min; i--) if (readU32(buffer, i) === 0x06054b50) return i;
  return -1;
}

function extractEntryData(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (readU32(buffer, offset) !== 0x04034b50) throw new Error("Invalid local file header");
  const nameLen = readU16(buffer, offset + 26);
  const extraLen = readU16(buffer, offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error("Entry data is outside archive bounds");
  const compressed = buffer.slice(dataStart, dataEnd);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error("Unsupported compression method: " + entry.method);
}

function isSupportedMethod(entry) { return entry.method === 0 || entry.method === 8; }
function readU16(buffer, offset) { return buffer.readUInt16LE(offset); }
function readU32(buffer, offset) { return buffer.readUInt32LE(offset); }

function decodeFileName(bytes, flags) {
  if (flags & 0x0800) return decodeWith("utf-8", bytes);
  for (const enc of ["utf-8", "ibm866", "windows-1251"]) {
    try {
      const decoded = decodeWith(enc, bytes);
      if (decoded && !decoded.includes("�")) return decoded;
    } catch (e) {}
  }
  return decodeWith("utf-8", bytes);
}
function decodeWith(enc, bytes) { return new TextDecoder(enc).decode(bytes); }

function dosDateTimeToDate(dosDate, dosTime) {
  if (!dosDate) return null;
  const day = dosDate & 0x1f;
  const month = (dosDate >> 5) & 0x0f;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const second = (dosTime & 0x1f) * 2;
  const minute = (dosTime >> 5) & 0x3f;
  const hour = (dosTime >> 11) & 0x1f;
  return new Date(year, month - 1, day, hour, minute, second);
}

function detectPreviewType(path, data) {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".png")) return { kind: "image", mime: "image/png" };
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return { kind: "image", mime: "image/jpeg" };
  if (lower.endsWith(".gif")) return { kind: "image", mime: "image/gif" };
  if (lower.endsWith(".webp")) return { kind: "image", mime: "image/webp" };
  if (lower.endsWith(".svg")) return { kind: "image", mime: "image/svg+xml" };
  if (isProbablyText(data) || /\.(txt|md|json|csv|tsv|log|xml|html|htm|css|js|ts|py|yaml|yml|ini|conf|bat|cmd|ps1|sh)$/i.test(lower)) {
    return { kind: "text", syntax: lower.endsWith(".json") ? "json" : "text" };
  }
  return { kind: "binary" };
}

function isProbablyText(data) {
  const sample = data.slice(0, Math.min(data.length, 4096));
  if (sample.length === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) return false;
    if (c < 7 || (c > 14 && c < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}

function decodeText(data) {
  for (const enc of ["utf-8", "windows-1251", "ibm866"]) {
    try {
      const text = new TextDecoder(enc).decode(data);
      if (!text.includes("�")) return text;
    } catch (e) {}
  }
  return new TextDecoder("utf-8").decode(data);
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

function buildEntryMeta(entry) {
  const parts = [];
  parts.push(entry.isDirectory ? "folder" : "file");
  if (!entry.isDirectory) {
    parts.push("size: " + formatBytes(entry.uncompressedSize));
    parts.push("packed: " + formatBytes(entry.compressedSize));
    parts.push("method: " + methodLabel(entry.method));
  }
  if (entry.modified) parts.push("modified: " + entry.modified.toLocaleString());
  if (entry.encrypted) parts.push("encrypted");
  return parts.join(" · ");
}
function methodLabel(method) { if (method === 0) return "stored"; if (method === 8) return "deflate"; return String(method); }
function iconForEntry(entry) {
  if (entry.isDirectory) return "📁";
  const lower = entry.path.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(lower)) return "🖼";
  if (/\.(txt|md|json|csv|tsv|log|xml|html|css|js|ts|py|yaml|yml)$/.test(lower)) return "📄";
  if (/\.pdf$/.test(lower)) return "📕";
  if (/\.(zip|rar|7z)$/.test(lower)) return "🗜";
  return "📦";
}

function bufferToArrayBuffer(buffer) { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); }
async function writeBinaryToVault(app, path, buffer) {
  const normalized = normalizePath(path);
  const folder = normalized.includes("/") ? normalized.substring(0, normalized.lastIndexOf("/")) : "";
  await ensureFolder(app, folder);
  const arr = bufferToArrayBuffer(buffer);
  if (app.vault && typeof app.vault.createBinary === "function" && !app.vault.getAbstractFileByPath(normalized)) return await app.vault.createBinary(normalized, arr);
  if (app.vault && app.vault.adapter && typeof app.vault.adapter.writeBinary === "function") return await app.vault.adapter.writeBinary(normalized, arr);
  throw new Error("Binary write is not available in this Obsidian build");
}
async function ensureFolder(app, folderPath) {
  const clean = normalizePath(folderPath || "");
  if (!clean) return;
  const parts = clean.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? current + "/" + part : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}
async function getUniqueVaultPath(app, targetPath) {
  const normalized = normalizePath(targetPath);
  if (!app.vault.getAbstractFileByPath(normalized)) return normalized;
  const slash = normalized.lastIndexOf("/");
  const folder = slash >= 0 ? normalized.substring(0, slash + 1) : "";
  const file = slash >= 0 ? normalized.substring(slash + 1) : normalized;
  const dot = file.lastIndexOf(".");
  const base = dot >= 0 ? file.substring(0, dot) : file;
  const ext = dot >= 0 ? file.substring(dot) : "";
  let i = 2;
  let candidate = folder + base + " " + i + ext;
  while (app.vault.getAbstractFileByPath(candidate)) {
    i++;
    candidate = folder + base + " " + i + ext;
  }
  return candidate;
}
function safeZipPath(path) {
  return String(path || "").replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== ".." && !p.includes(":")).map(sanitizePathPart).filter(Boolean).join("/");
}
function sanitizePathPart(value) { return String(value || "").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim(); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text || "")); new Notice("Copied"); }
  catch (e) { console.error(e); new Notice("Could not copy"); }
      }
