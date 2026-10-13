import CoreBluetooth
import Foundation

/// CoreBluetooth side of the companion. It watches for the linked recorder's advertisement, also in
/// the background (iOS relaunches the app for it thanks to state restoration), and hands the Rust
/// protocol a connected transport. Recordings move only over this one connection at a time.
final class RecorderBluetooth: NSObject, @unchecked Sendable {
    static let shared = RecorderBluetooth()

    /// "PL": the service the Note Pro advertises, which iOS can watch for in the background.
    private static let advertised = CBUUID(string: "504C")
    private static let gatt = CBUUID(string: "1910")
    private static let writeUUID = CBUUID(string: "2BB1")
    private static let notifyUUID = CBUUID(string: "2BB0")

    private let queue = DispatchQueue(label: "com.openplod.companion.bluetooth")
    private var central: CBCentralManager!
    private var serial: String?
    private var heard: (peripheral: CBPeripheral, at: Date)?
    private var connection: Connection?
    private var ready: [CheckedContinuation<Void, Error>] = []
    private var discovered: [CheckedContinuation<CBPeripheral, Error>] = []
    private var connected: CheckedContinuation<Void, Error>?
    private var prepared: CheckedContinuation<Connection, Error>?

    /// Called on the main actor whenever the linked recorder is heard advertising connectably.
    var onHeard: (@MainActor @Sendable () -> Void)?

    private override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: queue,
                                   options: [CBCentralManagerOptionRestoreIdentifierKey: "com.openplod.companion.central"])
    }

    /// Start (or restart) watching for the recorder with this serial.
    func watch(serial: String?) {
        queue.async {
            self.serial = serial?.lowercased()
            self.restartScan()
        }
    }

    private func restartScan() {
        guard central.state == .poweredOn else { return }
        central.stopScan()
        if serial != nil { central.scanForPeripherals(withServices: [Self.advertised]) }
    }

    /// Connects to the recorder, waiting up to `seconds` for it to be heard if it is not already.
    func connect(within seconds: Double = 20) async throws -> Connection {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                if self.central.state == .poweredOn { continuation.resume() }
                else if self.central.state == .unauthorized { continuation.resume(throwing: CompanionFailure("Bluetooth is not allowed for OpenPlod. Allow it in Settings.")) }
                else {
                    self.ready.append(continuation)
                    self.queue.asyncAfter(deadline: .now() + 5) {
                        let pending = self.ready; self.ready.removeAll()
                        pending.forEach { $0.resume(throwing: CompanionFailure("Bluetooth is off.")) }
                    }
                }
            }
        }
        let peripheral: CBPeripheral = try await withCheckedThrowingContinuation { continuation in
            queue.async {
                if let heard = self.heard, Date().timeIntervalSince(heard.at) < 8 { continuation.resume(returning: heard.peripheral); return }
                self.discovered.append(continuation)
                self.restartScan()
                self.queue.asyncAfter(deadline: .now() + seconds) {
                    let pending = self.discovered; self.discovered.removeAll()
                    pending.forEach { $0.resume(throwing: CompanionFailure("The recorder was not heard. Press its button and keep it close.")) }
                }
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.prepared = continuation
                self.central.connect(peripheral)
                self.queue.asyncAfter(deadline: .now() + 15) {
                    guard let waiting = self.prepared else { return }
                    self.prepared = nil
                    self.central.cancelPeripheralConnection(peripheral)
                    waiting.resume(throwing: CompanionFailure("Could not connect to the recorder."))
                }
            }
        }
    }

    /// Disconnects promptly so the recorder can go back to sleep, then keeps watching.
    func disconnect(_ connection: Connection) {
        queue.async {
            self.central.cancelPeripheralConnection(connection.peripheral)
            self.connection = nil
            self.heard = nil
            self.restartScan()
        }
    }

    /// The Note Pro puts its 16-hex-digit serial into its Realtek manufacturer data.
    private func isLinkedRecorder(_ advertisement: [String: Any]) -> Bool {
        if (advertisement[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue == false { return false }
        guard let serial, let data = advertisement[CBAdvertisementDataManufacturerDataKey] as? Data else { return true }
        return data.map { String(format: "%02x", $0) }.joined().contains(serial)
    }
}

extension RecorderBluetooth: CBCentralManagerDelegate {
    func centralManager(_ central: CBCentralManager, willRestoreState state: [String: Any]) {
        // Relaunched by iOS for the recorder; scanning resumes once Bluetooth is powered on.
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            ready.forEach { $0.resume() }; ready.removeAll()
            restartScan()
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard isLinkedRecorder(advertisementData) else { return }
        heard = (peripheral, Date())
        discovered.forEach { $0.resume(returning: peripheral) }; discovered.removeAll()
        if let onHeard { Task { @MainActor in onHeard() } }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices([Self.gatt])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        prepared?.resume(throwing: CompanionFailure("Could not connect to the recorder: \(error?.localizedDescription ?? "unknown error")."))
        prepared = nil
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        connection?.closed()
        connection = nil
        prepared?.resume(throwing: CompanionFailure("The recorder disconnected."))
        prepared = nil
    }
}

extension RecorderBluetooth: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.gatt }) else {
            return abort(peripheral, "The recorder does not offer its data service.")
        }
        peripheral.discoverCharacteristics([Self.writeUUID, Self.notifyUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let write = service.characteristics?.first(where: { $0.uuid == Self.writeUUID }),
              let notify = service.characteristics?.first(where: { $0.uuid == Self.notifyUUID }) else {
            return abort(peripheral, "The recorder does not offer the expected characteristics.")
        }
        connection = Connection(peripheral: peripheral, characteristic: write, queue: queue)
        peripheral.setNotifyValue(true, for: notify)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let connection, characteristic.isNotifying else { return abort(peripheral, "Could not subscribe to the recorder.") }
        prepared?.resume(returning: connection)
        prepared = nil
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if characteristic.uuid == Self.notifyUUID, let value = characteristic.value { connection?.received(value) }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        connection?.writable()
    }

    private func abort(_ peripheral: CBPeripheral, _ message: String) {
        prepared?.resume(throwing: CompanionFailure(message))
        prepared = nil
        central.cancelPeripheralConnection(peripheral)
    }
}

