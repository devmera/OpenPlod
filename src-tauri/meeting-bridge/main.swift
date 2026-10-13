// meeting-bridge: the macOS helper behind OpenPlod's meeting recorder.
//
// It does two things and leaves every decision to the vault server:
//   1. Reports which known meeting apps are capturing the microphone, using the
//      public Core Audio process objects (macOS 14.2+). Video playback or a muted
//      browser tab never counts; only microphone input does.
//   2. On request, records one stereo file: left = this Mac's microphone (you),
//      right = everything the Mac plays (the other participants), through a Core
//      Audio process tap. Separate channels avoid echo cancellation when you wear
//      headphones and keep the two sides distinguishable.
//
// Protocol: one JSON object per line.
//   stdin  {"cmd":"start","path":"/abs/file.caf","label":"Zoom","bar":true} | {"cmd":"stop"}
//   stdout {"event":"ready"} | {"event":"apps","apps":[{"id","name"}]}
//          {"event":"started","path"} | {"event":"stopped","path","durationSeconds","reason"}
//          {"event":"mark","path","seconds","note"} | {"event":"error","message"}
//
// While recording, an optional floating bar (see `RecordingBar`) shows a level
// meter and offers Stop and "mark this moment"; marks become bookmarks.
//
// The recording is 16-bit PCM in a CAF container: unlike compressed CAF it stays
// readable if the process dies mid-meeting (no packet table to finalise). The
// server converts it to .m4a for the vault and deletes the staging file. The helper never touches the
// network and never reads or writes anything except the path it is given.

import AppKit
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import UserNotifications

// MARK: - Output

let outputLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    outputLock.unlock()
}

// MARK: - Known meeting apps

struct MeetingApp: Hashable {
    let id: String
    let name: String
    let bundlePrefixes: [String]

    static let known: [MeetingApp] = [
        MeetingApp(id: "zoom", name: "Zoom", bundlePrefixes: ["us.zoom."]),
        MeetingApp(id: "teams", name: "Microsoft Teams", bundlePrefixes: ["com.microsoft.teams"]),
        MeetingApp(id: "slack", name: "Slack", bundlePrefixes: ["com.tinyspeck.slackmacgap"]),
        MeetingApp(id: "webex", name: "Webex", bundlePrefixes: ["Cisco-Systems.Spark", "com.webex.", "com.cisco.webex"]),
        MeetingApp(id: "facetime", name: "FaceTime", bundlePrefixes: ["com.apple.FaceTime", "com.apple.avconferenced"]),
        MeetingApp(id: "discord", name: "Discord", bundlePrefixes: ["com.hnc.Discord"]),
        MeetingApp(id: "whatsapp", name: "WhatsApp", bundlePrefixes: ["net.whatsapp.WhatsApp", "desktop.WhatsApp"]),
        MeetingApp(id: "tuple", name: "Tuple", bundlePrefixes: ["app.tuple."]),
        MeetingApp(id: "lark", name: "Lark / Feishu", bundlePrefixes: ["com.bytedance.lark", "com.electron.lark"]),
        // Browser calls (Google Meet, Teams on the web, ...).
        MeetingApp(id: "browser", name: "Browser call", bundlePrefixes: [
            "com.google.Chrome", "com.apple.WebKit", "com.apple.Safari", "org.mozilla.firefox",
            "company.thebrowser.", "com.brave.Browser", "com.microsoft.edgemac",
            "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
        ]),
    ]

    static func matching(bundleID: String) -> MeetingApp? {
        known.first { app in app.bundlePrefixes.contains { bundleID.hasPrefix($0) } }
    }
}

// MARK: - Core Audio property helpers

enum CoreAudioProperty {
    struct Failure: Error, CustomStringConvertible {
        let what: String
        let status: OSStatus
        var description: String { "\(what) failed (OSStatus \(status))" }
    }

