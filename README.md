# DSH Plugins

A collection of independently installable **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin bundles**.

Each subdirectory is a self-contained npm package that declares `dsh.bundle.patch` in its
`package.json`. Installing one with `dsh plugin add` links it into a [profile](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)
and appends it to that profile's `dsh.profile.bundles` list, which is what makes dsh apply the
plugin's patch layer at boot.

| Plugin | Package | Version | Tools / commands | Platform |
| --- | --- | --- | --- | --- |
| [`window-capture`](./window-capture) | `@local/dsh-plugin-window-capture` | 2.0.0 | `list_windows`, `capture_window` | Windows |
| [`input-control`](./input-control) | `@local/dsh-plugin-input-control` | 1.0.0 | `click`, `type_text`, `press_keys`, `scroll`, `drag`, `move_mouse` | Windows |
| [`seamless-continue`](./seamless-continue) | `@local/dsh-plugin-seamless-continue` | 1.1.0 | `/continue` command | any |

`window-capture` and `input-control` are designed to be used together: capture a window, act on
it at the coordinates you saw, then capture again to confirm.

## Requirements

- **DeepSeek Harness** `0.2.x`. Every bundle declares `engines.dsh` as `>=0.2.0 <0.3.0`, and dsh
  refuses to load a bundle whose range does not match the running version.
- **Node.js** on `PATH` (only needed for `window-capture` and `input-control`, which spawn a
  worker with the running dsh's own Node executable).
- **Windows** for `window-capture` and `input-control`. Both fail with a clear `NOT_WINDOWS`
  error elsewhere instead of misbehaving.
- A `dsh` command. The Desktop app ships one at
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`; the scripts here
  find it automatically if it is not on `PATH`.

## Install

Clone this repository anywhere, then run the installer from its root:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

That installs **every** plugin into the profile named by `$env:DSH_PROFILE`, defaulting to
`desktop`. Useful flags:

```powershell
.\install.ps1 -Profile web                 # install into a different profile
.\install.ps1 -Plugin window-capture, input-control
.\install.ps1 -DryRun                      # show the commands without running them
```

Installing means running, once per plugin:

```powershell
dsh plugin --profile <profile> add <absolute-path-to-plugin-directory>
```

There is no build step: the plugins ship plain ESM `index.js` entry points, so a git clone is
runnable as-is.

### Quit the Desktop app first

The `desktop` profile is owned by the Desktop application and dsh takes a lock on its
`package.json`. Quit DeepSeek Harness fully, install, then start it again. Installing into a
CLI profile (`web`, `headless`, …) has no such restriction.

### Verify it loaded

```powershell
dsh --profile desktop --dump-config | Select-String -Pattern 'window-capture|input-control|seamless-continue'
```

Each installed bundle contributes its own `# == <package>` patch layer. If a layer is missing,
the bundle did not get added to `dsh.profile.bundles`; re-run the installer.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

`dsh plugin remove` deletes both the dependency entry and the bundle layer, so nothing is left
behind. Add `-Plugin <name>` to remove a single plugin, or `-DryRun` to preview.

## Moving or renaming this repository

The install is a **link** from the profile to the checkout, so moving the folder breaks it:
`dsh` keeps pointing at the old path and the plugins silently fail to import.

After moving the repository, simply **run `install.ps1` again in its new location**. It re-adds
each bundle at the new absolute path, and bundles already listed in `dsh.profile.bundles` are not
duplicated.

## What makes a directory a DSH bundle

The manifest contract, per the [publishing documentation](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish):

```jsonc
{
  "name": "@local/dsh-plugin-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",                         // ESM entry exporting `name` and `apply(ctx)`
  "exports": { ".": "./index.js" },
  "files": ["index.js", "cordis.patch.yml"],  // what `pnpm pack` would ship
  "engines": { "dsh": ">=0.2.0 <0.3.0" },     // declares the supported dsh range
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" },  // shared host instance
  "devDependencies": { "@deepseek-ai/cordis": "~4.0.5" },   // for local typecheck
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" }             // the bundle declaration
  }
}
```

`cordis.patch.yml` is a YAML array of patch entries that inserts the plugin's Loader row:

```yaml
- insert:
    - id: example
      name: '@local/dsh-plugin-example'
      config: {}
```

The row's `name` must be the **package name**, not a relative path, so that Node module
resolution finds the installed copy.

### Notes on the fields

- **`engines.dsh`** — a SemVer range. If present it alone decides compatibility (peer ranges are
  then ignored); without it, dsh checks `peerDependencies` on `@deepseek-ai/dsh*` instead.
  Because this collection is `private` and never published, the peer-dependency fallback would
  never apply, so the explicit `engines.dsh` is what keeps a bundle from loading on an
  incompatible future dsh.
- **`private: true`** — these are local checkouts installed by path, not registry packages.
  Drop it if you decide to publish.
- **No `dsh.client`** — none of these plugins ship a browser bundle, so none declares one.
  A `dsh.client` declaration requires a real `./client` export; omitting it is correct.

## Testing a plugin

Each plugin has a dependency-free check script covering its pure logic and protocol parsing:

```powershell
node .\window-capture\test\check.mjs
node .\input-control\test\check.mjs
node .\seamless-continue\test\check.mjs
```

## Layout

```
.
├── install.ps1            # install / re-link every bundle into a profile
├── uninstall.ps1          # remove every bundle from a profile
├── package.json           # collection metadata only (not a profile, not installed)
├── window-capture/        # -> @local/dsh-plugin-window-capture
│   ├── package.json       #    dsh.bundle.patch
│   ├── cordis.patch.yml   #    the Loader row this bundle inserts
│   ├── index.js           #    plugin entry: tools
│   ├── capture-worker.cjs #    Medium-integrity capture worker
│   ├── icon.svg
│   ├── locale/{en,zh}.json
│   └── test/check.mjs
├── input-control/         # -> @local/dsh-plugin-input-control
└── seamless-continue/     # -> @local/dsh-plugin-seamless-continue
```

## License

MIT
