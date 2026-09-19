# @kinetra/desktop-build

Release/distribution contracts around Kinetra's Electron-first Windows player.

Current layer:
- validated release manifest and deterministic artifact layout
- required release gates including packaged-executable launch + acceptance suite
- Authenticode/signtool command planning without secret material
- optional external signing hook
- Steam platform bridge abstraction with no-Steam null implementation
- deterministic SteamPipe app/depot VDF generation

The package deliberately **does not upload to Steam or sign binaries by itself**. Those actions require external credentials/secrets and remain CI/environment integrations.