    static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                   mElement: kAudioObjectPropertyElementMain)
    }

    static func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, initial: T) throws -> T {
        var addr = address(selector)
        var size = UInt32(MemoryLayout<T>.size)
        var value = initial
        let err = withUnsafeMutableBytes(of: &value) {
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0.baseAddress!)
        }
        guard err == noErr else { throw Failure(what: "read property \(selector)", status: err) }
        return value
    }

    static func readArray<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, element: T) throws -> [T] {
        var addr = address(selector)
        var size: UInt32 = 0
        var err = AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size)
        guard err == noErr else { throw Failure(what: "size of property \(selector)", status: err) }
        var items = [T](repeating: element, count: Int(size) / MemoryLayout<T>.stride)
        guard !items.isEmpty else { return [] }
        err = items.withUnsafeMutableBytes { AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0.baseAddress!) }
        guard err == noErr else { throw Failure(what: "read property \(selector)", status: err) }
        return Array(items.prefix(Int(size) / MemoryLayout<T>.stride))
    }

    static func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var value: Unmanaged<CFString>?
        let err = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
        guard err == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    static func processObject(for pid: pid_t) -> AudioObjectID? {
        var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var qualifier = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr,
                                             UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
        guard err == noErr, object != kAudioObjectUnknown else { return nil }
        return object
    }

    static func defaultOutputDeviceUID() throws -> String {
        let device = try read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice,
                              initial: AudioDeviceID(kAudioObjectUnknown))
        guard let uid = readString(device, kAudioDevicePropertyDeviceUID) else {
            throw Failure(what: "default output device UID", status: -1)
        }
        return uid
    }
}

// MARK: - Detection

enum MeetingDetector {
    /// Meeting apps currently capturing the microphone (our own process excluded).
    static func activeApps() -> [MeetingApp] {
        guard let processes = try? CoreAudioProperty.readArray(
            AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList,
            element: AudioObjectID(kAudioObjectUnknown))
        else { return [] }
        let me = ProcessInfo.processInfo.processIdentifier
        var found: [MeetingApp] = []
        for process in processes {
            guard let running = try? CoreAudioProperty.read(process, kAudioProcessPropertyIsRunningInput, initial: UInt32(0)),
                  running != 0,
                  let pid = try? CoreAudioProperty.read(process, kAudioProcessPropertyPID, initial: pid_t(0)),
                  pid != me,
                  let bundle = CoreAudioProperty.readString(process, kAudioProcessPropertyBundleID),
                  let app = MeetingApp.matching(bundleID: bundle),
                  !found.contains(app)
            else { continue }
            found.append(app)
        }
        return found.sorted { $0.id < $1.id }
    }
}

// MARK: - Recording

enum RecorderError: Error, CustomStringConvertible {
    case noMicrophone
    case microphoneDenied
    case tap(String, OSStatus)

    var description: String {
        switch self {
        case .noMicrophone: return "No microphone is available."
        case .microphoneDenied:
            return "OpenPlod needs microphone access (System Settings > Privacy & Security > Microphone)."
        case .tap(let what, let status):
            return "System audio capture failed: \(what) (OSStatus \(status)). Allow OpenPlod under "
                + "System Settings > Privacy & Security > Screen & System Audio Recording."
        }
    }
}

final class MeetingRecorder {
    static let sampleRate: Double = 48_000

    let url: URL
    private let writerQueue = DispatchQueue(label: "openplod.meeting.writer")
    private let mic = SampleFIFO()
    private let system = SampleFIFO()
    private var file: AVAudioFile?
    private var flushTimer: DispatchSourceTimer?
    private var engine: AVAudioEngine?
    private var tap: SystemAudioTap?
    private(set) var framesWritten: Int64 = 0
    /// Elapsed audio and the latest peak, read by the bar from the main thread.
    private let statsLock = NSLock()
    private var peak: Float = 0

    init(url: URL) { self.url = url }

    var duration: Double { statsLock.lock(); defer { statsLock.unlock() }; return Double(framesWritten) / Self.sampleRate }
    var level: Float { statsLock.lock(); defer { statsLock.unlock() }; return peak }

