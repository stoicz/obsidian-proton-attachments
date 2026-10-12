var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ProtonAttachmentsPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var import_electron = require("electron");

// src/proton.ts
var import_child_process = require("child_process");
var ProtonDriveError = class extends Error {
  constructor(message, args, stdout, stderr) {
    super(`${message}
  $ proton-drive ${args.join(" ")}
  ${stderr.trim()}`);
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
  }
};
var ProtonDriveCLI = class {
  constructor(binary = "proton-drive") {
    this.binary = binary;
  }
  run(args, json = true) {
    return new Promise((resolve, reject) => {
      if (json) args.push("--json");
      (0, import_child_process.execFile)(this.binary, args, { timeout: 12e4, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new ProtonDriveError(`proton-drive failed`, args, stdout, stderr));
          return;
        }
        resolve(stdout);
      });
    });
  }
  async isLoggedIn() {
    try {
      await this.run(["filesystem", "list", "/my-files"], false);
      return true;
    } catch (e) {
      return false;
    }
  }
  /**
   * Spawns `proton-drive auth login`, which opens a browser and blocks until
   * sign-in completes. `onUrl` receives the sign-in URL as soon as it is
   * printed, so the caller can open it (e.g. in an external browser). Kill the
   * returned process once login is confirmed.
   */
  startBrowserLogin(onUrl, onError) {
    var _a, _b;
    const child = (0, import_child_process.spawn)(this.binary, ["auth", "login"]);
    let fired = false;
    const handle = (chunk) => {
      const m = chunk.toString().match(/https:\/\/[^\s\x1b]+/);
      if (!fired && m) {
        fired = true;
        onUrl(m[0]);
      }
    };
    (_a = child.stdout) == null ? void 0 : _a.on("data", handle);
    (_b = child.stderr) == null ? void 0 : _b.on("data", handle);
    child.on("error", onError);
    return child;
  }
  async signOut() {
    await this.run(["auth", "logout"]);
  }
  async listFiles(remotePath) {
    const out = await this.run(["filesystem", "list", remotePath]);
    return JSON.parse(out);
  }
  async createFolder(parentPath, name) {
    await this.run(["filesystem", "create-folder", parentPath, name], false);
  }
  async renameFile(remotePath, newName) {
    await this.run(["filesystem", "rename", remotePath, newName], false);
  }
  async upload(localPaths, remoteParent) {
    const out = await this.run([
      "filesystem",
      "upload",
      "-f",
      "rename",
      "-d",
      "merge",
      "-t",
      ...localPaths,
      remoteParent
    ]);
    return JSON.parse(out);
  }
  async createShareLink(remotePath, opts = {}) {
    const args = ["sharing", "set-url"];
    if (opts.role) args.push("--role", opts.role);
    if (opts.password) args.push("--password", opts.password);
    if (opts.expiration) args.push("--expiration", opts.expiration);
    args.push(remotePath);
    const out = await this.run(args);
    return JSON.parse(out);
  }
  async getShareStatus(remotePath) {
    const out = await this.run(["sharing", "status", remotePath]);
    return JSON.parse(out);
  }
};

// src/settings.ts
var DEFAULT_SETTINGS = {
  binaryPath: "proton-drive",
  remoteRoot: "/my-files",
  mirrorVaultPath: true,
  passwordMode: "per-file",
  fixedPassword: "",
  passwordLength: 20,
  expirationDays: 0,
  insertAsEmbed: false
};

