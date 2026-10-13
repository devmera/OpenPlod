# OpenPlod iOS companion

A small iPhone app that copies recordings from a Plaud Note Pro over Bluetooth while you are away
from your Mac, and (next) uploads them to a WebDAV destination such as your NAS, where OpenPlod on
the Mac picks them up.

It only **reads** from a recorder already linked to OpenPlod's key: it scans, lists, downloads and
decrypts. It never pairs, binds, unlinks, force-clears or changes recorder settings. The key comes
from OpenPlod's encrypted enrollment and is kept in the iOS Keychain.

## Layout

- `rust/` — the Plaud protocol (`plaud-protocol`) and Bluetooth driver (`companion-ffi`), exposed to
  Swift with UniFFI. Derived from the author's unplaud project (MIT) without its cloud setup,
  pairing and reset paths.
- `Companion/` — the SwiftUI app; `project.yml` generates the Xcode project with xcodegen.
- `scripts/build-rust.sh` — builds the Rust core for iPhone and the simulator and packages
  `Companion/CompanionFFI.xcframework` with the generated Swift bindings.

## Build

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
ios/scripts/build-rust.sh
cd ios/Companion && DEVELOPMENT_TEAM=<your team id> xcodegen generate && open Companion.xcodeproj
```

The simulator has no Bluetooth; recorder features need a real iPhone.
