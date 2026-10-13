import SwiftUI
import UIKit

@main
struct CompanionApp: App {
    init() {
        // Created at every launch, including when iOS relaunches the app in the background because
        // the recorder was heard (Bluetooth state restoration).
        RecorderBluetooth.shared.onHeard = { SyncEngine.shared.recorderHeard() }
        RecorderBluetooth.shared.watch(serial: KeyStore.load()?.serial)
        if KeyStore.load() != nil { SyncEngine.requestNotifications() }
        Task { @MainActor in
            let background = UIApplication.shared.applicationState == .background
            Activity.shared.record(background ? "Launched by iOS in the background" : "App opened; listening for the recorder")
        }
    }

    var body: some Scene {
        WindowGroup { RecorderView() }
    }
}
