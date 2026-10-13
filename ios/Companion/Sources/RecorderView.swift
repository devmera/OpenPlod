import SwiftUI

/// Main screen: the linked recorder and what it holds. Uploading to your NAS comes next.
struct RecorderView: View {
    @State private var key: RecorderKey? = KeyStore.load()
    @State private var recordings: [RecorderFile] = []
    @State private var busy: String?
    @State private var message: String?

    var body: some View {
        NavigationStack {
            if let key {
                List {
                    Section {
                        LabeledContent("Recorder", value: key.serial)
                        Button { run("Reading recorder…") { recordings = try await listRecordings(key: key, device: nil, timeoutSecs: 20) } }
                            label: { Label("List recordings", systemImage: "list.bullet") }
                    } footer: { status }
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
            } else {
                LinkView { linked in key = linked }
            }
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
