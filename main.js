const { Plugin, FileView, Notice, TFile, normalizePath } = require('obsidian');
const { shell } = require('electron');
const zlib = require('zlib');
const { Buffer } = require('buffer');

const VIEW_TYPE = 'zip-content-viewer-view';

module.exports = class ZipContentViewerPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, leaf => new ZipContentView(leaf, this));

    try {
      if (typeof this.registerExtensions === 'function') {
        this.registerExtensions(['zip'], VIEW_TYPE);
      }
    } catch (e) {
      console.warn('ZIP Content Viewer: registerExtensions failed', e);
    }

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension.toLowerCase() === 'zip') {
        menu.addItem(item => item
          .setTitle('View ZIP contents')
          .setIcon('archive')
          .onClick(() => this.openZip(file)));
        menu.addItem(item => item
          .setTitle('Open ZIP in system app')
          .setIcon('external-link')
          .onClick(() => this.openExternal(file)));
      }
    }));

    this.addCommand({
      id: 'open-active-zip-in-viewer',
      name: 'Open active ZIP in ZIP Content Viewer',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'zip') return false;
        if (!checking) this.openZip(file);
        return true;
      }
    });
  }

  async openZip(file) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
    if (leaf.view instanceof ZipContentView) await leaf.view.setZipFile(file);
  }

  async openExternal(file) {
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.getFullPath !== 'function') {
      new Notice('External opening is available only in Obsidian Desktop');
      return;
    }
    const error = await shell.openPath(adapter.getFullPath(file.path));
    if (error) new Notice('Could not open ZIP: ' + error);
  }
};

