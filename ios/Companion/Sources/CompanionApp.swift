import BackgroundTasks
import SwiftUI
import UIKit

@main
struct CompanionApp: App {
    @Environment(\.scenePhase) private var scenePhase
    static let refreshTask = "com.openplod.companion.refresh"

    init() {
        // Created at every launch, including when iOS relaunches the app in the background because
        // the recorder was heard (Bluetooth state restoration).
        RecorderBluetooth.shared.onHeard = { SyncEngine.shared.recorderHeard() }
        RecorderBluetooth.shared.watch(serial: KeyStore.load()?.serial)
        if KeyStore.load() != nil { SyncEngine.requestNotifications() }
        // Must be registered before launch finishes.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTask, using: nil) { task in
            Self.scheduleRefresh()
            let work = Task { @MainActor in
                RecorderBluetooth.shared.watch(serial: KeyStore.load()?.serial)
                await SyncEngine.shared.backgroundRefresh()
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
        Task { @MainActor in
            let background = UIApplication.shared.applicationState == .background
            Activity.shared.record(background ? "Launched by iOS in the background" : "App opened; listening for the recorder")
        }
    }

    /// Asks iOS for a background refresh in about 15 minutes; iOS decides when it actually runs.
    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTask)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    var body: some Scene {
        WindowGroup { RecorderView() }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    // A fresh scan makes iOS report the recorder again, even if it never stopped advertising.
                    RecorderBluetooth.shared.watch(serial: KeyStore.load()?.serial)
                    SyncEngine.shared.appOpened()
                case .background: Self.scheduleRefresh()
                default: break
                }
            }
    }
}
