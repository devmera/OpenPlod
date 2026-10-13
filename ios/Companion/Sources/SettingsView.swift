import SwiftUI

/// NAS, hands-free sync, the activity log and unlinking, out of the main screen.
struct SettingsView: View {
    var onUnlinked: () -> Void
    var onDestinationChanged: (Destination) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var destination = Destination.load()
    @State private var editingDestination = false
    @State private var confirmUnlink = false
    @ObservedObject private var beacon = BeaconWake.shared
    @ObservedObject private var activity = Activity.shared

    var body: some View {
        NavigationStack {
            Form {
                Section("Upload") {
                    Button { editingDestination = true } label: {
                        LabeledContent("NAS", value: destination.flatMap { URL(string: $0.url)?.host() } ?? "Not set up")
                    }.foregroundStyle(.primary)
                }
                Section {
                    if beacon.enabled {
                        Label("On", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Button("Turn on") { beacon.requestPermission() }
                    }
                } header: { Text("Hands-free sync") } footer: {
                    Text("The recorder's Bluetooth beacon wakes OpenPlod while it is near this iPhone, so new recordings reach your NAS within about 5 minutes. Needs location access “Always”; your location is never read or stored.")
                }
                Section {
                    NavigationLink("Activity") { ActivityView() }
                }
                Section {
                    Button("Unlink this iPhone", role: .destructive) { confirmUnlink = true }
                } footer: { Text("Removes the recorder key from this iPhone only. The recorder, your NAS and your Mac are not changed.") }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Done") { dismiss() }.fontWeight(.semibold) }
            .sheet(isPresented: $editingDestination) { DestinationView { destination = $0; onDestinationChanged($0) } }
            .confirmationDialog("Unlink this iPhone from the recorder?", isPresented: $confirmUnlink, titleVisibility: .visible) {
                Button("Unlink", role: .destructive) {
                    KeyStore.remove()
                    RecorderBluetooth.shared.watch(serial: nil)
                    BeaconWake.shared.monitor(serial: nil)
                    dismiss(); onUnlinked()
                }
            }
        }
    }
}

struct ActivityView: View {
    @ObservedObject private var activity = Activity.shared
    var body: some View {
        List(activity.entries) { entry in
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.text).font(.subheadline)
                Text(entry.at.formatted(date: .abbreviated, time: .standard)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .overlay { if activity.entries.isEmpty { ContentUnavailableView("No activity yet", systemImage: "clock") } }
        .navigationTitle("Activity")
    }
}
