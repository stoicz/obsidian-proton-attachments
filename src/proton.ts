import { execFile, spawn, ChildProcess } from "child_process";

export interface ProtonNode {
	uid: string;
	parentUid: string;
	type: "folder" | "file";
	name: { ok: boolean; value?: string };
	modificationTime?: string;
	isSharedByUrl?: boolean;
}

export interface UploadResult {
	transferredItems: number;
	transferredBytes: number;
	skippedItems: number;
	failedItems: number;
	failures: unknown[];
}

export interface ShareInfo {
	uid?: string;
	role?: string;
	url?: string;
	customPassword?: string;
	expirationTime?: string;
	creationTime?: string;
}

export interface ShareResult {
	protonInvitations: unknown[];
	nonProtonInvitations: unknown[];
	members: unknown[];
	urlAccess: ShareInfo | null;
	editorsCanShare: boolean;
}

export class ProtonDriveError extends Error {
	constructor(message: string, public readonly args: string[], public readonly stdout: string, public readonly stderr: string) {
		super(`${message}\n  $ proton-drive ${args.join(" ")}\n  ${stderr.trim()}`);
	}
}

export class ProtonDriveCLI {
	constructor(public readonly binary: string = "proton-drive") {}

	private run(args: string[], json = true): Promise<string> {
		return new Promise((resolve, reject) => {
			if (json) args.push("--json");
			execFile(this.binary, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) {
					reject(new ProtonDriveError(`proton-drive failed`, args, stdout, stderr));
					return;
				}
				resolve(stdout);
			});
		});
	}

	async isLoggedIn(): Promise<boolean> {
		try {
			await this.run(["filesystem", "list", "/my-files"], false);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Spawns `proton-drive auth login`, which opens a browser and blocks until
	 * sign-in completes. `onUrl` receives the sign-in URL as soon as it is
	 * printed, so the caller can open it (e.g. in an external browser). Kill the
	 * returned process once login is confirmed.
	 */
	startBrowserLogin(onUrl: (url: string) => void, onError: (err: Error) => void): ChildProcess {
		const child = spawn(this.binary, ["auth", "login"]);
		let fired = false;
		const handle = (chunk: Buffer) => {
			const m = chunk.toString().match(/https:\/\/[^\s\x1b]+/);
			if (!fired && m) {
				fired = true;
				onUrl(m[0]);
			}
		};
		child.stdout?.on("data", handle);
		child.stderr?.on("data", handle);
		child.on("error", onError);
		return child;
	}

	async signOut(): Promise<void> {
		await this.run(["auth", "logout"]);
	}

	async listFiles(remotePath: string): Promise<ProtonNode[]> {
		const out = await this.run(["filesystem", "list", remotePath]);
		return JSON.parse(out) as ProtonNode[];
	}

	async createFolder(parentPath: string, name: string): Promise<void> {
		await this.run(["filesystem", "create-folder", parentPath, name], false);
	}

	async renameFile(remotePath: string, newName: string): Promise<void> {
		await this.run(["filesystem", "rename", remotePath, newName], false);
	}

	async upload(localPaths: string[], remoteParent: string): Promise<UploadResult> {
		const out = await this.run([
			"filesystem", "upload",
			"-f", "rename",
			"-d", "merge",
			"-t",
			...localPaths,
			remoteParent,
		]);
		return JSON.parse(out) as UploadResult;
	}

	async createShareLink(
		remotePath: string,
		opts: { password?: string; expiration?: string; role?: "viewer" | "editor" } = {}
	): Promise<ShareResult> {
		const args = ["sharing", "set-url"];
		if (opts.role) args.push("--role", opts.role);
		if (opts.password) args.push("--password", opts.password);
		if (opts.expiration) args.push("--expiration", opts.expiration);
		args.push(remotePath);
		const out = await this.run(args);
		return JSON.parse(out) as ShareResult;
	}

	async getShareStatus(remotePath: string): Promise<ShareResult> {
		const out = await this.run(["sharing", "status", remotePath]);
		return JSON.parse(out) as ShareResult;
	}
}