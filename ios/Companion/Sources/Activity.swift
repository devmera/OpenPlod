import Foundation
import os

/// A short, persisted log of what the companion did on its own (heard the recorder, synced in the
/// background, failed), shown in the app so background behaviour can be checked afterwards.
@MainActor
final class Activity: ObservableObject {
    static let shared = Activity()
    struct Entry: Codable, Identifiable { var id = UUID(); let at: Date; let text: String }

    @Published private(set) var entries: [Entry] = (try? JSONDecoder().decode([Entry].self, from: UserDefaults.standard.data(forKey: "activity") ?? Data())) ?? []
    private let log = Logger(subsystem: "com.openplod.companion", category: "sync")

    func record(_ text: String) {
        log.notice("\(text, privacy: .public)")
        entries.insert(Entry(at: Date(), text: text), at: 0)
        entries = Array(entries.prefix(40))
        UserDefaults.standard.set(try? JSONEncoder().encode(entries), forKey: "activity")
    }
}
