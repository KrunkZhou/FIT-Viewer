# FIT Viewer

React and TypeScript implementation for inspecting local FIT files and combined ZIP archives. Decoding, queries, charts, maps, repair and exports run in a document worker.

## Build

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## Development server

```sh
pnpm run dev
```

Open at `http://127.0.0.1:5173/`.

## Desktop

`pnpm run build:desktop` builds the web bundle and sandboxed Electron app.
`pnpm run desktop` opens it; `pnpm run test:desktop` exercises the packaged
renderer, preload, OS-file handoff and worker. Release packaging uses
`pnpm run package:desktop` with the appropriate platform/architecture flags.

Drop a folder to recursively combine its FIT files, or use the folder button.
Non-FIT files and nested ZIPs in folders are skipped. Loose ZIP drops still work.
The import supports cancellation and enforces an aggregate 512 MiB default limit.

The Windows installer registers FIT Viewer as an Open With candidate for `.fit`.
On startup, installed Windows builds ask whether to open the Windows default-app
chooser. Confirm FIT Viewer for `.fit` there. Not now asks again next launch;
Don't ask again suppresses the prompt. Existing defaults are never overwritten.
The portable build does not register associations or prompt. Double-clicked files
open in the existing app window, or are queued until a new window is ready.

Icons are checked in for web, Windows and macOS; see [icon generation](build/ICON.md).
