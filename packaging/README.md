# Linux packaging: Flatpak, NixOS and Docker

The release pipeline publishes AppImage, deb and rpm artifacts (see
`apps/shell/electron-builder.cjs`). This directory adds community-maintained
routes requested in genoffice#1858. All wrap the published release artifacts —
they do not rebuild the Electron/Rust source tree — so they track the official
binaries bit for bit.

These files are provided as-is and are not exercised by CI; verify them on a
real system before relying on them.

## Flatpak

`flatpak/com.genoffice.app.json` installs the deb via the Flatpak `extra-data`
mechanism: flatpak downloads the pinned deb from GitHub Releases at install
time (size + sha256 verified), and the first launch unpacks it into
`/app/extra/app` (`apply_extra`, plain Python 3) and starts it through Zypak,
which ships in `org.electronjs.Electron2.BaseApp` and adapts Electron's own
sandbox to the Flatpak sandbox.

Build and install locally from a repo checkout:

```sh
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.repo
flatpak install flathub org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08
flatpak-builder --user --install --force-clean build-dir packaging/flatpak/com.genoffice.app.json
flatpak run com.genoffice.app
```

Notes:

- File type associations, the icon set and the desktop entry come from the repo
  (`apps/shell/build/icons`); the deb's payload only provides the app itself.
- The bundled `genoffice` command line works inside the sandbox, e.g.:
  `flatpak run --command=/app/extra/app/opt/GenOffice/resources/cli/genoffice com.genoffice.app --help`
- The deb carries an in-app updater feed baked for the native install layout;
  under Flatpak `/app` is read-only, so updates must go through Flatpak, not
  the app's update dialog.
- The manifest pins v0.11.0. On a new release, update the `url`, `sha256` and
  `size` of the `extra-data` source (and the `<release>` entry in
  `com.genoffice.app.metainfo.xml`); the `x-checker-data` block lets the
  Flathub bot propose the new URL automatically.

## NixOS

`nix/genoffice.nix` wraps the upstream AppImage with `appimageTools` (no source
rebuild), installs the repo's icon set plus a desktop entry, and declares the
two libraries Electron dlopens from the host (`libsecret` for keyring-backed
API-key storage, `nss`):

```sh
nix-build packaging/nix
./result/bin/genoffice
```

The expression reads the repo's icon files, so run it from a repo checkout. On
a new release, bump `version` and the `hash` in `nix/genoffice.nix`.

Known caveat: the nix store is mounted `nosuid`, so Chromium can abort with
"The SUID sandbox helper binary was found, but is not configured correctly"
when the AppImage's `chrome-sandbox` is present but not setuid. In that case
launch with `genoffice --no-sandbox` (the flag passes through the wrapper); the
Flatpak route keeps the real sandbox via Zypak instead.

## Docker

`docker/` builds a headless image for batch PDF conversion; see
`docker/README.md`.

## Windows installer, built on Linux

`tools/build-win-on-linux.sh` packages the NSIS installer without a Windows
machine: electron-builder produces it on Linux, but only once the Windows-only
native pieces exist and Wine is available to stamp the exe.

```sh
# one-time host setup
sudo apt-get install mingw-w64 wine64
rustup target add x86_64-pc-windows-gnu

# full build: cross-build the sidecars, build the renderers, package
./tools/build-win-on-linux.sh
```

The script checks the toolchain up front and stops with an actionable message
instead of letting electron-builder exit 0 on a missing `extraResources` source
(which would ship a silently dead Sheets). It cross-builds
`xlsx-sidecar.exe` and `win-clipboard-helper.exe` for
`x86_64-pc-windows-gnu`, runs `notices` + `build:all`, then
`electron-builder --win`; the artifact lands in
`apps/shell/release/GenOffice Setup <version>.exe` with its `.blockmap`.

`--skip-native` reuses sidecars built elsewhere and `--skip-renderers` reuses
the existing `apps/*/out`, which is what you want when only the packaging step
changed. Nothing here signs the installer: local builds are unsigned, and the
release pipeline supplies the code-signing identity.
