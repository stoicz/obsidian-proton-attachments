import {
	App,
	Editor,
	ItemView,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
} from "obsidian";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { shell } from "electron";
import { ProtonDriveCLI, ProtonNode, ProtonDriveError } from "./proton";
import { ProtonAttachmentsSettings, DEFAULT_SETTINGS, PasswordMode } from "./settings";

const VIEW_TYPE = "proton-attachments-view";

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace a snippet at the cursor and move the caret past its last line. */
function insertWithCursorAfter(editor: Editor, snippet: string) {
	const from = editor.getCursor();
	editor.replaceRange(snippet, from);
	const lines = snippet.split("\n");
	editor.setCursor({
		line: from.line + lines.length - 1,
		ch: from.ch + lines[lines.length - 1].length,
	});
}

export default class ProtonAttachmentsPlugin extends Plugin {
	settings: ProtonAttachmentsSettings;
	cli: ProtonDriveCLI;
	lastMarkdownView?: MarkdownView;

	async onload() {
		await this.loadSettings();
		this.cli = new ProtonDriveCLI(this.settings.binaryPath);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView) this.lastMarkdownView = view;
			})
		);

		this.addCommand({
			id: "upload-file-insert-link",
			name: "Upload a file and insert link",
			checkCallback: (checking: boolean) => {
				if (this.app.workspace.getActiveViewOfType(MarkdownView)) {
					if (!checking) void this.uploadAndInsert();
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "open-proton-attachments-view",
			name: "Open Proton Attachments view",
			callback: () => {
				void this.activateView();
			},
		});

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new ProtonAttachmentsView(leaf, this));

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

	errorMessage(e: unknown): string {
		if (e instanceof Error) return e.message;
		return String(e);
	}

	async loginWithBrowser(): Promise<boolean> {
		if (await this.cli.isLoggedIn()) return true;

		let child: ChildProcess | undefined;
		const done = (ok: boolean): boolean => {
			if (child) {
				try {
					child.kill();
				} catch {
					// already exited
				}
			}
			return ok;
		};

		child = this.cli.startBrowserLogin(
			(url) => {
				void shell.openExternal(url).catch(() => {
					// Fall back to printing the URL so the user can open it manually.
					new Notice(`Open this link to sign in: ${url}`, 20000);
				});
			},
			(err) => {
				this.logError(err);
				new Notice(`Could not start proton-drive sign-in: ${this.errorMessage(err)}`);
			}
		);

		new Notice("Proton Attachments: opening sign-in in your browser...");
		const start = Date.now();
		// Poll until signed in or timed out (4 minutes, like the CLI).
		while (Date.now() - start < 4 * 60 * 1000) {
			if (await this.cli.isLoggedIn()) {
				new Notice("Signed in to Proton Drive.");
				return done(true);
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
		new Notice("Proton Attachments: sign-in timed out.");
		return done(false);
	}

	async signOut(): Promise<void> {
		try {
			await this.cli.signOut();
		} catch (e) {
			this.logError(e);
			new Notice(`Sign out failed: ${this.errorMessage(e)}`);
		}
	}

	logError(e: unknown) {
		console.error("Proton Attachments:", e);
		if (e instanceof ProtonDriveError) {
			console.error(e.stdout);
		}
	}

	private randomPassword(length: number): string {
		const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
		const bytes = new Uint8Array(length);
		crypto.getRandomValues(bytes);
		let out = "";
		for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
		return out;
	}

	private isoDateInDays(days: number): string {
		const d = new Date();
		d.setDate(d.getDate() + days);
		return d.toISOString().split("T")[0];
	}

	linkPassword(): string | undefined {
		if (this.settings.passwordMode === "per-file") return this.randomPassword(this.settings.passwordLength);
		if (this.settings.passwordMode === "fixed") return this.settings.fixedPassword || undefined;
		return undefined;
	}

	linkExpiration(): string | undefined {
		return this.settings.expirationDays > 0 ? this.isoDateInDays(this.settings.expirationDays) : undefined;
	}

	linkMarkdown(fileName: string, url: string, password?: string): string {
		const link = this.settings.insertAsEmbed
			? `![](${url})`
			: `[${fileName.replace(/\.[^.]+$/, "")}](${url})`;
		const codeSpan = password
			? `\`password: ${password}\``
			: "`password: n/a`";
		return `${link}\n${codeSpan}`;
	}

	joinRemote(base: string, sub: string): string {
		const b = base.replace(/\/+$/, "");
		if (!sub) return b;
		const s = sub.replace(/^\/+|\/+$/g, "");
		return `${b}/${s}`;
	}

	private remoteFolderFor(noteDir: string): string {
		if (this.settings.mirrorVaultPath && noteDir) {
			return this.joinRemote(this.settings.remoteRoot, noteDir);
		}
		return this.settings.remoteRoot;
	}

	private async ensureRemoteFolder(folder: string): Promise<string> {
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

	private async nextRemoteName(folder: string, base: string, ext: string): Promise<{ name: string; index: number }> {
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

	private async uploadAndInsert() {
		if (!(await this.cli.isLoggedIn())) {
			new Notice("Proton Attachments: not signed in. Open Settings → Proton Attachments → Sign in.");
			return;
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		const note = view.file;
		if (!note) return;

		const localFile = await this.pickLocalFile();
		if (!localFile) return;

		const noteDir = note.parent ? note.parent.path : "";
		const noteBase = note.basename;
		const folder = this.remoteFolderFor(noteDir);

		new Notice(`Uploading ${localFile.name} to Proton "${folder}"...`);

		try {
			const remoteFolder = await this.ensureRemoteFolder(folder);

			// Snapshot existing remote files so we can recognise the one this
			// upload added even if the CLI auto-renamed or we used a temp copy.
			const beforeNames = new Set<string>();
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
			const url = share.urlAccess?.url;
			if (!url) throw new Error("No share link was returned by Proton Drive.");

			await this.insertLinkIntoNote(targetName, url, password);
			new Notice(`Uploaded ${targetName} (${index}) and inserted link.`);
		} catch (e) {
			this.logError(e);
			new Notice(`Proton Attachments failed: ${this.errorMessage(e)}`);
		}
	}

	/**
	 * Opens a native file picker. Returns the absolute path and the original
	 * file name. In newer Electron the path is recovered via webUtils; if that
	 * is unavailable the file is copied to a unique temp file and its path
	 * returned there.
	 */
	private pickLocalFile(): Promise<{ absPath: string; name: string } | null> {
		return new Promise((resolve) => {
			const input = document.createElement("input");
			input.type = "file";
			input.addEventListener("change", () => {
				const file = input.files?.[0];
				if (!file) {
					resolve(null);
					return;
				}
				void this.absolutePathOf(file)
					.then((absPath) => resolve(absPath ? { absPath, name: file.name } : null))
					.catch(() => {
						this.logError("Could not resolve the selected file.");
						resolve(null);
					});
			});
			input.click();
		});
	}

	private async absolutePathOf(file: File): Promise<string | undefined> {
		try {
			const req = (window as unknown as { require?: (m: string) => unknown }).require;
			if (typeof req === "function") {
				const { webUtils } = req("electron") as {
					webUtils?: { getPathForFile: (f: File) => string };
				};
				if (webUtils?.getPathForFile) {
					const p = webUtils.getPathForFile(file);
					if (p) return p;
				}
			}
		} catch {
			// fall through to the legacy/temp approaches
		}
		const legacy = (file as unknown as { path?: string }).path;
		if (legacy) return legacy;
		const abs = path.join(os.tmpdir(), `proton-att-${Date.now()}-${file.name}`);
		let target = abs;
		let i = 1;
		while (fs.existsSync(target)) target = `${abs}-${i++}`;
		await fs.promises.writeFile(target, Buffer.from(await file.arrayBuffer()));
		return target;
	}

	private splitFileExtension(fileName: string): { base: string; ext: string } {
		const dot = fileName.lastIndexOf(".");
		return dot > 0
			? { base: fileName.slice(0, dot), ext: fileName.slice(dot + 1) }
			: { base: fileName, ext: "" };
	}

	private async findRemoteFile(folder: string, name: string): Promise<ProtonNode | undefined> {
		const children = await this.cli.listFiles(folder);
		return children.find((n) => n.type === "file" && n.name.ok && n.name.value === name);
	}

	private async findRemoteFileByPrefix(folder: string, prefix: string): Promise<ProtonNode | undefined> {
		const children = await this.cli.listFiles(folder);
		const matches = children.filter(
			(n) =>
				n.type === "file" &&
				n.name.ok &&
				n.name.value &&
				n.name.value.toLowerCase().startsWith(prefix.toLowerCase())
		);
		return matches[matches.length - 1];
	}

	private async findNewRemoteFile(folder: string, beforeNames: Set<string>): Promise<ProtonNode | undefined> {
		const children = await this.cli.listFiles(folder);
		return children.find(
			(n) => n.type === "file" && n.name.ok && n.name.value && !beforeNames.has(n.name.value)
		);
	}

	private async insertLinkIntoNote(fileName: string, url: string, password?: string) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		insertWithCursorAfter(view.editor, `\n${this.linkMarkdown(fileName, url, password)}\n`);
	}

	private async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}
}

class ProtonAttachmentsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ProtonAttachmentsPlugin
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Proton Attachments" });

		const account = new Setting(containerEl)
			.setName("Proton account")
			.setDesc("Checking sign-in state…");
		const signInBtn = account.addButton((b) =>
			b.setButtonText("Sign in").onClick(async () => {
				const ok = await this.plugin.loginWithBrowser();
				if (ok) this.display();
			})
		);
		account.addButton((b) =>
			b.setButtonText("Sign out").onClick(async () => {
				await this.plugin.signOut();
				this.display();
			})
		);
		void this.plugin.cli.isLoggedIn().then((ok) => {
			signInBtn.setDisabled(ok);
			account.setDesc(
				ok
					? "Signed in as your Proton Drive user."
					: "Not signed in. Click “Sign in” to log in via your browser (or run `proton-drive auth login` in a terminal)."
			);
		});

		new Setting(containerEl)
			.setName("proton-drive binary path")
			.setDesc("Path to the proton-drive CLI. Leave default if it is on your PATH.")
			.addText((text) =>
				text
					.setPlaceholder("proton-drive")
					.setValue(this.plugin.settings.binaryPath)
					.onChange(async (value) => {
						this.plugin.settings.binaryPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Remote root folder")
			.setDesc("Base folder in Proton Drive used for uploaded files.")
			.addText((text) =>
				text
					.setPlaceholder("/my-files")
					.setValue(this.plugin.settings.remoteRoot)
					.onChange(async (value) => {
						this.plugin.settings.remoteRoot = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Mirror vault path")
			.setDesc(
				this.plugin.settings.mirrorVaultPath
					? "Files upload to the folder that mirrors the note's vault path."
					: "All files upload directly to the remote root folder."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.mirrorVaultPath)
					.onChange(async (value) => {
						this.plugin.settings.mirrorVaultPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Link password mode")
			.setDesc(
				this.plugin.settings.passwordMode === "per-file"
					? "A random password is generated for each link."
					: this.plugin.settings.passwordMode === "fixed"
						? "Every link uses the fixed password below."
						: "Links are created without a password."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("per-file", "Random per file (recommended)")
					.addOption("fixed", "Fixed password")
					.addOption("none", "No password")
					.setValue(this.plugin.settings.passwordMode)
					.onChange(async (value: PasswordMode) => {
						this.plugin.settings.passwordMode = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.passwordMode === "fixed") {
			new Setting(containerEl)
				.setName("Fixed password")
				.addText((text) =>
					text
						.setPlaceholder("your fixed password")
						.setValue(this.plugin.settings.fixedPassword)
						.onChange(async (value) => {
							this.plugin.settings.fixedPassword = value;
							await this.plugin.saveSettings();
						})
				);
		}

		if (this.plugin.settings.passwordMode === "per-file") {
			new Setting(containerEl)
				.setName("Password length")
				.setDesc("Length of generated passwords.")
				.addText((text) =>
					text
						.setValue(String(this.plugin.settings.passwordLength))
						.onChange(async (value) => {
							const n = parseInt(value, 10);
							this.plugin.settings.passwordLength = Number.isFinite(n) && n > 0 ? n : 20;
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Link expiration (days)")
			.setDesc("0 = never expires.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.expirationDays))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.expirationDays = Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Insert as image embed")
			.setDesc("If off, links are inserted as [name](url).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.insertAsEmbed)
					.onChange(async (value) => {
						this.plugin.settings.insertAsEmbed = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

class ProtonAttachmentsView extends ItemView {
	private currentPath: string;
	private searchValue = "";
	private lastInsertClick = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ProtonAttachmentsPlugin
	) {
		super(leaf);
		this.currentPath = this.plugin.settings.remoteRoot;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
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
			cls: "proton-attachments-search",
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
				if (!(await this.plugin.cli.isLoggedIn())) {
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
					if (a.type !== b.type) {
						return a.type === "folder" ? -1 : 1;
					}
					const na = (a.name.ok ? a.name.value ?? "" : "").toLowerCase();
					const nb = (b.name.ok ? b.name.value ?? "" : "").toLowerCase();
					return na < nb ? -1 : na > nb ? 1 : 0;
				});
				let count = 0;
				for (const n of foldersFirst) {
					if (!n.name.ok || !n.name.value) continue;
					if (!n.name.value.toLowerCase().includes(q)) continue;
					count++;
					const row = listEl.createEl("div", {
						text: (n.type === "folder" ? "📁 " : "") + n.name.value,
						cls: "proton-attachments-item",
					});
					if (n.type === "folder") {
						row.addEventListener("click", (ev: MouseEvent) => {
							ev.stopPropagation();
							this.currentPath = this.plugin.joinRemote(this.currentPath, n.name.value as string);
							this.searchValue = "";
							search.value = "";
							breadcrumb.setText(this.currentPath);
							void load();
						});
					} else {
						row.addEventListener("click", (ev: MouseEvent) => {
							ev.stopPropagation();
							const now = Date.now();
							if (now - this.lastInsertClick < 500) return;
							this.lastInsertClick = now;
							// Insert into the last note the user was editing, not
							// the sidebar leaf that got activated by this click.
							const editor = this.plugin.lastMarkdownView?.editor;
							if (!editor) {
								new Notice("Open a note first to insert the link into.");
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
			const target = e.target as HTMLElement;
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
			const path = breadcrumb.textContent ?? "";
			if (path) {
				this.currentPath = path;
				this.searchValue = "";
				search.value = "";
				void load();
			}
		});

		await load();
	}

	private async insertCloudFileLink(node: ProtonNode, editor: Editor) {
		if (!node.name.ok || !node.name.value) {
			new Notice("Could not read encrypted file name.");
			return;
		}
		const remotePath = `${this.currentPath}/${node.name.value}`;
		try {
			const status = await this.plugin.cli.getShareStatus(remotePath);
			const existing = status.urlAccess;

			let url = existing?.url;
			let password: string | undefined;

			if (url) {
				password = existing?.customPassword;
				if (!password) {
					password = this.plugin.linkPassword();
					if (password) {
						const share = await this.plugin.cli.createShareLink(remotePath, {
							password,
							expiration: this.plugin.linkExpiration(),
						});
						url = share.urlAccess?.url;
					}
				}
			} else {
				password = this.plugin.linkPassword();
				const share = await this.plugin.cli.createShareLink(remotePath, {
					password,
					expiration: password ? this.plugin.linkExpiration() : undefined,
				});
				url = share.urlAccess?.url;
			}

			if (!url) throw new Error("No share link returned.");
			insertWithCursorAfter(editor, `\n${this.plugin.linkMarkdown(node.name.value, url, password)}\n`);
		} catch (e) {
			this.plugin.logError(e);
			new Notice(`Failed: ${this.plugin.errorMessage(e)}`);
		}
	}

	async onClose() {
		this.contentEl.empty();
	}
}