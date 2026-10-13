import CoreLocation
import Foundation

/// Hands-free sync while phone and recorder are together. With its "iBeacon wake-up" setting on
/// (Plaud setting 49), the Note Pro broadcasts iBeacons whose UUID is the first 15 ASCII bytes of
/// its serial plus a rotating last byte (observed: 00…09, about 10 s each). iOS wakes the app when
/// one of the monitored UUIDs reappears, even after the app was closed, if location access is
/// "Always". The app then syncs if its last check is older than `SyncEngine.beaconInterval`.
/// Location itself is never read or stored.
@MainActor
final class BeaconWake: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = BeaconWake()
    private let manager = CLLocationManager()
    @Published private(set) var authorization: CLAuthorizationStatus

    private override init() {
        authorization = manager.authorizationStatus
        super.init()
        manager.delegate = self   // set at launch so a background relaunch delivers its region event
    }

    var enabled: Bool { authorization == .authorizedAlways }

    /// Starts monitoring the recorder's beacon regions (or stops, for nil).
    func monitor(serial: String?) {
        for region in manager.monitoredRegions where region.identifier.hasPrefix("openplod.beacon.") { manager.stopMonitoring(for: region) }
        guard let serial, enabled, let regions = Self.regions(serial: serial) else { return }
        regions.forEach { manager.startMonitoring(for: $0) }
    }

    /// iOS asks for "While Using" first; "Always" is offered as a second step.
    func requestPermission() {
        if authorization == .notDetermined { manager.requestWhenInUseAuthorization() }
        else { manager.requestAlwaysAuthorization() }
    }

    static func regions(serial: String) -> [CLBeaconRegion]? {
        let prefix = Array(serial.uppercased().utf8.prefix(15))
        guard prefix.count == 15 else { return nil }
        return (0..<5).compactMap { (k: UInt8) in
            let bytes = prefix + [k]
            let uuid = UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                                   bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
            let region = CLBeaconRegion(beaconIdentityConstraint: CLBeaconIdentityConstraint(uuid: uuid), identifier: "openplod.beacon.\(serial).\(k)")
            region.notifyOnEntry = true
            region.notifyOnExit = false
            region.notifyEntryStateOnDisplay = true
            return region
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            authorization = manager.authorizationStatus
            if authorization == .authorizedWhenInUse { manager.requestAlwaysAuthorization() }
            monitor(serial: KeyStore.load()?.serial)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
        guard region.identifier.hasPrefix("openplod.beacon.") else { return }
        Task { @MainActor in SyncEngine.shared.beaconWake() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState, for region: CLRegion) {
        guard state == .inside, region.identifier.hasPrefix("openplod.beacon.") else { return }
        Task { @MainActor in SyncEngine.shared.beaconWake() }
    }
}
