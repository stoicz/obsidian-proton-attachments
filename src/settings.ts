export type PasswordMode = "per-file" | "fixed" | "none";

export interface ProtonAttachmentsSettings {
	binaryPath: string;
	remoteRoot: string;
	mirrorVaultPath: boolean;
	passwordMode: PasswordMode;
	fixedPassword: string;
	passwordLength: number;
	expirationDays: number;
	insertAsEmbed: boolean;
}

export const DEFAULT_SETTINGS: ProtonAttachmentsSettings = {
	binaryPath: "proton-drive",
	remoteRoot: "/my-files",
	mirrorVaultPath: true,
	passwordMode: "per-file",
	fixedPassword: "",
	passwordLength: 20,
	expirationDays: 0,
	insertAsEmbed: false,
};