    func start() throws {
        file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: Self.sampleRate,
            AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)

        let tap = SystemAudioTap()
        do { try tap.start { [system] samples in system.append(samples) } } catch { file = nil; throw error }
        self.tap = tap

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else { stopCapture(); file = nil; throw RecorderError.noMicrophone }
        let downmix = Downmixer(from: inFormat)
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [mic] buffer, _ in
            mic.append(downmix.convert(buffer))
        }
        do { try engine.start() } catch { input.removeTap(onBus: 0); stopCapture(); file = nil; throw error }
        self.engine = engine

        let timer = DispatchSource.makeTimerSource(queue: writerQueue)
        timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in self?.flush(final: false) }
        timer.resume()
        flushTimer = timer
    }

    /// Stops capture and finalises the file. Synchronous so it is safe from sleep handlers.
    func stop() {
        stopCapture()
        writerQueue.sync {
            flushTimer?.cancel()
            flushTimer = nil
            flush(final: true)
            file = nil // AVAudioFile finalises the container on release
        }
    }

    private func stopCapture() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        tap?.stop()
        tap = nil
    }

    /// Pairs mic and system samples. A side lagging by more than half a second (not
    /// started yet, or its device went away) is padded with silence.
    private func flush(final: Bool) {
        guard let file else { return }
        let maxLag = Int(Self.sampleRate / 2)
        let m = mic.count, s = system.count
        var n = min(m, s)
        if final { n = max(m, s) } else if max(m, s) - n > maxLag { n = max(m, s) - maxLag }
        guard n > 0 else { return }
        let left = mic.take(n), right = system.take(n)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(n)),
              let channels = buffer.floatChannelData else { return }
        buffer.frameLength = AVAudioFrameCount(n)
        var loudest: Float = 0
        for i in 0..<n {
            channels[0][i] = i < left.count ? left[i] : 0
            channels[1][i] = i < right.count ? right[i] : 0
            loudest = max(loudest, abs(channels[0][i]), abs(channels[1][i]))
        }
        do {
            try file.write(from: buffer)
            statsLock.lock(); framesWritten += Int64(n); peak = loudest; statsLock.unlock()
        } catch {
            emit(["event": "error", "message": "Meeting audio could not be written: \(error.localizedDescription)"])
        }
    }
}

/// A global mono tap of every process except ours, read through a private aggregate device.
final class SystemAudioTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "openplod.meeting.tap", qos: .userInitiated)

    func start(onSamples: @escaping ([Float]) -> Void) throws {
        let ownProcess = CoreAudioProperty.processObject(for: ProcessInfo.processInfo.processIdentifier)
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: ownProcess.map { [$0] } ?? [])
        description.uuid = UUID()
        description.muteBehavior = .unmuted
        description.isPrivate = true

        var err = AudioHardwareCreateProcessTap(description, &tapID)
        guard err == noErr else { throw RecorderError.tap("create process tap", err) }

        var asbd = try CoreAudioProperty.read(tapID, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription())
        guard let tapFormat = AVAudioFormat(streamDescription: &asbd) else {
            stop()
            throw RecorderError.tap("unsupported tap format", -1)
        }

        let outputUID = try CoreAudioProperty.defaultOutputDeviceUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OpenPlod meeting tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        err = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard err == noErr else { stop(); throw RecorderError.tap("create aggregate device", err) }

        let downmix = Downmixer(from: tapFormat)
        err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: input, deallocator: nil)
            else { return }
            onSamples(downmix.convert(buffer))
        }
        guard err == noErr else { stop(); throw RecorderError.tap("create IO proc", err) }

        // The first start triggers the system's "record system audio" prompt.
        err = AudioDeviceStart(aggregateID, procID)
        guard err == noErr else { stop(); throw RecorderError.tap("start aggregate device", err) }
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    deinit { stop() }
}

