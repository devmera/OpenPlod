import SwiftUI

/// The NAS folder recordings are uploaded to, with a connection test before saving.
struct DestinationView: View {
    var onSaved: (Destination) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft = Destination.load() ?? Destination(url: "http://", username: "", password: "")
    @State private var checking = false
    @State private var result: String?
    @State private var ok = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.40:5005/plaud", text: $draft.url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("User name", text: $draft.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $draft.password)
                } header: { Text("WebDAV folder") } footer: {
                    Text("On a Synology: Package Center → WebDAV Server, HTTP port 5005; the address ends with the shared folder. Away from home, use the NAS's Tailscale name. The password stays in this iPhone's Keychain.")
                }
                Section {
                    Button(checking ? "Testing…" : "Test connection") { Task { await test() } }.disabled(checking)
                    if let result { Label(result, systemImage: ok ? "checkmark.circle" : "exclamationmark.triangle").foregroundStyle(ok ? .green : .red) }
                }
            }
            .navigationTitle("NAS")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { do { try draft.save(); onSaved(draft); dismiss() } catch { result = error.localizedDescription; ok = false } }.disabled(!ok)
                }
            }
        }
    }

    private func test() async {
        checking = true; defer { checking = false }
        do { try await WebDAV(destination: draft).check(); ok = true; result = "Connected." }
        catch { ok = false; result = error.localizedDescription }
    }
}
