#!/usr/bin/env bash
# Build the companion's Rust core for iPhone and the iOS simulator, generate the Swift bindings,
# and package both into Companion/CompanionFFI.xcframework.
#
# Needs: rustup targets aarch64-apple-ios and aarch64-apple-ios-sim, and Xcode.
set -euo pipefail
cd "$(dirname "$0")/.."
RUST=rust
OUT=Companion/Generated
export IPHONEOS_DEPLOYMENT_TARGET=17.0
# iOS standard libraries come from rustup; a Homebrew Rust earlier in PATH cannot target iOS.
if [[ -x "$HOME/.cargo/bin/cargo" ]]; then export PATH="$HOME/.cargo/bin:$PATH"; fi

echo "==> 1/3 build the Rust core (device, simulator)"
for target in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build --manifest-path "$RUST/Cargo.toml" --release -p companion-ffi --target "$target"
done

echo "==> 2/3 generate Swift bindings"
cargo build --manifest-path "$RUST/Cargo.toml" --release -p companion-ffi
mkdir -p "$OUT" Companion/Headers
# The generator reads crate metadata from the workspace it runs in.
( cd "$RUST" && cargo run --release --features cli --bin uniffi-bindgen -- \
  generate --library target/release/libcompanion_ffi.dylib --language swift --out-dir "../$OUT" )
cp "$OUT/companion_ffiFFI.h" Companion/Headers/
cp "$OUT/companion_ffiFFI.modulemap" Companion/Headers/module.modulemap

echo "==> 3/3 package the xcframework"
rm -rf Companion/CompanionFFI.xcframework
xcodebuild -create-xcframework \
  -library "$RUST/target/aarch64-apple-ios/release/libcompanion_ffi.a" -headers Companion/Headers \
  -library "$RUST/target/aarch64-apple-ios-sim/release/libcompanion_ffi.a" -headers Companion/Headers \
  -output Companion/CompanionFFI.xcframework
echo "built Companion/CompanionFFI.xcframework"