class ZipContentView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.buffer = null;
    this.entries = [];
    this.filtered = [];
    this.query = '';
    this.objectUrls = [];
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.name : 'ZIP'; }
  getIcon() { return 'archive'; }
  canAcceptExtension(extension) { return String(extension || '').toLowerCase() === 'zip'; }
  async onLoadFile(file) { await this.setZipFile(file); }

  async setState(state, result) {
    await super.setState(state, result);
    if (state && state.file) {
      const file = this.app.vault.getAbstractFileByPath(state.file);
      if (file instanceof TFile) await this.setZipFile(file);
    }
  }

  getState() { return { file: this.file ? this.file.path : '' }; }
  async onClose() { this.revokeUrls(); }

  async setZipFile(file) {
    this.file = file;
    this.renderShell();
    await this.loadArchive();
  }

  revokeUrls() {
    for (const url of this.objectUrls) {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }
    this.objectUrls = [];
  }

  renderShell() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('zip-viewer-root');

    const header = root.createDiv({ cls: 'zip-viewer-header' });
    const titleBlock = header.createDiv({ cls: 'zip-viewer-title-block' });
    titleBlock.createDiv({ cls: 'zip-viewer-title', text: this.file ? this.file.name : 'ZIP archive' });
    this.statusEl = titleBlock.createDiv({ cls: 'zip-viewer-status', text: 'Loading...' });

    const controls = header.createDiv({ cls: 'zip-viewer-controls' });
    controls.createEl('button', { text: 'Reload' }).onclick = () => this.loadArchive();
    controls.createEl('button', { text: 'Open ZIP' }).onclick = () => this.plugin.openExternal(this.file);

    const searchWrap = root.createDiv({ cls: 'zip-viewer-search-wrap' });
    const search = searchWrap.createEl('input', { type: 'search', placeholder: 'Filter by file name', cls: 'zip-viewer-search' });
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value || '';
      this.applyFilter();
    };

    const body = root.createDiv({ cls: 'zip-viewer-body' });
    this.listEl = body.createDiv({ cls: 'zip-viewer-list' });
    this.previewEl = body.createDiv({ cls: 'zip-viewer-preview' });
    this.previewEl.createDiv({ cls: 'zip-viewer-empty', text: 'Select a file in the archive.' });
  }

  async loadArchive() {
    if (!this.file) return;
    try {
      this.setStatus('Reading archive...');
      const ab = await readBinary(this.app, this.file);
      this.buffer = Buffer.from(ab);
      this.entries = parseZip(this.buffer);
      this.filtered = this.entries.slice();
      this.renderList();
      const files = this.entries.filter(e => !e.isDirectory).length;
      const dirs = this.entries.filter(e => e.isDirectory).length;
      this.setStatus(files + ' files' + (dirs ? ' · ' + dirs + ' folders' : ''));
    } catch (e) {
      console.error(e);
      this.setStatus('Error');
      this.listEl.empty();
      this.previewEl.empty();
      this.previewEl.createDiv({ cls: 'zip-viewer-error', text: 'Could not read ZIP: ' + messageOf(e) });
    }
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text || '');
  }

  applyFilter() {
    const q = this.query.trim().toLowerCase();
    this.filtered = q ? this.entries.filter(e => e.path.toLowerCase().includes(q)) : this.entries.slice();
    this.renderList();
  }

  renderList() {
    this.listEl.empty();
    if (!this.filtered.length) {
      this.listEl.createDiv({ cls: 'zip-viewer-empty', text: 'Nothing found' });
      return;
    }
    this.listEl.createDiv({ cls: 'zip-viewer-list-top', text: 'Entries: ' + this.filtered.length });
    const table = this.listEl.createDiv({ cls: 'zip-viewer-table' });
    for (const entry of this.filtered) {
      const row = table.createDiv({ cls: 'zip-viewer-row' });
      if (entry.isDirectory) row.addClass('zip-viewer-row-dir');
      row.onclick = () => this.renderPreview(entry);
      row.ondblclick = () => { if (!entry.isDirectory) this.extract(entry, true); };
      row.createDiv({ cls: 'zip-viewer-icon', text: icon(entry) });
      const name = row.createDiv({ cls: 'zip-viewer-name' });
      name.setText(entry.path);
      name.title = entry.path;
      row.createDiv({ cls: 'zip-viewer-row-meta', text: entry.isDirectory ? 'folder' : formatBytes(entry.uncompressedSize) });
    }
  }

  renderPreview(entry) {
    this.revokeUrls();
    this.previewEl.empty();

    const header = this.previewEl.createDiv({ cls: 'zip-preview-header' });
    const title = header.createDiv({ cls: 'zip-preview-title' });
    title.setText(entry.path);
    title.title = entry.path;

    const buttons = header.createDiv({ cls: 'zip-preview-buttons' });
    if (!entry.isDirectory) {
      buttons.createEl('button', { text: 'Extract' }).onclick = () => this.extract(entry, false);
      buttons.createEl('button', { text: 'Extract & open' }).onclick = () => this.extract(entry, true);
      buttons.createEl('button', { text: 'Copy name' }).onclick = () => copyText(entry.path);
    }

    this.previewEl.createDiv({ cls: 'zip-preview-meta', text: meta(entry) });

    if (entry.isDirectory) {
      this.previewEl.createDiv({ cls: 'zip-viewer-empty', text: 'Folder inside archive' });
      return;
    }
    if (entry.encrypted) {
      this.previewEl.createDiv({ cls: 'zip-viewer-error', text: 'Encrypted files are not supported.' });
      return;
    }
    if (entry.method !== 0 && entry.method !== 8) {
      this.previewEl.createDiv({ cls: 'zip-viewer-error', text: 'Unsupported compression method: ' + entry.method });
      return;
    }

    try {
      const data = extractData(this.buffer, entry);
      const type = detectType(entry.path, data);
      if (type.kind === 'image') return this.previewImage(data, type.mime);
      if (type.kind === 'text') return this.previewText(data, type.syntax);
      this.previewEl.createDiv({ cls: 'zip-viewer-empty', text: 'No preview for this file type. Extract it to open.' });
    } catch (e) {
      this.previewEl.createDiv({ cls: 'zip-viewer-error', text: 'Could not preview file: ' + messageOf(e) });
    }
  }

  previewImage(data, mime) {
    const blob = new Blob([toArrayBuffer(data)], { type: mime });
    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    const wrap = this.previewEl.createDiv({ cls: 'zip-image-wrap' });
    const img = wrap.createEl('img', { cls: 'zip-image-preview' });
    img.src = url;
  }

  previewText(data, syntax) {
    let text = decodeText(data);
    if (syntax === 'json') {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}
    }
    const controls = this.previewEl.createDiv({ cls: 'zip-text-controls' });
    controls.createEl('button', { text: 'Copy text' }).onclick = () => copyText(text);
    const pre = this.previewEl.createEl('pre', { cls: 'zip-text-preview' });
    pre.createEl('code').setText(text);
  }

  async extract(entry, openAfter) {
    try {
      const data = extractData(this.buffer, entry);
      const archiveName = sanitize(this.file.basename.replace(/\.zip$/i, ''));
      const targetRoot = normalizePath('_zip_extract/' + archiveName);
      const safeRel = safePath(entry.path);
      if (!safeRel) throw new Error('Unsafe ZIP path');
      const targetPath = await uniquePath(this.app, normalizePath(targetRoot + '/' + safeRel));
      await writeBinary(this.app, targetPath, data);
      new Notice('Extracted: ' + targetPath);
      if (openAfter) {
        window.setTimeout(async () => {
          const file = this.app.vault.getAbstractFileByPath(targetPath);
          if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
        }, 150);
      }
    } catch (e) {
      console.error(e);
      new Notice('Could not extract file: ' + messageOf(e));
    }
  }
}

