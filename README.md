<p align="center">
  <img src="docs/cover.png" alt="Morrow desktop window: an AI agent session with a completed plan beside a workspace file tree" width="100%">
</p>

<h1 align="center">Morrow</h1>
<p align="center">A local-first AI workspace for Windows that turns a request into a finished file.</p>
<p align="center"><a href="README.zh.md">中文</a></p>

<p align="center">
  <a href="https://www.electronjs.org/docs/latest"><img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white"></a>
  <a href="https://react.dev"><img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black"></a>
  <a href="https://www.typescriptlang.org/docs"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://learn.microsoft.com/windows/"><img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2EA043"></a>
  <a href="https://github.com/youyuwangzi0001/Morrow/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.2.0-2EA043"></a>
</p>

## Overview

Morrow is a desktop AI agent for Windows 10/11 x64. You describe the result you want; it reads the workspace, writes files, runs commands, checks its own work, and leaves the result where you can open it. Conversations, memory, workspaces and keys stay on the machine — model access is yours to configure.

It also ships a Studio for long-form work: a short story, a novel or a 30–180-second comic film, taken from a one-line premise to a deliverable through a blueprint you approve first. The blueprint itself is a model call billed by tokens; chapters, frames and media start only after you approve it and are billed separately.

## Features

### An agent that works inside the folder you choose

- Five ways to work: chat, work, plan, deep research and long-running goals.
- Real file tree, CodeMirror editor, multi-tab canvas and previews for HTML, Markdown, PDF, Office, images, audio and video.
- A real PTY terminal (Git Bash by default, PowerShell 7 or WSL), a Git workbench, a multi-tab browser and Windows UI Automation.
- Three permission levels — read-only, ask, full access. Dangerous commands, out-of-workspace paths and external side effects are approved one at a time, and a denial always beats an approval.
- Checkpoints per turn and file snapshots before writes, so a session or a file can be rolled back.

![Agent session with a completed plan and a generated report notice](docs/screens/guide-chat.png)

### A Studio that finishes the work

- Short story (30–80k characters), novel (200–1000k) and comic film (30–180 seconds).
- Blueprint, outline, storyboard, frames, voice, timeline, review and delivery — with a paper-like editor, a five-track timeline and a node canvas for comic workflows.
- Collaborators turn a plain-language request into a reviewable change plan; nothing is applied before you confirm it, and changes can be undone.
- Deterministic local checks plus real model review. When no model or engine is available, it fails and says so instead of inventing a result.

![Studio timeline with monitor, five tracks and real audio waveforms](docs/screens/studio-timeline.png)

### One place for models, memory and automation

- API keys for OpenAI-compatible and Anthropic providers, subscription channels, and local models through Ollama, llama.cpp or LM Studio.
- Projects, a memory centre, 20 built-in skills, workspace skills, MCP servers and scheduled tasks.
- Cloud media providers for image, video, voice and music sit beside local ComfyUI, FFmpeg and TTS engines.

![Approval card showing the tool, target, impact and parameters](docs/screens/guide-permission.png)

## Installation

### Use a release build

Download both files from [the v0.2.0 release](https://github.com/youyuwangzi0001/Morrow/releases/tag/v0.2.0):

| File | What it is |
|---|---|
| `Morrow-0.2.0-portable.exe` | Single-file portable build; unpacks a runtime cache next to the executable on first run |
| `Morrow-0.2.0-setup.exe` | NSIS installer with a selectable install directory and shortcuts |

Neither executable is code-signed, so Windows SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway**. Verify downloads against `SHA256SUMS.txt` before running them.

### Run from source

Requirements: Windows 10/11 x64, Node.js 22.12+, and Git (Git Bash is the default terminal).

```powershell
npm install
npm run dev
```

Useful checks:

```powershell
npm run typecheck    # type check both processes
npm run test:unit    # 573 unit tests
npm run test:e2e     # 86 Electron flows (builds first)
npm run verify       # type check, UI audit, docs, suite, unit and Electron
npm run dist:final   # rebuild the two release executables
```

## Usage

1. Start Morrow and finish the three-step onboarding: what Morrow is, a model connection, and a workspace folder.
2. Ask for the result in plain language, for example "turn this sales export into an HTML review with the anomalies marked".
3. Approve the actions that need it. When the run finishes, open the result from the canvas, the workspace or the Studio library.

If you have no API key yet, the ChatGPT/Codex subscription route reuses a local Codex login. The full walkthrough, including model setup and failure recovery, is in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## Configuration

Models, subscriptions and media engines are configured in **Settings**. Data lives in `%APPDATA%\Morrow` for the installer, or in `Morrow Data` next to the executable for the portable build. `MORROW_DATA_DIR` and a few engine paths can be set through environment variables.

The complete list of providers, subscription channels, media services, shortcuts, data paths and environment variables is in [docs/REFERENCE.md](docs/REFERENCE.md).

## Project structure

```text
src/main/       Electron main process: window, agent, studio, media, subscriptions
src/core/       Agent loop, providers, tools, permissions, context, collaboration
src/renderer/   React UI, feature components and styles
src/shared/     IPC and data contracts
tests/          Vitest units and Playwright Electron flows
docs/           Documentation and 2100×1200 screenshots
scripts/        Build, test, packaging, smoke and documentation checks
```

## Releases

Release builds, source archives and checksums live in [Releases](https://github.com/youyuwangzi0001/Morrow/releases). Version-by-version changes, in Chinese and English, are in [CHANGELOG.md](CHANGELOG.md).

## Security

- The renderer runs with `contextIsolation` and sandboxing, without `nodeIntegration`; it reaches the system only through a preload whitelist.
- File tools stay inside the workspace; reading outside it requires an explicit attachment.
- Keys are encrypted by the system credential store and are never shown again in the UI.
- Web pages, MCP servers and desktop content are treated as untrusted input. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Known limitations

- Windows x64 only. Both executables are unsigned.
- ComfyUI, llama.cpp, Ollama, LM Studio, FFmpeg, ACE-Step and TTS engines are not bundled; when they are missing, the related action fails with an explanation.
- Subscription logins and quotas belong to the provider. Channels that have not been verified on a real machine are not shown as connected.
- Model quality, engine speed and long media runs depend on your environment.

## License

MIT. See [LICENSE](LICENSE). Third-party components and built-in skill sources are listed in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#第三方组件与许可).