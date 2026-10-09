#if os(iOS)
import MessageUI
import SwiftUI

/// The system "New Message" sheet with the recipient and text already filled in. The dispatcher
/// reviews it and taps Send; nothing is sent automatically.
struct MessageComposeView: UIViewControllerRepresentable {
    let recipients: [String]
    let body: String
    /// Called when the sheet closes, with whether the message was sent.
    let onFinish: (MessageComposeResult) -> Void

    /// False in the Simulator and on devices with no SMS or iMessage set up.
    static var canSendText: Bool { MFMessageComposeViewController.canSendText() }

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let controller = MFMessageComposeViewController()
        controller.recipients = recipients
        controller.body = body
        controller.messageComposeDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: MFMessageComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let onFinish: (MessageComposeResult) -> Void
        init(onFinish: @escaping (MessageComposeResult) -> Void) { self.onFinish = onFinish }

        func messageComposeViewController(_ controller: MFMessageComposeViewController,
                                          didFinishWith result: MessageComposeResult) {
            onFinish(result)
        }
    }
}
#endif
