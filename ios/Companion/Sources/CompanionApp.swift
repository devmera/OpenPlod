import SwiftUI

@main
struct CompanionApp: App {
    init() {
        // Created at every launch, including when iOS relaunches the app in the background because
        // the recorder was heard (Bluetooth state restoration).
        RecorderBluetooth.shared.onHeard = { SyncEngine.shared.recorderHeard() }
        RecorderBluetooth.shared.watch(serial: KeyStore.load()?.serial)
    }

    var body: some Scene {
        WindowGroup { RecorderView() }
    }
}
