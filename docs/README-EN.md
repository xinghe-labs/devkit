# devkit (English summary)

> This is an English summary. The full document lives in the [Chinese README](../README.md) — both cover the same project.

## English

**devkit** is a Windows desktop app that aims to set up a development environment on a fresh
machine in one click — installing, configuring (mirrors, PATH, git, SSH) and **verifying**
(post-install self-check) the tools you select.

> **Technical preview.** The core scenario — a genuinely clean Windows machine — has **not**
> been accepted yet, and the installers are unsigned. Read the warning at the top of the [README](../README.md)
> before trying it.

It is not a package downloader — winget / Chocolatey / Scoop already do that. devkit covers
the three things they leave out:

1. Not knowing which version to install, where it goes, or what else has to be configured
2. Getting the tool installed but PATH / env vars / mirrors unset, so it does not run (or runs
   painfully slowly)
3. Failures halfway through with no idea which step broke

### ⚠️ Early version — the installer is NOT code-signed

- **Windows SmartScreen will warn you.** This is expected (not corruption, not tampering).
  Click *More info* → *Run anyway*. Code signing is being applied for via SignPath; see
  [docs/CODE-SIGNING.md](./CODE-SIGNING.md).
- **Never verified end-to-end on a genuinely fresh Windows machine.** The stated premise is
  "a machine with nothing installed", but all real-machine testing so far happened on a dev box
  that already had Node/Python/Git/Maven. Every unverified item is listed in
  [docs/VERIFICATION.md](./VERIFICATION.md) §5.
- Only verified on Windows 11 (Chinese locale). The declared minimum is Windows 10 22H2.
- Machine-scope installs (MSI + UAC elevation) have protocol-level tests only.

**Verdict: try it and file issues, but do not rely on it as a one-shot setup for a machine you
care about — yet.**

### Install

Download from [Releases](https://github.com/xinghe-labs/devkit/releases):

| File | Use |
| --- | --- |
| `devkit-<version>-setup.exe` | Installer (Start Menu / desktop shortcut, supports the in-app update flow) |
| `devkit-<version>-portable.exe` | Portable, no install |
| `latest.json` | Update index (SHA-256 + size of both artifacts) |

### How it works

1. Pick a **preset** (Frontend / Java / Python / Go / Rust / C++ / Full-stack / AI coding /
   Essentials) or tick tools manually
2. **Preflight** checks OS build, disk space, download-source reachability, admin needs
3. **Download** with mirror fallback, resume, and mandatory SHA-256 verification
4. **Install** into `<data-root>\versions\<tool>\<version>\` — per-user, no admin, your
   existing tools untouched
5. **Activate** (opt-in) wires the version into your user PATH and env vars via a junction, so
   switching versions never rewrites PATH
6. **Self-check** runs the tool's own `--version` **by absolute path**, then verifies the command
   resolves to devkit's copy from a fresh-terminal environment

### Key design decisions

- **Install ≠ activate.** Installing never touches PATH, `Program Files`, or HKLM. Activation is
  a separate, reversible step with a PATH backup and exact rollback.
- **Per-user by default.** Only one manifest (7-Zip) needs admin, and then only one UAC prompt
  for the whole plan.
- **Manifests are data.** Adding a tool = adding one JSON file. Install commands come from a
  code-side template whitelist — a manifest can name a template, never define a command.
- **Mirror configuration writes only its own block**, so your private registries, tokens and
  proxy settings survive.
- **Zero telemetry.**

### Environment health check & migration

- **Health check** — read-only diagnosis of PATH (missing dirs, unset variables, truncated
  fragments, duplicates), command resolution (which copy actually runs), env vars, and devkit's
  own state. Every finding names the exact entry and value. Fixing is explicit, backed up first,
  and verified after writing; machine-level fixes need one UAC prompt.
- **Environment profile** — export a portable JSON with the tool list, custom PATH entries, key
  env vars, mirrors and VS Code extensions; import it on a new machine to see a diff and restore.
  **Contains no secrets**: env vars are limited to a path-variable allowlist, and the restore
  options are all unchecked by default.

### Status

- 25 manifests (22 installable, 3 detect-only), 9 install templates
- 541 unit tests across 44 files; CI runs lint / typecheck (three tsconfigs) / manifest
  validation / tests plus a UI smoke job
  that fails on any renderer error
- Independent adversarial security review: 3 high / 3 medium / 1 low findings, all fixed with
  regression tests — see [docs/security-review.md](./security-review.md)