// src/main.ts
var VIEW_TYPE = "proton-attachments-view";
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function insertWithCursorAfter(editor, snippet) {
  const from = editor.getCursor();
  editor.replaceRange(snippet, from);
  const lines = snippet.split("\n");
  editor.setCursor({
    line: from.line + lines.length - 1,
    ch: from.ch + lines[lines.length - 1].length
  });
}
var ProtonAttachmentsPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.cli = new ProtonDriveCLI(this.settings.binaryPath);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf == null ? void 0 : leaf.view;
        if (view instanceof import_obsidian.MarkdownView) this.lastMarkdownView = view;
      })
    );
    this.addCommand({
      id: "upload-file-insert-link",
      name: "Upload a file and insert link",
      checkCallback: (checking) => {
        if (this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView)) {
          if (!checking) void this.uploadAndInsert();
          return true;
        }
        return false;
      }
    });
    this.addCommand({
      id: "open-proton-attachments-view",
      name: "Open Proton Attachments view",
      callback: () => {
        void this.activateView();
      }
    });
    this.registerView(VIEW_TYPE, (leaf) => new ProtonAttachmentsView(leaf, this));
    this.addRibbonIcon("cloud-upload", "Proton Attachments", () => {
      void this.uploadAndInsert();
    });
    this.addSettingTab(new ProtonAttachmentsSettingTab(this.app, this));
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  errorMessage(e) {
    if (e instanceof Error) return e.message;
    return String(e);
  }
  async loginWithBrowser() {
    if (await this.cli.isLoggedIn()) return true;
    let child;
    const done = (ok) => {
      if (child) {
        try {
          child.kill();
        } catch (e) {
        }
      }
      return ok;
    };
    child = this.cli.startBrowserLogin(
      (url) => {
        void import_electron.shell.openExternal(url).catch(() => {
          new import_obsidian.Notice(`Open this link to sign in: ${url}`, 2e4);
        });
      },
      (err) => {
        this.logError(err);
        new import_obsidian.Notice(`Could not start proton-drive sign-in: ${this.errorMessage(err)}`);
      }
    );
    new import_obsidian.Notice("Proton Attachments: opening sign-in in your browser...");
    const start = Date.now();
    while (Date.now() - start < 4 * 60 * 1e3) {
      if (await this.cli.isLoggedIn()) {
        new import_obsidian.Notice("Signed in to Proton Drive.");
        return done(true);
      }
      await new Promise((r) => setTimeout(r, 2e3));
    }
    new import_obsidian.Notice("Proton Attachments: sign-in timed out.");
    return done(false);
  }
  async signOut() {
    try {
      await this.cli.signOut();
    } catch (e) {
      this.logError(e);
      new import_obsidian.Notice(`Sign out failed: ${this.errorMessage(e)}`);
    }
  }
  logError(e) {
    console.error("Proton Attachments:", e);
    if (e instanceof ProtonDriveError) {
      console.error(e.stdout);
    }
  }
  randomPassword(length) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }
  isoDateInDays(days) {
    const d = /* @__PURE__ */ new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  }
  linkPassword() {
    if (this.settings.passwordMode === "per-file") return this.randomPassword(this.settings.passwordLength);
    if (this.settings.passwordMode === "fixed") return this.settings.fixedPassword || void 0;
    return void 0;
  }
  linkExpiration() {
    return this.settings.expirationDays > 0 ? this.isoDateInDays(this.settings.expirationDays) : void 0;
  }
  linkMarkdown(fileName, url, password) {
    const link = this.settings.insertAsEmbed ? `![](${url})` : `[${fileName.replace(/\.[^.]+$/, "")}](${url})`;
    const codeSpan = password ? `\`password: ${password}\`` : "`password: n/a`";
    return `${link}
${codeSpan}`;
  }
  joinRemote(base, sub) {
    const b = base.replace(/\/+$/, "");
    if (!sub) return b;
    const s = sub.replace(/^\/+|\/+$/g, "");
    return `${b}/${s}`;
  }
  remoteFolderFor(noteDir) {
    if (this.settings.mirrorVaultPath && noteDir) {
      return this.joinRemote(this.settings.remoteRoot, noteDir);
    }
    return this.settings.remoteRoot;
  }
  async ensureRemoteFolder(folder) {
    const root = this.settings.remoteRoot;
    const segments = folder.slice(root.length).split("/").filter((p) => p.length > 0 && p !== root);
    let current = root;
    for (const seg of segments) {
      const children = await this.cli.listFiles(current);
      const exists = children.some(
        (n) => n.type === "folder" && n.name.ok && n.name.value === seg
      );
      if (!exists) {
        await this.cli.createFolder(current, seg);
      }
      current = this.joinRemote(current, seg);
    }
    return current;
  }
  async nextRemoteName(folder, base, ext) {
    const children = await this.cli.listFiles(folder);
    const re = new RegExp(`^${escapeRegex(base)}-(\\d+)\\.${escapeRegex(ext)}$`);
    let max = 0;
    for (const n of children) {
      if (n.type !== "file" || !n.name.ok || !n.name.value) continue;
      const m = n.name.value.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return { name: `${base}-${max + 1}.${ext}`, index: max + 1 };
  }
  async uploadAndInsert() {
    var _a;
    if (!await this.cli.isLoggedIn()) {
      new import_obsidian.Notice("Proton Attachments: not signed in. Open Settings \u2192 Proton Attachments \u2192 Sign in.");
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) return;
    const note = view.file;
    if (!note) return;
    const localFile = await this.pickLocalFile();
    if (!localFile) return;
    const noteDir = note.parent ? note.parent.path : "";
    const noteBase = note.basename;
    const folder = this.remoteFolderFor(noteDir);
    new import_obsidian.Notice(`Uploading ${localFile.name} to Proton "${folder}"...`);
    try {
      const remoteFolder = await this.ensureRemoteFolder(folder);
      const beforeNames = /* @__PURE__ */ new Set();
      for (const n of await this.cli.listFiles(remoteFolder)) {
        if (n.type === "file" && n.name.ok && n.name.value) beforeNames.add(n.name.value);
      }
      const result = await this.cli.upload([localFile.absPath], remoteFolder);
      if (result.failedItems > 0) {
        throw new Error("Upload failed on the Proton side.");
      }
      const { base, ext } = this.splitFileExtension(localFile.name);
      const { name: targetName, index } = await this.nextRemoteName(remoteFolder, noteBase, ext);
      let node = await this.findRemoteFile(remoteFolder, targetName);
      if (!node) node = await this.findRemoteFile(remoteFolder, localFile.name);
      if (!node) node = await this.findRemoteFileByPrefix(remoteFolder, base);
      if (!node) node = await this.findNewRemoteFile(remoteFolder, beforeNames);
      if (!node) {
        throw new Error(`No file found on Proton after upload in "${remoteFolder}".`);
      }
      if (node.name.ok && node.name.value !== targetName) {
        await this.cli.renameFile(`${remoteFolder}/${node.name.value}`, targetName);
        node = await this.findRemoteFile(remoteFolder, targetName);
        if (!node) throw new Error("Uploaded file could not be renamed.");
      }
      const remotePath = `${remoteFolder}/${targetName}`;
      const expiration = this.linkExpiration();
      const password = this.linkPassword();
      const share = await this.cli.createShareLink(remotePath, { password, expiration });
      const url = (_a = share.urlAccess) == null ? void 0 : _a.url;
      if (!url) throw new Error("No share link was returned by Proton Drive.");
      await this.insertLinkIntoNote(targetName, url, password);
      new import_obsidian.Notice(`Uploaded ${targetName} (${index}) and inserted link.`);
    } catch (e) {
      this.logError(e);
      new import_obsidian.Notice(`Proton Attachments failed: ${this.errorMessage(e)}`);
    }
  }
  /**
   * Opens a native file picker. Returns the absolute path and the original
   * file name. In newer Electron the path is recovered via webUtils; if that
   * is unavailable the file is copied to a unique temp file and its path
   * returned there.
   */
  pickLocalFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.addEventListener("change", () => {
        var _a;
        const file = (_a = input.files) == null ? void 0 : _a[0];
        if (!file) {
          resolve(null);
          return;
        }
        void this.absolutePathOf(file).then((absPath) => resolve(absPath ? { absPath, name: file.name } : null)).catch(() => {
          this.logError("Could not resolve the selected file.");
          resolve(null);
        });
      });
      input.click();
    });
  }
  async absolutePathOf(file) {
    try {
      const req = window.require;
      if (typeof req === "function") {
        const { webUtils } = req("electron");
        if (webUtils == null ? void 0 : webUtils.getPathForFile) {
          const p = webUtils.getPathForFile(file);
          if (p) return p;
        }
      }
    } catch (e) {
    }
    const legacy = file.path;
    if (legacy) return legacy;
    const abs = path.join(os.tmpdir(), `proton-att-${Date.now()}-${file.name}`);
    let target = abs;
    let i = 1;
    while (fs.existsSync(target)) target = `${abs}-${i++}`;
    await fs.promises.writeFile(target, Buffer.from(await file.arrayBuffer()));
    return target;
  }
  splitFileExtension(fileName) {
    const dot = fileName.lastIndexOf(".");
    return dot > 0 ? { base: fileName.slice(0, dot), ext: fileName.slice(dot + 1) } : { base: fileName, ext: "" };
  }
  async findRemoteFile(folder, name) {
    const children = await this.cli.listFiles(folder);
    return children.find((n) => n.type === "file" && n.name.ok && n.name.value === name);
  }
  async findRemoteFileByPrefix(folder, prefix) {
    const children = await this.cli.listFiles(folder);
    const matches = children.filter(
      (n) => n.type === "file" && n.name.ok && n.name.value && n.name.value.toLowerCase().startsWith(prefix.toLowerCase())
    );
    return matches[matches.length - 1];
  }
  async findNewRemoteFile(folder, beforeNames) {
    const children = await this.cli.listFiles(folder);
    return children.find(
      (n) => n.type === "file" && n.name.ok && n.name.value && !beforeNames.has(n.name.value)
    );
  }
  async insertLinkIntoNote(fileName, url, password) {
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) return;
    insertWithCursorAfter(view.editor, `
${this.linkMarkdown(fileName, url, password)}
`);
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }
};
var ProtonAttachmentsSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Proton Attachments" });
    const account = new import_obsidian.Setting(containerEl).setName("Proton account").setDesc("Checking sign-in state\u2026");
    const signInBtn = account.addButton(
      (b) => b.setButtonText("Sign in").onClick(async () => {
        const ok = await this.plugin.loginWithBrowser();
        if (ok) this.display();
      })
    );
    account.addButton(
      (b) => b.setButtonText("Sign out").onClick(async () => {
        await this.plugin.signOut();
        this.display();
      })
    );
    void this.plugin.cli.isLoggedIn().then((ok) => {
      signInBtn.setDisabled(ok);
      account.setDesc(
        ok ? "Signed in as your Proton Drive user." : "Not signed in. Click \u201CSign in\u201D to log in via your browser (or run `proton-drive auth login` in a terminal)."
      );
    });
    new import_obsidian.Setting(containerEl).setName("proton-drive binary path").setDesc("Path to the proton-drive CLI. Leave default if it is on your PATH.").addText(
      (text) => text.setPlaceholder("proton-drive").setValue(this.plugin.settings.binaryPath).onChange(async (value) => {
        this.plugin.settings.binaryPath = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Remote root folder").setDesc("Base folder in Proton Drive used for uploaded files.").addText(
      (text) => text.setPlaceholder("/my-files").setValue(this.plugin.settings.remoteRoot).onChange(async (value) => {
        this.plugin.settings.remoteRoot = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Mirror vault path").setDesc(
      this.plugin.settings.mirrorVaultPath ? "Files upload to the folder that mirrors the note's vault path." : "All files upload directly to the remote root folder."
    ).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.mirrorVaultPath).onChange(async (value) => {
        this.plugin.settings.mirrorVaultPath = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Link password mode").setDesc(
      this.plugin.settings.passwordMode === "per-file" ? "A random password is generated for each link." : this.plugin.settings.passwordMode === "fixed" ? "Every link uses the fixed password below." : "Links are created without a password."
    ).addDropdown(
      (dropdown) => dropdown.addOption("per-file", "Random per file (recommended)").addOption("fixed", "Fixed password").addOption("none", "No password").setValue(this.plugin.settings.passwordMode).onChange(async (value) => {
        this.plugin.settings.passwordMode = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (this.plugin.settings.passwordMode === "fixed") {
      new import_obsidian.Setting(containerEl).setName("Fixed password").addText(
        (text) => text.setPlaceholder("your fixed password").setValue(this.plugin.settings.fixedPassword).onChange(async (value) => {
          this.plugin.settings.fixedPassword = value;
          await this.plugin.saveSettings();
        })
      );
    }
    if (this.plugin.settings.passwordMode === "per-file") {
      new import_obsidian.Setting(containerEl).setName("Password length").setDesc("Length of generated passwords.").addText(
        (text) => text.setValue(String(this.plugin.settings.passwordLength)).onChange(async (value) => {
          const n = parseInt(value, 10);
          this.plugin.settings.passwordLength = Number.isFinite(n) && n > 0 ? n : 20;
          await this.plugin.saveSettings();
        })
      );
    }
    new import_obsidian.Setting(containerEl).setName("Link expiration (days)").setDesc("0 = never expires.").addText(
      (text) => text.setValue(String(this.plugin.settings.expirationDays)).onChange(async (value) => {
        const n = parseInt(value, 10);
        this.plugin.settings.expirationDays = Number.isFinite(n) && n >= 0 ? n : 0;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Insert as image embed").setDesc("If off, links are inserted as [name](url).").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.insertAsEmbed).onChange(async (value) => {
        this.plugin.settings.insertAsEmbed = value;
        await this.plugin.saveSettings();
      })
    );
  }
};
var ProtonAttachmentsView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.searchValue = "";
    this.lastInsertClick = 0;
    this.currentPath = this.plugin.settings.remoteRoot;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Proton Attachments";
  }
  async onOpen() {
    await this.render();
  }
  async render() {
    const container = this.contentEl;
    container.empty();
    const search = container.createEl("input", {
      type: "text",
      placeholder: "Search in this folder...",
      cls: "proton-attachments-search"
    });
    search.value = this.searchValue;
    const breadcrumb = container.createEl("div", { text: this.currentPath, cls: "proton-attachments-breadcrumb" });
    const actions = container.createEl("div");
    const upBtn = actions.createEl("button", { text: "Up" });
    upBtn.style.marginRight = "4px";
    actions.createEl("button", { text: "Root" });
    const refreshBtn = actions.createEl("button", { text: "Refresh" });
    refreshBtn.style.marginLeft = "4px";
    const listEl = container.createEl("div", { cls: "proton-attachments-list" });
    const goUp = () => {
      const parts = this.currentPath.split("/").filter((p) => p.length > 0);
      parts.pop();
      this.currentPath = parts.length > 0 ? "/" + parts.join("/") : this.plugin.settings.remoteRoot;
    };
    const load = async () => {
      listEl.empty();
      listEl.createEl("div", { text: "Loading...", cls: "proton-attachments-empty" });
      try {
        if (!await this.plugin.cli.isLoggedIn()) {
          listEl.empty();
          listEl.createEl("div", { text: "Not signed in to Proton Drive.", cls: "proton-attachments-empty" });
          const signIn = listEl.createEl("button", { text: "Sign in" });
          signIn.addEventListener("click", () => {
            void this.plugin.loginWithBrowser().then((ok) => {
              if (ok) void load();
            });
          });
          return;
        }
        const nodes = await this.plugin.cli.listFiles(this.currentPath);
        listEl.empty();
        const q = this.searchValue.toLowerCase();
        const foldersFirst = [...nodes].sort((a, b) => {
          var _a, _b;
          if (a.type !== b.type) {
            return a.type === "folder" ? -1 : 1;
          }
          const na = (a.name.ok ? (_a = a.name.value) != null ? _a : "" : "").toLowerCase();
          const nb = (b.name.ok ? (_b = b.name.value) != null ? _b : "" : "").toLowerCase();
          return na < nb ? -1 : na > nb ? 1 : 0;
        });
        let count = 0;
        for (const n of foldersFirst) {
          if (!n.name.ok || !n.name.value) continue;
          if (!n.name.value.toLowerCase().includes(q)) continue;
          count++;
          const row = listEl.createEl("div", {
            text: (n.type === "folder" ? "\u{1F4C1} " : "") + n.name.value,
            cls: "proton-attachments-item"
          });
          if (n.type === "folder") {
            row.addEventListener("click", (ev) => {
              ev.stopPropagation();
              this.currentPath = this.plugin.joinRemote(this.currentPath, n.name.value);
              this.searchValue = "";
              search.value = "";
              breadcrumb.setText(this.currentPath);
              void load();
            });
          } else {
            row.addEventListener("click", (ev) => {
              var _a;
              ev.stopPropagation();
              const now = Date.now();
              if (now - this.lastInsertClick < 500) return;
              this.lastInsertClick = now;
              const editor = (_a = this.plugin.lastMarkdownView) == null ? void 0 : _a.editor;
              if (!editor) {
                new import_obsidian.Notice("Open a note first to insert the link into.");
                return;
              }
              void this.insertCloudFileLink(n, editor);
            });
          }
        }
        if (count === 0) {
          listEl.createEl("div", { text: "No items found.", cls: "proton-attachments-empty" });
        }
      } catch (e) {
        listEl.empty();
        listEl.createEl("div", { text: `Error: ${this.plugin.errorMessage(e)}`, cls: "proton-attachments-empty" });
      }
    };
    search.addEventListener("input", () => {
      this.searchValue = search.value;
      void load();
    });
    upBtn.addEventListener("click", () => {
      goUp();
      this.searchValue = "";
      search.value = "";
      breadcrumb.setText(this.currentPath);
      void load();
    });
    actions.addEventListener("click", (e) => {
      const target = e.target;
      if (target.tagName !== "BUTTON") return;
      if (target.textContent === "Root") {
        this.currentPath = this.plugin.settings.remoteRoot;
        this.searchValue = "";
        search.value = "";
        breadcrumb.setText(this.currentPath);
        void load();
      } else if (target.textContent === "Refresh") {
        void load();
      }
    });
    breadcrumb.addEventListener("click", async () => {
      var _a;
      const path2 = (_a = breadcrumb.textContent) != null ? _a : "";
      if (path2) {
        this.currentPath = path2;
        this.searchValue = "";
        search.value = "";
        void load();
      }
    });
    await load();
  }
  async insertCloudFileLink(node, editor) {
    var _a, _b;
    if (!node.name.ok || !node.name.value) {
      new import_obsidian.Notice("Could not read encrypted file name.");
      return;
    }
    const remotePath = `${this.currentPath}/${node.name.value}`;
    try {
      const status = await this.plugin.cli.getShareStatus(remotePath);
      const existing = status.urlAccess;
      let url = existing == null ? void 0 : existing.url;
      let password;
      if (url) {
        password = existing == null ? void 0 : existing.customPassword;
        if (!password) {
          password = this.plugin.linkPassword();
          if (password) {
            const share = await this.plugin.cli.createShareLink(remotePath, {
              password,
              expiration: this.plugin.linkExpiration()
            });
            url = (_a = share.urlAccess) == null ? void 0 : _a.url;
          }
        }
      } else {
        password = this.plugin.linkPassword();
        const share = await this.plugin.cli.createShareLink(remotePath, {
          password,
          expiration: password ? this.plugin.linkExpiration() : void 0
        });
        url = (_b = share.urlAccess) == null ? void 0 : _b.url;
      }
      if (!url) throw new Error("No share link returned.");
      insertWithCursorAfter(editor, `
${this.plugin.linkMarkdown(node.name.value, url, password)}
`);
    } catch (e) {
      this.plugin.logError(e);
      new import_obsidian.Notice(`Failed: ${this.plugin.errorMessage(e)}`);
    }
  }
  async onClose() {
    this.contentEl.empty();
  }
};
