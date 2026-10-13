import { chmodSync, mkdirSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, resolve } from 'node:path'

/**
 * Compiles the macOS meeting recorder helper (src-tauri/meeting-bridge). Process
 * taps need macOS 14.2, so that is the deployment target. Without arguments it
 * builds for this Mac into src-tauri/meeting-bridge/build, where a source-run
 * server finds it; build-sidecar passes a target triple and output path instead.
 */
export function buildMeetingBridge(triple?: string, outputPath = resolve('src-tauri/meeting-bridge/build/meeting-bridge')) {
  if (platform() !== 'darwin') throw new Error('The meeting recorder helper is macOS only.')
  const swiftArch = (triple ?? (arch() === 'arm64' ? 'aarch64' : 'x86_64')).startsWith('aarch64') ? 'arm64' : 'x86_64'
  mkdirSync(dirname(outputPath), { recursive: true })
  const build = Bun.spawnSync([
    'swiftc', '-O', '-swift-version', '5', '-target', `${swiftArch}-apple-macos14.2`,
    'src-tauri/meeting-bridge/main.swift', '-o', outputPath,
  ], { stdout: 'inherit', stderr: 'inherit' })
  if (build.exitCode !== 0) process.exit(build.exitCode)
  chmodSync(outputPath, 0o755)
  console.log(`[Tauri] Meeting recorder helper ready: ${outputPath}`)
}

if (import.meta.main) buildMeetingBridge(process.argv[2], process.argv[3] && resolve(process.argv[3]))