/// Converts any PCM buffer to mono Float32 at `MeetingRecorder.sampleRate`.
final class Downmixer {
    private let converter: AVAudioConverter?
    private let output: AVAudioFormat

    init(from input: AVAudioFormat) {
        output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: MeetingRecorder.sampleRate,
                               channels: 1, interleaved: false)!
        converter = AVAudioConverter(from: input, to: output)
        converter?.downmix = true
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let converter, buffer.frameLength > 0 else { return [] }
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return [] }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let data = out.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
    }
}

/// A lock-protected sample queue between a capture callback and the writer.
final class SampleFIFO {
    private var samples: [Float] = []
    private let lock = NSLock()

    var count: Int { lock.lock(); defer { lock.unlock() }; return samples.count }

    func append(_ new: [Float]) {
        guard !new.isEmpty else { return }
        lock.lock(); samples.append(contentsOf: new); lock.unlock()
    }

    func take(_ n: Int) -> [Float] {
        lock.lock(); defer { lock.unlock() }
        let k = min(n, samples.count)
        let head = Array(samples.prefix(k))
        samples.removeFirst(k)
        return head
    }
}

// MARK: - Notifications (only when running inside the app bundle)

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onStop: (() -> Void)?
    private let category = "openplod.meeting"
    private let stopAction = "openplod.meeting.stop"
    private let requestID = "openplod.meeting.active"
    /// UNUserNotificationCenter aborts in a process without a bundle (a dev build).
    private let available = Bundle.main.bundleIdentifier != nil

    func register() {
        guard available else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let stop = UNNotificationAction(identifier: stopAction, title: "Stop recording", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: category, actions: [stop], intentIdentifiers: [])])
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func post(title: String, body: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.categoryIdentifier = category
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: requestID, content: content, trigger: nil))
    }

    func clear() {
        guard available else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [requestID])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == stopAction { DispatchQueue.main.async { self.onStop?() } }
        completionHandler()
    }
}

// MARK: - Floating recording bar

/// A borderless panel that can take keyboard focus for the note field without
/// activating the helper or pulling focus from the call before that.
final class BarPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Five bars driven by the recording's peak level, smoothed so it reads calmly.
final class LevelMeter: NSView {
    var level: CGFloat = 0 { didSet { needsDisplay = true } }
    override var intrinsicContentSize: NSSize { NSSize(width: 22, height: 18) }

    override func draw(_ dirtyRect: NSRect) {
        let weights: [CGFloat] = [0.45, 0.8, 1, 0.7, 0.5]
        let width: CGFloat = 2.5, gap = (bounds.width - width * 5) / 4
        NSColor.labelColor.setFill()
        for (index, weight) in weights.enumerated() {
            let height = max(3, bounds.height * min(1, level * weight * 1.6))
            let rect = NSRect(x: CGFloat(index) * (width + gap), y: (bounds.height - height) / 2, width: width, height: height)
            NSBezierPath(roundedRect: rect, xRadius: width / 2, yRadius: width / 2).fill()
        }
    }
}

/// The floating bar shown while a meeting is recorded: OpenPlod mark (opens the
/// app), level meter, Stop, and a pen that marks the current moment with an
/// optional note. It floats on every Space, can be dragged and remembers where.
final class RecordingBar: NSObject, NSPopoverDelegate {
    var onStop: (() -> Void)?
    var onMark: ((Double, String) -> Void)?
    var elapsed: () -> Double = { 0 }
    var level: () -> Float = { 0 }

    private var panel: BarPanel?
    private let meter = LevelMeter()
    private var timer: Timer?
    private var popover: NSPopover?
    private var noteField: NSTextField?
    private var pendingMark: Double?

