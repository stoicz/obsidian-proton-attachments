# Proton Attachments

Upload heavy files from anywhere on your computer to [Proton Drive](https://proton.me/drive) and insert a secure, password-protected share link straight into the note you are editing — so your vault stays light and the files never need to sync to your phone.

- **Desktop only** (`isDesktopOnly: true`). Depends on the official [`proton-drive` CLI](https://proton.me/download/drive/cli/index.html).

## Features

- **Upload & insert link** — pick any file on your disk (native file dialog), upload it to Proton Drive, and insert `[name](url)` + a `password: …` code span at the cursor in your active note.
- **Sidebar browser** — browse your Proton Drive folders in a side panel and click any file to insert its link into the last note you were editing.
- **Vault-mirrored folders** — uploaded files land in a folder that mirrors your note's vault path under a configurable remote root, created on the fly.
- **Deduplicated names** — each upload is named `<note-basename>-<N>.<ext>` (e.g. `my-note-1.jpg`), even if you upload the same file again.
- **Per-link passwords** — random, unambiguous passwords per link, or one fixed password, or none.
- **Optional link expiration**.
- **Link embedding** — insert as Markdown embed `![](...)` for images instead of a named link.

## How it works

The plugin is a thin, type-safe wrapper around the official `proton-drive` CLI:

1. It shells out to `proton-drive filesystem upload`, `sharing set-url`, and `sharing status` (your CLI session handles all Proton authentication and end-to-end encryption).
2. It reads the share URL (and, when re-inserting a link for an already-shared file, the existing password) from the command output so re-inserts never rotate or clear the password set on a previous link.
3. It composes the Markdown link plus a `password: …` code span and inserts it at the editor cursor, moving the caret to the line below.

Because it goes through the official CLI, uploads are stored as normal Proton Drive files — fully end-to-end encrypted — and the share links use Proton's own, first-class sharing.

## Requirements

- Obsidian **1.5.0+** on Windows, macOS, or Linux.
- The [`proton-drive` CLI](https://proton.me/download/drive/cli/index.html) v0.5.0+ installed and on your `PATH` (or configured in the plugin settings).
- A Proton account with enough free space.

## Installation

Community catalog submission is in progress. Until then, install manually:

1. Download the latest release (`manifest.json`, `main.js`, `styles.css`).
2. Create the folder `.obsidian/plugins/obsidian-proton-attachments/` in your vault.
3. Copy the three files in there and **restart Obsidian**.
4. Enable **Proton Attachments** under *Settings → Community plugins → Installed plugins*.

Alternatively, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with this repository's URL.

### First run

After enabling:

1. Open *Settings → Proton Attachments*.
2. The **Proton account** row shows your sign-in state. Click **Sign in** to log in through your browser (this runs `proton-drive auth login` for you), or sign in manually in a terminal with:

   ```bash
   proton-drive auth login
   ```

## Usage

- **Upload a file and insert link** (command or ribbon icon): choose a file → it uploads and inserts:

  ```markdown
  [my-video](https://drive.proton.me/urls/XXXXXXXX#YYYY)
  `password: AbC123defGHJ456kLMn`

  ```

- **Open Proton Attachments view** (command): open the sidebar browser, navigate folders, click a file to insert its link into your last active note. Folder names are sorted alphabetically (folders first).

## Settings

| Setting | Description | Default |
| --- | --- | --- |
| proton-drive binary path | Path to the CLI if it is not on your `PATH`. | `proton-drive` |
| Remote root folder | Base folder in Proton Drive for uploads. | `/my-files` |
| Mirror vault path | Upload into a sub-folder mirroring the note's vault path under the root (vs. always the root). | on |
| Link password mode | `Random per file`, `Fixed`, or `None`. | `Random per file` |
| Fixed password | Used when mode is `Fixed`. | — |
| Password length | Length of generated passwords (mode `Random`). | `20` |
| Link expiration (days) | `0` = never expires. | `0` |
| Insert as image embed | Insert `![](...)` instead of `[name](...)`. | off |

## Security notes

- Files live in your Proton Drive and are **end-to-end encrypted** by Proton; the CLI session authenticates you locally and never leaves your machine.
- Share links contain a decryption key in the URL fragment (`#…`). Only people with the full link (and the password, when set) can access the file.
- Random passwords are generated with `crypto.getRandomValues` over an unambiguous alphabet (no `I`, `L`, `O`, `0`, `1`, `l`); 20 characters ≈ 116 bits of entropy.
- The password is only ever written into the note you inserted it into, as a `password: …` code span.

## Development

```bash
npm install
npm run dev      # watch mode (writes main.js)
npm run build    # type-check + production bundle
```

Source is in `src/`: `main.ts` (plugin, settings, view), `proton.ts` (CLI wrapper), `settings.ts` (types + defaults).

## License

MIT. Not affiliated with, or endorsed by, Proton.