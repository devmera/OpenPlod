import AVFoundation
import SwiftUI

/// Plays one recording: from the phone if a copy is here, otherwise fetched from the NAS and cached.
@MainActor
final class AudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var duration: TimeInterval = 0
    @Published var time: TimeInterval = 0
    @Published private(set) var playing = false
    @Published var rate: Float = 1 { didSet { player?.rate = rate } }
    /// While the user drags the scrubber, playback position updates must not move it.
    var scrubbing = false
    private var player: AVAudioPlayer?
    private var timer: Timer?

    func load(_ url: URL) throws {
        // Plays with the silent switch on and keeps going with the screen locked.
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try AVAudioSession.sharedInstance().setActive(true)
        let player = try AVAudioPlayer(contentsOf: url)
        player.enableRate = true
        player.rate = rate
        player.delegate = self
        player.prepareToPlay()
        self.player = player
        duration = player.duration
    }

    func toggle() {
        guard let player else { return }
        if player.isPlaying { player.pause(); stopTimer() } else { player.play(); startTimer() }
        playing = player.isPlaying
    }

    func seek(to seconds: TimeInterval) {
        guard let player else { return }
        player.currentTime = min(max(0, seconds), duration)
        time = player.currentTime
    }

    func stop() { player?.stop(); stopTimer(); playing = false }

    private func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in if let self, !self.scrubbing, let player = self.player { self.time = player.currentTime } }
        }
    }
    private func stopTimer() { timer?.invalidate(); timer = nil }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.playing = false; self.stopTimer(); self.time = 0 }
    }
}

struct PlayerView: View {
    let item: SyncEngine.LibraryItem
    @StateObject private var player = AudioPlayer()
    @State private var loading = true
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 22) {
            VStack(spacing: 4) {
                Text(item.date.formatted(date: .complete, time: .omitted)).font(.subheadline).foregroundStyle(.secondary)
                Text(item.date.formatted(date: .omitted, time: .shortened)).font(.title2.weight(.semibold))
            }
            if loading {
                ProgressView("Fetching from your NAS…").frame(maxHeight: .infinity)
            } else if let failure {
                ContentUnavailableView("Can't play this recording", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                VStack(spacing: 6) {
                    Slider(value: $player.time, in: 0...max(player.duration, 0.1)) { editing in
                        player.scrubbing = editing
                        if !editing { player.seek(to: player.time) }
                    }
                    HStack {
                        Text(clock(player.time)); Spacer(); Text("-" + clock(player.duration - player.time))
                    }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                HStack(spacing: 44) {
                    Button { player.seek(to: player.time - 15) } label: { Image(systemName: "gobackward.15").font(.title) }
                        .accessibilityLabel("Back 15 seconds")
                    Button { player.toggle() } label: {
                        Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 64))
                    }.accessibilityLabel(player.playing ? "Pause" : "Play")
                    Button { player.seek(to: player.time + 15) } label: { Image(systemName: "goforward.15").font(.title) }
                        .accessibilityLabel("Forward 15 seconds")
                }
                Picker("Speed", selection: $player.rate) {
                    ForEach([Float(1), 1.25, 1.5, 2], id: \.self) { Text("\($0.formatted())×").tag($0) }
                }.pickerStyle(.segmented).frame(maxWidth: 260)
            }
        }
        .padding(24)
        .task {
            do { try player.load(try await SyncEngine.shared.audioFile(for: item)); player.toggle() }
            catch { failure = error.localizedDescription }
            loading = false
        }
        .onDisappear { player.stop() }
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds.rounded())); return String(format: "%d:%02d", total / 60, total % 60)
    }
}