async function readBinary(app, file) {
  if (app.vault && typeof app.vault.readBinary === 'function') return app.vault.readBinary(file);
  if (app.vault && app.vault.adapter && typeof app.vault.adapter.readBinary === 'function') return app.vault.adapter.readBinary(file.path);
  throw new Error('Binary read is not available');
}

function parseZip(buffer) {
  const eocd = findEOCD(buffer);
  if (eocd < 0) throw new Error('End of central directory not found');
  const total = u16(buffer, eocd + 10);
  const cdOffset = u32(buffer, eocd + 16);
  if (total === 65535 || cdOffset === 4294967295) throw new Error('ZIP64 is not supported');

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < total; i++) {
    if (u32(buffer, offset) !== 33639248) break;
    const flags = u16(buffer, offset + 8);
    const method = u16(buffer, offset + 10);
    const modTime = u16(buffer, offset + 12);
    const modDate = u16(buffer, offset + 14);
    const compressedSize = u32(buffer, offset + 20);
    const uncompressedSize = u32(buffer, offset + 24);
    const nameLen = u16(buffer, offset + 28);
    const extraLen = u16(buffer, offset + 30);
    const commentLen = u16(buffer, offset + 32);
    const localHeaderOffset = u32(buffer, offset + 42);
    const nameBytes = buffer.slice(offset + 46, offset + 46 + nameLen);
    const path = decodeName(nameBytes, flags);
    entries.push({
      path,
      method,
      flags,
      encrypted: Boolean(flags & 1),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: path.endsWith('/'),
      modified: dosDate(modDate, modTime)
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function findEOCD(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (u32(buffer, i) === 101010256) return i;
  }
  return -1;
}

function extractData(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (u32(buffer, offset) !== 67324752) throw new Error('Invalid local file header');
  const nameLen = u16(buffer, offset + 26);
  const extraLen = u16(buffer, offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error('Entry data is outside archive bounds');
  const compressed = buffer.slice(start, end);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error('Unsupported compression method: ' + entry.method);
}

function u16(buffer, offset) { return buffer.readUInt16LE(offset); }
function u32(buffer, offset) { return buffer.readUInt32LE(offset); }

function decodeName(bytes, flags) {
  if (flags & 2048) return decodeWith('utf-8', bytes);
  for (const enc of ['utf-8', 'ibm866', 'windows-1251']) {
    try {
      const text = decodeWith(enc, bytes);
      if (text && !text.includes('�')) return text;
    } catch (e) {}
  }
  return decodeWith('utf-8', bytes);
}

function decodeWith(enc, bytes) { return new TextDecoder(enc).decode(bytes); }

function dosDate(dosDateValue, dosTimeValue) {
  if (!dosDateValue) return null;
  const day = dosDateValue & 31;
  const month = (dosDateValue >> 5) & 15;
  const year = ((dosDateValue >> 9) & 127) + 1980;
  const second = (dosTimeValue & 31) * 2;
  const minute = (dosTimeValue >> 5) & 63;
  const hour = (dosTimeValue >> 11) & 31;
  return new Date(year, month - 1, day, hour, minute, second);
}

function detectType(path, data) {
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.png')) return { kind: 'image', mime: 'image/png' };
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return { kind: 'image', mime: 'image/jpeg' };
  if (p.endsWith('.gif')) return { kind: 'image', mime: 'image/gif' };
  if (p.endsWith('.webp')) return { kind: 'image', mime: 'image/webp' };
  if (p.endsWith('.svg')) return { kind: 'image', mime: 'image/svg+xml' };
  if (isText(data) || /\.(txt|md|json|csv|tsv|log|xml|html|htm|css|js|ts|py|yaml|yml|ini|conf)$/i.test(p)) {
    return { kind: 'text', syntax: p.endsWith('.json') ? 'json' : 'text' };
  }
  return { kind: 'binary' };
}

function isText(data) {
  const sample = data.slice(0, Math.min(data.length, 4096));
  if (!sample.length) return true;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) return false;
    if (c < 7 || (c > 14 && c < 32)) bad++;
  }
  return bad / sample.length < 0.05;
}

function decodeText(data) {
  for (const enc of ['utf-8', 'windows-1251', 'ibm866']) {
    try {
      const text = new TextDecoder(enc).decode(data);
      if (!text.includes('�')) return text;
    } catch (e) {}
  }
  return new TextDecoder('utf-8').decode(data);
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(1) + ' GB';
}

function meta(entry) {
  const parts = [entry.isDirectory ? 'folder' : 'file'];
  if (!entry.isDirectory) {
    parts.push('size: ' + formatBytes(entry.uncompressedSize));
    parts.push('packed: ' + formatBytes(entry.compressedSize));
    parts.push('method: ' + (entry.method === 0 ? 'stored' : entry.method === 8 ? 'deflate' : String(entry.method)));
  }
  if (entry.modified) parts.push('modified: ' + entry.modified.toLocaleString());
  if (entry.encrypted) parts.push('encrypted');
  return parts.join(' · ');
}

function icon(entry) {
  if (entry.isDirectory) return '📁';
  const p = entry.path.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(p)) return '🖼';
  if (/\.(txt|md|json|csv|tsv|log|xml|html|css|js|ts|py|yaml|yml)$/i.test(p)) return '📄';
  if (/\.pdf$/i.test(p)) return '📕';
  return '📦';
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function writeBinary(app, path, buffer) {
  const normalized = normalizePath(path);
  const folder = normalized.includes('/') ? normalized.substring(0, normalized.lastIndexOf('/')) : '';
  await ensureFolder(app, folder);
  const arr = toArrayBuffer(buffer);
  if (app.vault && typeof app.vault.createBinary === 'function' && !app.vault.getAbstractFileByPath(normalized)) {
    return app.vault.createBinary(normalized, arr);
  }
  if (app.vault && app.vault.adapter && typeof app.vault.adapter.writeBinary === 'function') {
    return app.vault.adapter.writeBinary(normalized, arr);
  }
  throw new Error('Binary write is not available');
}

async function ensureFolder(app, folderPath) {
  const clean = normalizePath(folderPath || '');
  if (!clean) return;
  const parts = clean.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? current + '/' + part : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}

async function uniquePath(app, targetPath) {
  const normalized = normalizePath(targetPath);
  if (!app.vault.getAbstractFileByPath(normalized)) return normalized;
  const slash = normalized.lastIndexOf('/');
  const folder = slash >= 0 ? normalized.substring(0, slash + 1) : '';
  const file = slash >= 0 ? normalized.substring(slash + 1) : normalized;
  const dot = file.lastIndexOf('.');
  const base = dot >= 0 ? file.substring(0, dot) : file;
  const ext = dot >= 0 ? file.substring(dot) : '';
  let i = 2;
  let candidate = folder + base + ' ' + i + ext;
  while (app.vault.getAbstractFileByPath(candidate)) {
    i++;
    candidate = folder + base + ' ' + i + ext;
  }
  return candidate;
}

function safePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(p => p && p !== '.' && p !== '..' && !p.includes(':'))
    .map(sanitize)
    .filter(Boolean)
    .join('/');
}

function sanitize(value) {
  return String(value || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    new Notice('Copied');
  } catch (e) {
    new Notice('Could not copy');
  }
}

function messageOf(e) {
  return e && e.message ? e.message : String(e);
}
