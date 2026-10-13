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
//   stdin  {"cmd":"start","path":"/abs/file.caf","label":"Zoom"} | {"cmd":"stop"}
//   stdout {"event":"ready"} | {"event":"apps","apps":[{"id","name"}]}
//          {"event":"started","path"} | {"event":"stopped","path","durationSeconds","reason"}
//          {"event":"error","message"}
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

    init(url: URL) { self.url = url }

    var duration: Double { Double(framesWritten) / Self.sampleRate }

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
        for i in 0..<n {
            channels[0][i] = i < left.count ? left[i] : 0
            channels[1][i] = i < right.count ? right[i] : 0
        }
        do {
            try file.write(from: buffer)
            framesWritten += Int64(n)
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

// MARK: - Main loop (all state lives on the main queue)

final class Bridge {
    private var recorder: MeetingRecorder?
    private var lastApps: [String]?
    private let notifier = Notifier()
    private var signalSources: [DispatchSourceSignal] = []

    func run() {
        notifier.onStop = { [weak self] in self?.stop(reason: "notification") }
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
            start(path: path, label: request["label"] as? String ?? "meeting")
        case "stop":
            stop(reason: "command")
        case "apps":
            lastApps = nil
            poll()
        default:
            emit(["event": "error", "message": "Unknown command."])
        }
    }

    private func start(path: String, label: String) {
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
        notifier.clear()
        emit(["event": "stopped", "path": recorder.url.path, "durationSeconds": recorder.duration, "reason": reason])
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
signal(SIGPIPE, SIG_IGN)
let bridge = Bridge()
bridge.run()
// NSApplication (not just a run loop) so workspace and notification callbacks are delivered.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
application.run()
