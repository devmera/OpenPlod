import SwiftUI

/// First screen: find Plaud recorders nearby. Linking a key and syncing come next.
struct RecorderView: View {
    @State private var recorders: [NearbyRecorder] = []
    @State private var scanning = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task { await scanNearby() }
                    } label: {
                        Label(scanning ? "Scanning…" : "Scan for recorders", systemImage: "dot.radiowaves.left.and.right")
                    }
                    .disabled(scanning)
                } footer: {
                    if let message { Text(message) }
                }
                if !recorders.isEmpty {
                    Section("Nearby") {
                        ForEach(recorders, id: \.id) { recorder in
                            LabeledContent(recorder.name ?? "Plaud recorder", value: recorder.rssi.map { "\($0) dBm" } ?? "")
                        }
                    }
                }
            }
            .navigationTitle("OpenPlod")
        }
    }

    private func scanNearby() async {
        scanning = true
        message = nil
        defer { scanning = false }
        do {
            recorders = try await scan(seconds: 8)
            if recorders.isEmpty { message = "No Plaud recorder found. Wake it and keep it close." }
        } catch {
            message = error.localizedDescription
        }
    }
}
