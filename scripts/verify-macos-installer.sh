#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <installer.dmg> <expected-version>\n' "$0" >&2
  exit 2
fi

dmg_path=$1
expected_version=$2
if [[ ! -f "$dmg_path" || -z "$expected_version" ]]; then
  printf 'A readable DMG file and an expected version are required.\n' >&2
  exit 2
fi
case "$dmg_path" in
  /*) ;;
  *) dmg_path="$PWD/$dmg_path" ;;
esac

mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/ffmpeg-workbench-dmg.XXXXXX")
attach_attempted=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$attach_attempted" -eq 1 ]]; then
    if ! hdiutil detach "$mount_dir" -quiet; then
      if ! hdiutil detach "$mount_dir" -force -quiet; then
        printf 'Failed to detach installer volume: %s\n' "$mount_dir" >&2
        [[ "$status" -ne 0 ]] || status=1
      fi
    fi
  fi
  # Never recursively remove a directory that might still be a mounted volume.
  rmdir "$mount_dir" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

attach_attempted=1
hdiutil attach "$dmg_path" -readonly -nobrowse -noautoopen -mountpoint "$mount_dir"

app_path="$mount_dir/FFmpeg Workbench.app"
binary_path="$app_path/Contents/MacOS/ffmpeg-workbench"
plist_path="$app_path/Contents/Info.plist"
if [[ ! -d "$app_path" || ! -x "$binary_path" || ! -f "$plist_path" ]]; then
  printf 'Installer does not contain the expected application bundle and executable.\n' >&2
  exit 1
fi

actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist_path")
build_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist_path")
if [[ "$actual_version" != "$expected_version" || "$build_version" != "$expected_version" ]]; then
  printf 'Version mismatch: expected %s; application=%s, build=%s.\n' "$expected_version" "$actual_version" "$build_version" >&2
  exit 1
fi

architectures=$(lipo -archs "$binary_path")
case "$architectures" in
  'x86_64 arm64'|'arm64 x86_64') ;;
  *) printf 'Expected exactly arm64 and x86_64; found: %s\n' "$architectures" >&2; exit 1 ;;
esac
lipo -verify_arch arm64 x86_64 "$binary_path"
codesign --verify --deep --strict "$app_path"
printf 'Verified macOS installer: version %s, universal arm64 + x86_64, valid bundle signature.\n' "$actual_version"