    func show() {
        guard panel == nil else { return }
        let size = NSSize(width: 44, height: 168)
        let panel = BarPanel(contentRect: NSRect(origin: .zero, size: size),
                             styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true

        let background = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 12
        background.layer?.masksToBounds = true
        panel.contentView = background

        let separator = NSBox()
        separator.boxType = .separator
        let stop = button("stop.fill", "Stop recording", #selector(stopTapped))
        stop.contentTintColor = .systemRed
        let stack = NSStackView(views: [
            accent(button("waveform.circle.fill", "Open OpenPlod", #selector(openTapped))), meter, separator,
            stop, button("square.and.pencil", "Mark this moment", #selector(markTapped)),
        ])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: background.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            separator.widthAnchor.constraint(equalToConstant: 22),
        ])

        if !panel.setFrameUsingName("OpenPlodRecordingBar"), let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: frame.maxX - size.width - 24, y: frame.midY - size.height / 2))
        }
        panel.setFrameAutosaveName("OpenPlodRecordingBar")
        panel.orderFrontRegardless()
        self.panel = panel
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            // Rise fast, fall slowly; the recorder's peak updates four times a second.
            let target = CGFloat(min(1, sqrt(self.level())))
            self.meter.level = target > self.meter.level ? target : self.meter.level * 0.85
            self.panel?.contentView?.toolTip = "Recording · \(Self.clock(self.elapsed()))"
        }
    }

    func hide() {
        timer?.invalidate()
        timer = nil
        popover?.close()
        panel?.orderOut(nil)
        panel = nil
    }

    private func accent(_ button: NSButton) -> NSButton {
        button.contentTintColor = .controlAccentColor
        return button
    }

    private func button(_ symbol: String, _ label: String, _ action: Selector) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(.init(pointSize: 17, weight: .medium)) ?? NSImage()
        let button = NSButton(image: image, target: self, action: action)
        button.isBordered = false
        button.toolTip = label
        button.setAccessibilityLabel(label)
        return button
    }

    @objc private func openTapped() {
        // The helper lives inside OpenPlod.app; opening the bundle brings its window forward.
        guard Bundle.main.bundleIdentifier != nil else { return }
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: NSWorkspace.OpenConfiguration())
    }

    @objc private func stopTapped() { onStop?() }

    @objc private func markTapped(_ sender: NSButton) {
        if popover != nil { return }
        pendingMark = elapsed()
        let field = NSTextField(frame: NSRect(x: 10, y: 10, width: 220, height: 24))
        field.placeholderString = "Note for \(Self.clock(pendingMark ?? 0)) (optional)"
        field.target = self
        field.action = #selector(noteEntered)
        let content = NSViewController()
        content.view = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 44))
        content.view.addSubview(field)
        let popover = NSPopover()
        popover.contentViewController = content
        popover.behavior = .transient
        popover.delegate = self
        self.popover = popover
        noteField = field
        panel?.makeKey()
        popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minX)
        panel?.makeFirstResponder(field)
    }

    @objc private func noteEntered() { popover?.performClose(nil) }

    // Closing the popover by any route saves the mark, with whatever note was typed.
    func popoverDidClose(_ notification: Notification) {
        if let seconds = pendingMark { onMark?(seconds, noteField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") }
        pendingMark = nil
        noteField = nil
        popover = nil
    }

    static func clock(_ seconds: Double) -> String {
        let total = Int(seconds)
        return total >= 3600 ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
            : String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Main loop (all state lives on the main queue)

final class Bridge {
    private var recorder: MeetingRecorder?
    private var lastApps: [String]?
    private let notifier = Notifier()
    private let bar = RecordingBar()
    private var signalSources: [DispatchSourceSignal] = []

    func run() {
        notifier.onStop = { [weak self] in self?.stop(reason: "notification") }
        bar.onStop = { [weak self] in self?.stop(reason: "bar") }
        bar.onMark = { [weak self] seconds, note in
            guard let path = self?.recorder?.url.path else { return }
            emit(["event": "mark", "path": path, "seconds": seconds, "note": note])
        }
        bar.elapsed = { [weak self] in self?.recorder?.duration ?? 0 }
        bar.level = { [weak self] in self?.recorder?.level ?? 0 }
        notifier.register()
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willSleepNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.stop(reason: "sleep") }

        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                self?.stop(reason: "shutdown")
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }

        emit(["event": "ready"])
        poll()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }

        Thread.detachNewThread { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                DispatchQueue.main.async { self?.handle(request) }
            }
            // The server went away: finish the file so it can be recovered, then exit.
            DispatchQueue.main.async {
                self?.stop(reason: "shutdown")
                exit(0)
            }
        }
    }

    private func poll() {
        let apps = MeetingDetector.activeApps()
        let ids = apps.map(\.id)
        guard ids != lastApps else { return }
        lastApps = ids
        emit(["event": "apps", "apps": apps.map { ["id": $0.id, "name": $0.name] }])
    }

    private func handle(_ request: [String: Any]) {
        switch request["cmd"] as? String {
        case "start":
            guard let path = request["path"] as? String, path.hasPrefix("/"), path.hasSuffix(".caf") else {
                emit(["event": "error", "message": "Invalid recording path."]); return
            }
            start(path: path, label: request["label"] as? String ?? "meeting", showBar: request["bar"] as? Bool ?? true)
        case "stop":
            stop(reason: "command")
        case "apps":
            lastApps = nil
            poll()
        default:
            emit(["event": "error", "message": "Unknown command."])
        }
    }

    private func start(path: String, label: String, showBar: Bool) {
        guard recorder == nil else { emit(["event": "error", "message": "A meeting is already being recorded."]); return }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard granted else { emit(["event": "error", "message": RecorderError.microphoneDenied.description]); return }
                guard self.recorder == nil else { return }
                let url = URL(fileURLWithPath: path)
                do {
                    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    let recorder = MeetingRecorder(url: url)
                    try recorder.start()
                    self.recorder = recorder
                    emit(["event": "started", "path": path])
                    if showBar { self.bar.show() }
                    self.notifier.post(title: "Recording \(label)",
                                       body: "Saved to your OpenPlod vault. Stops when the call ends.")
                } catch {
                    try? FileManager.default.removeItem(at: url)
                    emit(["event": "error", "message": "\(error)"])
                }
            }
        }
    }

    private func stop(reason: String) {
        guard let recorder else { return }
        recorder.stop()
        self.recorder = nil
        bar.hide()
        notifier.clear()
        emit(["event": "stopped", "path": recorder.url.path, "durationSeconds": recorder.duration, "reason": reason])
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)
let bridge = Bridge()
let preview = RecordingBar()
if CommandLine.arguments.contains("--preview-bar") {
    // Development aid: the bar with a simulated meter, no recording; prints its frame.
    let started = Date()
    preview.elapsed = { Date().timeIntervalSince(started) }
    preview.level = { Float(abs(sin(Date().timeIntervalSince(started) * 3))) * 0.6 }
    preview.onMark = { seconds, note in emit(["event": "mark", "seconds": seconds, "note": note]) }
    preview.onStop = { exit(0) }
    DispatchQueue.main.async {
        preview.show()
        if let frame = NSApp.windows.first(where: { $0 is BarPanel })?.frame, let screen = NSScreen.main {
            emit(["event": "preview", "x": frame.minX, "y": screen.frame.height - frame.maxY, "width": frame.width, "height": frame.height])
        }
        // OPENPLOD_BAR_SNAPSHOT=/path.png renders the bar to an image after a second.
        if let output = ProcessInfo.processInfo.environment["OPENPLOD_BAR_SNAPSHOT"],
           let view = NSApp.windows.first(where: { $0 is BarPanel })?.contentView {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: output))
                emit(["event": "snapshot", "path": output])
            }
        }
    }
} else {
    bridge.run()
}
// NSApplication (not just a run loop) so workspace and notification callbacks are delivered.
let application = NSApplication.shared
// Accessory: no Dock icon or menu, but allowed to show the floating bar.
application.setActivationPolicy(.accessory)
application.run()
