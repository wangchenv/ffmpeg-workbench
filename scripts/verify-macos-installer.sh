#!/usr/bin/env bash
set -euo pipefail

report_failure() {
  # Public annotations use only these fixed messages. Never copy paths,
  # command output, version values or environment data into an annotation.
  case "$1" in
    mount) printf '::error::Mac disk image failed to mount\n' >&2 ;;
    contents) printf '::error::Mac disk image has wrong bundle contents\n' >&2 ;;
    version) printf '::error::Mac disk image version mismatch\n' >&2 ;;
    architecture) printf '::error::Mac disk image architecture mismatch\n' >&2 ;;
    signature) printf '::error::Mac disk image signature invalid\n' >&2 ;;
    detach) printf '::error::Mac disk image detach failed\n' >&2 ;;
  esac
}

fail() {
  report_failure "$1"
  exit 1
}

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s <installer.dmg> <expected-version>\n' "$0" >&2
  report_failure mount
  exit 2
fi

dmg_path=$1
expected_version=$2
if [[ ! -f "$dmg_path" || -z "$expected_version" ]]; then
  printf 'A readable DMG file and an expected version are required.\n' >&2
  report_failure mount
  exit 2
fi
case "$dmg_path" in
  /*) ;;
  *) dmg_path="$PWD/$dmg_path" ;;
esac

if ! mount_dir=$(mktemp -d "${TMPDIR:-/tmp}/ffmpeg-workbench-dmg.XXXXXX"); then
  fail mount
fi
attach_attempted=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$attach_attempted" -eq 1 ]]; then
    if ! hdiutil detach "$mount_dir" -quiet; then
      if ! hdiutil detach "$mount_dir" -force -quiet; then
        printf 'Failed to detach installer volume: %s\n' "$mount_dir" >&2
        report_failure detach
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
if ! hdiutil attach "$dmg_path" -readonly -nobrowse -noautoopen -mountpoint "$mount_dir"; then
  fail mount
fi

app_path="$mount_dir/FFmpeg Workbench.app"
binary_path="$app_path/Contents/MacOS/ffmpeg-workbench"
plist_path="$app_path/Contents/Info.plist"
if [[ ! -d "$app_path" || ! -x "$binary_path" || ! -f "$plist_path" ]]; then
  printf 'Installer does not contain the expected application bundle and executable.\n' >&2
  fail contents
fi

if ! actual_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist_path"); then
  fail version
fi
if ! build_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist_path"); then
  fail version
fi
if [[ "$actual_version" != "$expected_version" || "$build_version" != "$expected_version" ]]; then
  printf 'Version mismatch: expected %s; application=%s, build=%s.\n' "$expected_version" "$actual_version" "$build_version" >&2
  fail version
fi

if ! architectures=$(lipo -archs "$binary_path"); then
  fail architecture
fi
case "$architectures" in
  'x86_64 arm64'|'arm64 x86_64') ;;
  *) printf 'Expected exactly arm64 and x86_64; found: %s\n' "$architectures" >&2; fail architecture ;;
esac
# Some Apple lipo versions interpret the second architecture as another input
# file despite advertising a list. Verify one architecture per invocation.
for architecture in arm64 x86_64; do
  if ! lipo "$binary_path" -verify_arch "$architecture"; then
    fail architecture
  fi
done
if ! codesign --verify --deep --strict "$app_path"; then
  fail signature
fi
printf 'Verified macOS installer: version %s, universal arm64 + x86_64, valid bundle signature.\n' "$actual_version"
