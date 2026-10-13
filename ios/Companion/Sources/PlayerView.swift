import AVFoundation
import MediaPlayer
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

    private var title = "Recording"
    private var commandsReady = false

    /// Session setup and file opening run off the main thread, so expanding a row stays smooth.
    /// `title` is what the lock screen and Dynamic Island show.
    func load(_ url: URL, title: String) async throws {
        self.title = title
        setUpRemoteCommands()
        let rate = rate
        let prepared: AVAudioPlayer = try await Task.detached(priority: .userInitiated) {
            // Plays with the silent switch on and keeps going with the screen locked.
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            let player = try AVAudioPlayer(contentsOf: url)
            player.enableRate = true
            player.rate = rate
            player.prepareToPlay()
            return player
        }.value
        prepared.delegate = self
        player = prepared
        duration = prepared.duration
        time = 0
        updateNowPlaying()
    }

    /// Lock screen, Control Center and Dynamic Island show the recording while it plays.
    private func updateNowPlaying() {
        guard let player else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: "Plaud Note Pro",
            MPMediaItemPropertyPlaybackDuration: player.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player.currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: player.isPlaying ? Double(player.rate) : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if let image = UIImage(named: "NotePro") {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func setUpRemoteCommands() {
        guard !commandsReady else { return }
        commandsReady = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.remote { if !$0.playing { $0.toggle() } }; return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.remote { if $0.playing { $0.toggle() } }; return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.remote { $0.toggle() }; return .success }
        center.skipForwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipForwardCommand.addTarget { [weak self] _ in self?.remote { $0.seek(to: $0.time + 15) }; return .success }
        center.skipBackwardCommand.addTarget { [weak self] _ in self?.remote { $0.seek(to: $0.time - 15) }; return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.remote { $0.seek(to: event.positionTime) }
            return .success
        }
    }

    private nonisolated func remote(_ action: @escaping @MainActor (AudioPlayer) -> Void) {
        Task { @MainActor in action(self) }
    }

    func toggle() {
        guard let player else { return }
        if player.isPlaying { player.pause(); stopTimer() } else { player.play(); startTimer() }
        playing = player.isPlaying
        updateNowPlaying()
    }

    func seek(to seconds: TimeInterval) {
        guard let player else { return }
        player.currentTime = min(max(0, seconds), duration)
        time = player.currentTime
        updateNowPlaying()
    }

    func stop() {
        player?.stop(); player = nil; stopTimer()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        if playing { playing = false }
        if time != 0 { time = 0 }
    }

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

/// The player shown inside an expanded recording row.
struct InlinePlayer: View {
    let item: SyncEngine.LibraryItem
    @ObservedObject var player: AudioPlayer
    @State private var loading = true
    @State private var failure: String?

    var body: some View {
        ZStack {
            if loading {
                HStack(spacing: 10) { ProgressView(); Text("Preparing audio…").font(.subheadline).foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, minHeight: 60)
            } else if let failure {
                Label(failure, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 10) {
                    VStack(spacing: 2) {
                        Slider(value: $player.time, in: 0...max(player.duration, 0.1)) { editing in
                            player.scrubbing = editing
                            if !editing { player.seek(to: player.time) }
                        }
                        HStack { Text(clock(player.time)); Spacer(); Text("-" + clock(player.duration - player.time)) }
                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    HStack {
                        Menu {
                            Picker("Speed", selection: $player.rate) {
                                ForEach([Float(1), 1.25, 1.5, 2], id: \.self) { Text("\($0.formatted())×").tag($0) }
                            }
                        } label: { Text("\(player.rate.formatted())×").font(.subheadline.weight(.semibold).monospacedDigit()).frame(width: 52, alignment: .leading) }
                        Spacer()
                        HStack(spacing: 30) {
                            Button { player.seek(to: player.time - 15) } label: { Image(systemName: "gobackward.15").font(.title3) }
                                .accessibilityLabel("Back 15 seconds")
                            Button { player.toggle() } label: {
                                Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 44))
                            }.accessibilityLabel(player.playing ? "Pause" : "Play")
                            Button { player.seek(to: player.time + 15) } label: { Image(systemName: "goforward.15").font(.title3) }
                                .accessibilityLabel("Forward 15 seconds")
                        }
                        Spacer()
                        Color.clear.frame(width: 52, height: 1)
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
        // One height in every state, so the row grows once.
        .frame(height: 96)
        .padding(.top, 4)
        .task(id: item.id) {
            loading = true; failure = nil
            do {
                let title = "Recording " + item.date.formatted(date: .abbreviated, time: .shortened)
                try await player.load(try await SyncEngine.shared.playableFile(for: item), title: title)
                player.toggle()
            }
            catch { failure = error.localizedDescription }
            loading = false
        }
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let total = Int(max(0, seconds.rounded())); return String(format: "%d:%02d", total / 60, total % 60)
    }
}