/// One connected recorder as the Rust protocol sees it: write a frame, wait for the next
/// notification. All state is touched on the Bluetooth queue.
final class Connection: RecorderTransport, @unchecked Sendable {
    let peripheral: CBPeripheral
    private let characteristic: CBCharacteristic
    private let queue: DispatchQueue
    private var inbox: [Data] = []
    private var waiting: (id: UUID, continuation: CheckedContinuation<Data, Error>)?
    private var pendingWrites: [(Data, CheckedContinuation<Void, Error>)] = []
    private var isClosed = false

    init(peripheral: CBPeripheral, characteristic: CBCharacteristic, queue: DispatchQueue) {
        self.peripheral = peripheral; self.characteristic = characteristic; self.queue = queue
    }

    func write(frame: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                if self.isClosed { return continuation.resume(throwing: CompanionError.Failed(message: "The recorder disconnected.")) }
                self.pendingWrites.append((frame, continuation))
                self.writable()
            }
        }
    }

    func next(timeoutMs: UInt64) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                if !self.inbox.isEmpty { return continuation.resume(returning: self.inbox.removeFirst()) }
                if self.isClosed { return continuation.resume(throwing: CompanionError.Failed(message: "The recorder disconnected.")) }
                let id = UUID()
                self.waiting = (id, continuation)
                self.queue.asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs))) {
                    guard let waiting = self.waiting, waiting.id == id else { return }
                    self.waiting = nil
                    waiting.continuation.resume(throwing: CompanionError.Failed(message: "The recorder stopped answering."))
                }
            }
        }
    }

    /// Writes queued frames while iOS has room (write without response, as the Plaud app does).
    func writable() {
        while let (frame, continuation) = pendingWrites.first, peripheral.canSendWriteWithoutResponse {
            pendingWrites.removeFirst()
            peripheral.writeValue(frame, for: characteristic, type: .withoutResponse)
            continuation.resume()
        }
    }

    func received(_ value: Data) {
        if let waiting { self.waiting = nil; waiting.continuation.resume(returning: value) } else { inbox.append(value) }
    }

    func closed() {
        isClosed = true
        waiting?.continuation.resume(throwing: CompanionError.Failed(message: "The recorder disconnected."))
        waiting = nil
        pendingWrites.forEach { $0.1.resume(throwing: CompanionError.Failed(message: "The recorder disconnected.")) }
        pendingWrites.removeAll()
    }
}
