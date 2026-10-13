import SwiftUI

/// Main screen: the linked recorder, one Sync button, and the recordings grouped by day.
struct RecorderView: View {
    @State private var key: RecorderKey? = KeyStore.load()
    @State private var destination = Destination.load()
    @State private var showingSettings = false
    @State private var editingDestination = false
    @State private var expanded: UInt32?
    @StateObject private var player = AudioPlayer()
    @ObservedObject private var engine = SyncEngine.shared
    @ObservedObject private var beacon = BeaconWake.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            if let key {
                List {
                    Section { header(key) }
                        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                    if !beacon.enabled {
                        Section {
                            Button { beacon.requestPermission() } label: {
                                Label { VStack(alignment: .leading, spacing: 2) {
                                    Text("Turn on hands-free sync").font(.subheadline.weight(.semibold))
                                    Text("New recordings reach your NAS automatically while the recorder is near.").font(.caption).foregroundStyle(.secondary)
                                } } icon: { Image(systemName: "antenna.radiowaves.left.and.right").foregroundStyle(.tint) }
                            }
                        }
                    }
                    if engine.running && !engine.items.isEmpty {
                        Section("Syncing") {
                            ForEach(engine.items) { item in
                                HStack {
                                    Text(item.id.recordedAt.formatted(date: .abbreviated, time: .shortened))
                                    Spacer()
                                    progress(item.phase)
                                }.font(.subheadline)
                            }
                        }
                    }
                    recordings
                }
                .listStyle(.insetGrouped)
                .navigationTitle("OpenPlod")
                .toolbar { Button { showingSettings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings") }
                .refreshable { await syncNow(key) }
                .sheet(isPresented: $showingSettings) {
                    SettingsView(onUnlinked: { self.key = nil }, onDestinationChanged: { destination = $0 })
                }
                .sheet(isPresented: $editingDestination) { DestinationView { destination = $0 } }
                .task(id: engine.recorderRecording) {
                    // While recording, check every 30 s whether it stopped, then sync.
                    while engine.recorderRecording && scenePhase == .active && !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(30))
                        await engine.checkWhileRecording()
                    }
                }
            } else {
                LinkView { linked in key = linked; RecorderBluetooth.shared.watch(serial: linked.serial); BeaconWake.shared.monitor(serial: linked.serial); SyncEngine.requestNotifications() }
            }
        }
    }

    // MARK: Header

    private func header(_ key: RecorderKey) -> some View {
        VStack(spacing: 16) {
            HStack(alignment: .center, spacing: 18) {
                Image("NotePro").resizable().scaledToFit().frame(width: 74, height: 114)
                    .shadow(color: .black.opacity(0.25), radius: 10, y: 6)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Plaud Note Pro").font(.title3.weight(.semibold))
                    Text("Serial •••• \(key.serial.suffix(4))").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                    statusPill
                }
                Spacer(minLength: 0)
            }
            VStack(spacing: 8) {
                Button { Task { await syncNow(key) } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                        Text(engine.running ? "Syncing…" : "Sync now")
                    }
                    .font(.headline).frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(engine.running || engine.recorderRecording || destination == nil)
                Text(caption).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                if destination == nil {
                    Button("Set up your NAS") { editingDestination = true }.font(.subheadline.weight(.semibold))
                }
            }
        }
        .padding(18)
        .background(.background, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(.horizontal, 2)
    }

    private var statusPill: some View {
        let (text, color, icon): (String, Color, String) =
            engine.running ? ("Syncing", .blue, "arrow.triangle.2.circlepath")
            : engine.recorderRecording ? ("Recording", .red, "record.circle")
            : ("Ready", .green, "checkmark.circle.fill")
        return Label(text, systemImage: icon)
            .font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
    }

    private var caption: String {
        if engine.recorderRecording { return "Recording in progress. Syncs automatically when it stops." }
        if let summary = engine.summary, !engine.running { return summary }
        let nas = destination.flatMap { URL(string: $0.url)?.host() }.map { " to \($0)" } ?? ""
        return engine.lastSync.map { "Last synced\(nas) \($0.formatted(.relative(presentation: .named)))." } ?? "Not synced yet."
    }

    private func syncNow(_ key: RecorderKey) async {
        guard let destination, !engine.recorderRecording else { return }
        await engine.sync(key: key, destination: destination)
    }

    // MARK: Recordings

    @ViewBuilder private var recordings: some View {
        if engine.library.isEmpty {
            Section {
                ContentUnavailableView("No recordings yet", systemImage: "waveform",
                                       description: Text("Recordings on your Plaud appear here after the first sync."))
            }
        } else {
            ForEach(days, id: \.0) { day, items in
                Section(day) {
                    ForEach(items) { item in
                        VStack(spacing: 0) {
                            Button {
                                withAnimation(.snappy) {
                                    player.stop()
                                    expanded = expanded == item.id ? nil : item.id
                                }
                            } label: { row(item) }
                            .buttonStyle(.plain)
                            .disabled(item.place == .otherKey)
                            if expanded == item.id { InlinePlayer(item: item, player: player).transition(.opacity) }
                        }
                    }
                }
            }
        }
    }

    private var days: [(String, [SyncEngine.LibraryItem])] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: engine.library) { calendar.startOfDay(for: $0.date) }
        return grouped.keys.sorted(by: >).map { day in
            let title = calendar.isDateInToday(day) ? "Today" : calendar.isDateInYesterday(day) ? "Yesterday"
                : day.formatted(.dateTime.weekday(.wide).day().month(.wide))
            return (title, grouped[day]!.sorted { $0.id > $1.id })
        }
    }

    private func row(_ item: SyncEngine.LibraryItem) -> some View {
        HStack(spacing: 14) {
            Image(systemName: expanded == item.id && player.playing ? "speaker.wave.2.fill" : "play.fill").font(.body.weight(.medium)).foregroundStyle(.tint)
                .frame(width: 36, height: 36).background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.date.formatted(date: .omitted, time: .shortened)).font(.body.monospacedDigit())
                Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            badge(item.place)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func badge(_ place: SyncEngine.LibraryItem.Place) -> some View {
        let (text, icon, color): (String, String, Color) = switch place {
        case .nas: ("On NAS", "checkmark.circle.fill", .green)
        case .recorder: ("On recorder", "arrow.up.circle", .orange)
        case .otherKey: ("Other key", "key.slash", .secondary)
        }
        return Label(text, systemImage: icon).font(.caption.weight(.medium)).foregroundStyle(color)
    }

    @ViewBuilder private func progress(_ phase: SyncEngine.Phase) -> some View {
        switch phase {
        case .waiting: Text("Waiting").foregroundStyle(.secondary)
        case .downloading: Label("Downloading", systemImage: "arrow.down.circle").foregroundStyle(.blue)
        case .downloaded: Label("Downloaded", systemImage: "arrow.down.circle.fill").foregroundStyle(.secondary)
        case .uploading: Label("Uploading", systemImage: "arrow.up.circle").foregroundStyle(.blue)
        case .done: Label("On NAS", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .unreadable: Label("Other key", systemImage: "key.slash").foregroundStyle(.secondary)
        case .failed(let reason): Label(reason, systemImage: "exclamationmark.triangle").foregroundStyle(.red).lineLimit(2)
        }
    }
}

private extension UInt32 {
    var recordedAt: Date { Date(timeIntervalSince1970: TimeInterval(self)) }
}
