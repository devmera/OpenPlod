import Foundation

/// Copies new recordings from the recorder to the NAS. A recording counts as done only after the NAS
/// confirms the whole file; until then the phone keeps its copy and retries on the next sync.
@MainActor
final class SyncEngine: ObservableObject {
    enum Phase: Equatable { case waiting, downloading, uploading, done, failed(String) }
    struct Item: Identifiable, Equatable { let id: UInt32; var phase: Phase }

    @Published private(set) var items: [Item] = []
    @Published private(set) var running = false
    @Published private(set) var summary: String?

    private let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "pending", directoryHint: .isDirectory)

    private func doneKey(_ serial: String) -> String { "uploaded.\(serial)" }
    private func uploaded(_ serial: String) -> Set<UInt32> { Set((UserDefaults.standard.array(forKey: doneKey(serial)) as? [Int] ?? []).map(UInt32.init)) }
    private func markUploaded(_ serial: String, _ session: UInt32) {
        UserDefaults.standard.set(Array(uploaded(serial).union([session])).map(Int.init), forKey: doneKey(serial))
    }

    func sync(key: RecorderKey, destination: Destination) async {
        guard !running else { return }
        running = true; summary = nil
        defer { running = false }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let nas = WebDAV(destination: destination)
            try await nas.check()
            let onRecorder = try await listRecordings(key: key, device: nil, timeoutSecs: 20)
            let done = uploaded(key.serial)
            let waiting = onRecorder.filter { !done.contains($0.sessionId) }.map(\.sessionId)
            // Downloaded on an earlier run but not yet on the NAS.
            let kept = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                .filter { ["ogg", "opus"].contains($0.pathExtension) }
            let keptIds = Set(kept.compactMap { UInt32($0.deletingPathExtension().lastPathComponent) })
            items = waiting.map { Item(id: $0, phase: .waiting) }
            let toDownload = waiting.filter { !keptIds.contains($0) }
            if !toDownload.isEmpty {
                for id in toDownload { set(id, .downloading) }
                let listener = ProgressRelay { [weak self] id, state, detail in
                    Task { @MainActor in if state == "failed" { self?.set(id, .failed(detail ?? "Download failed")) } }
                }
                _ = try await pullRecordings(key: key, device: nil, timeoutSecs: 20, sessionIds: toDownload, outDir: folder.path, listener: listener)
            }
            var uploadedCount = 0
            for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) where ["ogg", "opus"].contains(file.pathExtension) {
                guard let session = UInt32(file.deletingPathExtension().lastPathComponent) else { continue }
                if items.first(where: { $0.id == session }) == nil { items.append(Item(id: session, phase: .waiting)) }
                set(session, .uploading)
                do {
                    let name = "Plaud-\(session).\(file.pathExtension)"
                    let sidecar = folder.appending(path: "\(name).openplod.json")
                    try sidecarData(serial: key.serial, session: session).write(to: sidecar)
                    try await nas.upload(file: sidecar, as: sidecar.lastPathComponent)
                    try await nas.upload(file: file, as: name)
                    markUploaded(key.serial, session)
                    try? FileManager.default.removeItem(at: file)
                    try? FileManager.default.removeItem(at: sidecar)
                    set(session, .done); uploadedCount += 1
                } catch {
                    set(session, .failed(error.localizedDescription))
                }
            }
            let failed = items.filter { if case .failed = $0.phase { true } else { false } }.count
            summary = waiting.isEmpty && uploadedCount == 0 ? "Everything is already on the NAS."
                : "\(uploadedCount) uploaded" + (failed > 0 ? ", \(failed) will be retried next sync." : ".")
        } catch {
            summary = error.localizedDescription
        }
    }

    private func set(_ id: UInt32, _ phase: Phase) {
        if let index = items.firstIndex(where: { $0.id == id }) { items[index].phase = phase }
    }

    /// The metadata OpenPlod's folder import reads to keep the recorder's source id and start time.
    private func sidecarData(serial: String, session: UInt32) throws -> Data {
        let recordedAt = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: TimeInterval(session)))
        return try JSONSerialization.data(withJSONObject: [
            "type": "openplod-recording", "version": 1, "sourceProvider": "plaud",
            "sourceRecordingId": "\(serial.uppercased()):\(session)", "recordedAt": recordedAt,
        ], options: [.sortedKeys])
    }
}

/// Bridges the Rust progress callbacks into Swift.
final class ProgressRelay: PullListener, @unchecked Sendable {
    private let handler: (UInt32, String, String?) -> Void
    init(_ handler: @escaping (UInt32, String, String?) -> Void) { self.handler = handler }
    func onProgress(sessionId: UInt32, state: String, detail: String?) { handler(sessionId, state, detail) }
}
