import CryptoKit
import Foundation
import UIKit
import UserNotifications

/// Copies new recordings from the recorder to the NAS, when asked and whenever the recorder is heard
/// nearby (also in the background). A recording counts as done only after the NAS confirms the whole
/// file; until then the phone keeps its copy and retries on the next sync.
@MainActor
final class SyncEngine: ObservableObject {
    static let shared = SyncEngine()

    enum Phase: Equatable { case waiting, downloading, downloaded, uploading, done, unreadable, failed(String) }
    struct Item: Identifiable, Equatable { let id: UInt32; var phase: Phase }

    @Published private(set) var items: [Item] = []
    @Published private(set) var running = false
    @Published private(set) var summary: String?
    @Published private(set) var lastSync: Date? = UserDefaults.standard.object(forKey: "lastSync") as? Date

    /// Guards against back-to-back syncs from repeated triggers; short, because iOS reports a
    /// continuously advertising recorder only once and a dropped report is not repeated.
    private let cooldown: TimeInterval = 45
    /// How often a beacon wake-up may check the recorder (a few-second connection each time).
    static let beaconInterval: TimeInterval = 5 * 60
    private var lastAttempt: Date? {
        get { UserDefaults.standard.object(forKey: "lastAttempt") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "lastAttempt") }
    }
    private let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "pending", directoryHint: .isDirectory)

    // MARK: Hands-free sync

    /// The linked recorder was heard advertising: sync if set up and not done very recently.
    func recorderHeard() { trigger("Recorder heard") }

    /// The app came to the front: catch up on anything recorded since the last sync.
    func appOpened() { trigger("App opened") }

    /// The recorder's iBeacon was seen (iOS region monitoring): it is nearby. Checks at most every
    /// `beaconInterval`, since the recorder beacons continuously while beacon wake-up is on.
    func beaconWake() {
        if let lastAttempt, Date().timeIntervalSince(lastAttempt) < Self.beaconInterval { return }
        trigger("Recorder beacon")
    }

    /// iOS background refresh: a periodic chance to sync while the app is not in use.
    func backgroundRefresh() async {
        guard !running, let key = KeyStore.load(), let destination = Destination.load() else { return }
        Activity.shared.record("Background refresh; syncing")
        let uploaded = await sync(key: key, destination: destination)
        Activity.shared.record(summary ?? "Sync finished")
        if uploaded > 0 { notify(uploaded) }
    }

    private func trigger(_ reason: String) {
        let background = UIApplication.shared.applicationState != .active
        guard !running, let key = KeyStore.load(), let destination = Destination.load() else { return }
        if let lastAttempt, Date().timeIntervalSince(lastAttempt) < cooldown { return }
        Activity.shared.record("\(reason)\(background ? " in the background" : ""); syncing")
        let task = UIApplication.shared.beginBackgroundTask(withName: "Sync recordings")
        Task {
            let uploaded = await sync(key: key, destination: destination)
            Activity.shared.record(summary ?? "Sync finished")
            if background && uploaded > 0 { notify(uploaded) }
            UIApplication.shared.endBackgroundTask(task)
        }
    }

    /// Asks once; later calls do nothing once the user has answered.
    static func requestNotifications() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    private func notify(_ count: Int) {
        let content = UNMutableNotificationContent()
        content.title = "Recordings copied"
        content.body = count == 1 ? "1 new recording is on your NAS." : "\(count) new recordings are on your NAS."
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    // MARK: Sync

    /// Returns how many recordings were uploaded.
    @discardableResult
    func sync(key: RecorderKey, destination: Destination) async -> Int {
        guard !running else { return 0 }
        running = true; summary = nil; lastAttempt = Date()
        defer { running = false }
        var uploadedCount = 0
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let nas = WebDAV(destination: destination)
            try await nas.check()
            let kept = Set(localFiles().compactMap { UInt32($0.deletingPathExtension().lastPathComponent) })
            let skip = uploaded(key.serial).union(unreadable(key)).union(kept)
            items = []
            let connection = try await RecorderBluetooth.shared.connect()
            let listener = ProgressRelay { [weak self] id, state, detail in
                Task { @MainActor in self?.progress(key, id, state, detail) }
            }
            let outcome: SyncOutcome
            do {
                outcome = try await pullNewRecordings(key: key, transport: connection, timeoutSecs: 20, skip: Array(skip), outDir: folder.path, listener: listener)
                RecorderBluetooth.shared.disconnect(connection)
            } catch {
                RecorderBluetooth.shared.disconnect(connection)
                throw error
            }
            // Never fetch a recording that is still being made; the next wake-up after it stops will.
            if outcome.recording && localFiles().isEmpty {
                summary = "The recorder is recording. It will sync when the recording is done."
                return 0
            }
            for file in localFiles() {
                guard let session = UInt32(file.deletingPathExtension().lastPathComponent) else { continue }
                if !items.contains(where: { $0.id == session }) { items.append(Item(id: session, phase: .downloaded)) }
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
            let otherKey = items.filter { $0.phase == .unreadable }.count
            summary = items.isEmpty ? "Everything is already on the NAS."
                : "\(uploadedCount) uploaded" + (failed > 0 ? ", \(failed) will be retried next sync" : "")
                    + (otherKey > 0 ? ", \(otherKey) made under another key skipped" : "") + "."
            lastSync = Date(); UserDefaults.standard.set(lastSync, forKey: "lastSync")
        } catch {
            summary = error.localizedDescription
        }
        return uploadedCount
    }

    private func progress(_ key: RecorderKey, _ id: UInt32, _ state: String, _ detail: String?) {
        if !items.contains(where: { $0.id == id }) { items.append(Item(id: id, phase: .waiting)) }
        switch state {
        case "started": set(id, .downloading)
        case "saved": set(id, .downloaded)
        default:
            // Made while the recorder was bound to another key: it can never be decrypted here.
            if detail?.contains("decrypting") == true { markUnreadable(key, id); set(id, .unreadable) }
            else { set(id, .failed(detail ?? "Download failed")) }
        }
    }

    private func localFiles() -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
            .filter { ["ogg", "opus"].contains($0.pathExtension) }
    }

    private func set(_ id: UInt32, _ phase: Phase) {
        if let index = items.firstIndex(where: { $0.id == id }) { items[index].phase = phase }
    }

    // MARK: Bookkeeping

    private func doneKey(_ serial: String) -> String { "uploaded.\(serial)" }
    private func uploaded(_ serial: String) -> Set<UInt32> { Set((UserDefaults.standard.array(forKey: doneKey(serial)) as? [Int] ?? []).map(UInt32.init)) }
    private func markUploaded(_ serial: String, _ session: UInt32) {
        UserDefaults.standard.set(Array(uploaded(serial).union([session])).map(Int.init), forKey: doneKey(serial))
    }
    /// Recordings made under a key this phone does not hold: not downloaded again until the key changes.
    private func unreadableKey(_ key: RecorderKey) -> String {
        "unreadable.\(key.serial).\(SHA256.hash(data: Data(key.privateKey.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined())"
    }
    private func unreadable(_ key: RecorderKey) -> Set<UInt32> { Set((UserDefaults.standard.array(forKey: unreadableKey(key)) as? [Int] ?? []).map(UInt32.init)) }
    private func markUnreadable(_ key: RecorderKey, _ session: UInt32) {
        UserDefaults.standard.set(Array(unreadable(key).union([session])).map(Int.init), forKey: unreadableKey(key))
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
