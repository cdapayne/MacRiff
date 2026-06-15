#!/bin/bash
set -e

echo "[Packaging] Compiling menu.swift (arm64)..."
swiftc -sdk "$(xcrun --show-sdk-path -sdk macosx)" -target arm64-apple-macosx11.0 menu.swift -o MacRiff.arm64

echo "[Packaging] Compiling menu.swift (x86_64)..."
swiftc -sdk "$(xcrun --show-sdk-path -sdk macosx)" -target x86_64-apple-macosx11.0 menu.swift -o MacRiff.x86_64

echo "[Packaging] Creating Universal Binary..."
lipo -create MacRiff.arm64 MacRiff.x86_64 -output MacRiff
rm MacRiff.arm64 MacRiff.x86_64

echo "[Packaging] Creating App Bundle..."
APP_DIR="MacRiff.app"
MACOS_DIR="$APP_DIR/Contents/MacOS"
RESOURCES_DIR="$APP_DIR/Contents/Resources"

# Clean and recreate directories
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

# Move compiled executable into place
mv MacRiff "$MACOS_DIR/MacRiff"

echo "[Packaging] Generating Info.plist..."
cat <<EOF > "$APP_DIR/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>MacRiff</string>
    <key>CFBundleIdentifier</key>
    <string>com.cdapayne.MacRiff</string>
    <key>CFBundleName</key>
    <string>MacRiff</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF

echo "[Packaging] Copying bridge scripts, helper binaries, and dependencies..."
# Copy source files
cp bridge.js "$RESOURCES_DIR/"
cp injector "$RESOURCES_DIR/"
cp package.json "$RESOURCES_DIR/"

# Copy node_modules folder recursively
if [ -d "node_modules" ]; then
    cp -R node_modules "$RESOURCES_DIR/"
else
    echo "[Warning] node_modules not found! Please run npm install first."
fi

echo "[Packaging] Codesigning App Bundle..."
codesign --force --deep --sign - "$APP_DIR"

echo "[Packaging] App Bundle generated successfully at: $APP_DIR"
