import SwiftUI

/// Main screen: the linked recorder and what it holds. Uploading to your NAS comes next.
struct RecorderView: View {
    @State private var key: RecorderKey? = KeyStore.load()
    @State private var recordings: [RecorderFile] = []
    @State private var busy: String?
    @State private var message: String?
    @State private var destination = Destination.load()
    @State private var editingDestination = false
    @StateObject private var engine = SyncEngine()

    var body: some View {
        NavigationStack {
            if let key {
                List {
                    Section {
                        LabeledContent("Recorder", value: key.serial)
                        Button { run("Reading recorder…") { recordings = try await listRecordings(key: key, device: nil, timeoutSecs: 20) } }
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
                    } header: { Text("Upload") } footer: { if let summary = engine.summary { Text(summary) } }
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
                    Section {
                        Button("Unlink this phone", role: .destructive) { KeyStore.remove(); self.key = nil; recordings = [] }
                    } footer: { Text("Removes the recorder key from this phone only. The recorder and your Mac are not changed.") }
                }
                .navigationTitle("OpenPlod")
                .disabled(busy != nil)
                .sheet(isPresented: $editingDestination) { DestinationView { saved in destination = saved } }
            } else {
                LinkView { linked in key = linked }
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
