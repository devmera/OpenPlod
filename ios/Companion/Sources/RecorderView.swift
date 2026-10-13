import SwiftUI

/// Main screen: the linked recorder and what it holds. Uploading to your NAS comes next.
struct RecorderView: View {
    @State private var key: RecorderKey? = KeyStore.load()
    @State private var recordings: [RecorderFile] = []
    @State private var busy: String?
    @State private var message: String?
    @State private var destination = Destination.load()
    @State private var editingDestination = false
    @ObservedObject private var engine = SyncEngine.shared
    @ObservedObject private var activity = Activity.shared
    @ObservedObject private var beacon = BeaconWake.shared

    var body: some View {
        NavigationStack {
            if let key {
                List {
                    Section {
                        LabeledContent("Recorder", value: key.serial)
                        Button { run("Reading recorder…") {
                            let connection = try await RecorderBluetooth.shared.connect()
                            defer { RecorderBluetooth.shared.disconnect(connection) }
                            recordings = try await listRecordings(key: key, transport: connection, timeoutSecs: 20)
                        } }
                            label: { Label("List recordings", systemImage: "list.bullet") }
                    } footer: { status }
                    Section {
                        if let destination {
                            LabeledContent("NAS", value: URL(string: destination.url)?.host() ?? destination.url)
                            Button { Task { await engine.sync(key: key, destination: destination) } } label: {
                                Label(engine.running ? "Syncing…" : "Sync now", systemImage: "arrow.triangle.2.circlepath")
                            }.disabled(engine.running)
                        }
                        Button(destination == nil ? "Set up NAS" : "Change NAS") { editingDestination = true }
                    } header: { Text("Upload") } footer: {
                        VStack(alignment: .leading, spacing: 4) {
                            if let summary = engine.summary { Text(summary) }
                            Text(engine.lastSync.map { "Syncs automatically when the recorder is nearby. Last sync \($0.formatted(.relative(presentation: .named)))." }
                                 ?? "Syncs automatically when the recorder is nearby, also with the app in the background.")
                        }
                    }
                    Section {
                        if beacon.enabled {
                            Label("On: syncs within about 5 minutes while the recorder is near this iPhone", systemImage: "antenna.radiowaves.left.and.right")
                        } else {
                            Button { beacon.requestPermission() } label: { Label("Turn on hands-free sync", systemImage: "antenna.radiowaves.left.and.right") }
                        }
                    } header: { Text("Hands-free sync") } footer: {
                        if !beacon.enabled {
                            Text(beacon.authorization == .denied || beacon.authorization == .authorizedWhenInUse
                                 ? "Set Location to “Always” for OpenPlod in Settings. The recorder's beacon then wakes the app; your location is never read or stored."
                                 : "Uses the recorder's beacon to wake the app in the background. iOS asks for location access “Always”; your location is never read or stored.")
                        }
                    }
                    if !engine.items.isEmpty {
                        Section("This sync") {
                            ForEach(engine.items) { item in
                                HStack(alignment: .firstTextBaseline) {
                                    Text(Date(timeIntervalSince1970: TimeInterval(item.id)).formatted(date: .abbreviated, time: .shortened))
                                    Spacer(minLength: 12)
                                    phase(item.phase).font(.subheadline).multilineTextAlignment(.trailing)
                                }
                            }
                        }
                    }
                    if !recordings.isEmpty {
                        Section("On the recorder (\(recordings.count))") {
                            ForEach(recordings, id: \.sessionId) { file in
                                LabeledContent(Date(timeIntervalSince1970: TimeInterval(file.sessionId)).formatted(date: .abbreviated, time: .shortened),
                                               value: ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                            }
                        }
                    }
                    if !activity.entries.isEmpty {
                        Section("Activity") {
                            ForEach(activity.entries.prefix(12)) { entry in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.text).font(.subheadline)
                                    Text(entry.at.formatted(date: .omitted, time: .standard)).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    Section {
                        Button("Unlink this phone", role: .destructive) { KeyStore.remove(); self.key = nil; recordings = []; RecorderBluetooth.shared.watch(serial: nil); BeaconWake.shared.monitor(serial: nil) }
                    } footer: { Text("Removes the recorder key from this phone only. The recorder and your Mac are not changed.") }
                }
                .navigationTitle("OpenPlod")
                .disabled(busy != nil)
                .sheet(isPresented: $editingDestination) { DestinationView { saved in destination = saved } }
            } else {
                LinkView { linked in key = linked; RecorderBluetooth.shared.watch(serial: linked.serial); BeaconWake.shared.monitor(serial: linked.serial); SyncEngine.requestNotifications() }
            }
        }
    }

    @ViewBuilder private func phase(_ phase: SyncEngine.Phase) -> some View {
        switch phase {
        case .waiting: Text("Waiting").foregroundStyle(.secondary)
        case .downloading: Label("Downloading", systemImage: "arrow.down.circle")
        case .downloaded: Label("Downloaded", systemImage: "arrow.down.circle.fill").foregroundStyle(.secondary)
        case .unreadable: Label("Other key – skipped", systemImage: "key.slash").foregroundStyle(.secondary)
        case .uploading: Label("Uploading", systemImage: "arrow.up.circle")
        case .done: Label("On NAS", systemImage: "checkmark.circle").foregroundStyle(.green)
        case .failed(let reason): Label(reason, systemImage: "exclamationmark.triangle").foregroundStyle(.red).lineLimit(2)
        }
    }

    @ViewBuilder private var status: some View {
        if let busy { Text(busy) } else if let message { Text(message) }
    }

    private func run(_ label: String, _ work: @escaping () async throws -> Void) {
        busy = label; message = nil
        Task {
            do { try await work() } catch { message = error.localizedDescription }
            busy = nil
        }
    }
}
