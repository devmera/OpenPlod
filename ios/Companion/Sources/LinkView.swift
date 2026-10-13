import SwiftUI
import VisionKit

/// Links this phone to the recorder key held by OpenPlod on your Mac.
struct LinkView: View {
    var onLinked: (RecorderKey) -> Void
    @State private var scanning = false
    @State private var pasted = ""
    @State private var request: Enrollment.Request?
    @State private var message: String?
    @State private var task: Task<Void, Never>?

    var body: some View {
        Form {
            if let request {
                Section("Approve on your Mac") {
                    Text(request.code).font(.system(size: 44, weight: .semibold, design: .monospaced)).frame(maxWidth: .infinity)
                    Text("In OpenPlod on your Mac, open Plaud device, find Phone authorizations, enter this code and approve.")
                    ProgressView("Waiting for approval…")
                }
                Button("Cancel", role: .cancel) { task?.cancel(); self.request = nil }
            } else {
                Section {
                    Text("In OpenPlod on your Mac, open Android and choose Show pairing QR. The same code links this iPhone.")
                    if DataScannerViewController.isSupported {
                        Button { scanning = true } label: { Label("Scan pairing QR", systemImage: "qrcode.viewfinder") }
                    }
                }
                Section("Or paste the pairing text") {
                    TextField("{\"type\":\"openplod-pairing\",…}", text: $pasted, axis: .vertical).font(.footnote.monospaced())
                    Button("Link with pasted text") { begin(pasted) }.disabled(pasted.isEmpty)
                }
            }
            if let message { Section { Text(message).foregroundStyle(.red) } }
        }
        .navigationTitle("Link to OpenPlod")
        .sheet(isPresented: $scanning) {
            QRScanner { text in scanning = false; begin(text) }.ignoresSafeArea()
        }
    }

    private func begin(_ text: String) {
        message = nil
        task = Task {
            do {
                let enrollment = try Enrollment(pairing: Pairing.parse(text))
                let started = try await enrollment.start()
                request = started
                let key = try await enrollment.waitForKey(started)
                try KeyStore.save(key)
                onLinked(key)
            } catch is CancellationError {
            } catch {
                request = nil
                message = error.localizedDescription
            }
        }
    }
}

/// Camera QR reader (VisionKit).
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items { if let text = code.payloadStringValue, !done { done = true; onCode(text) } }
        }
    }
}
