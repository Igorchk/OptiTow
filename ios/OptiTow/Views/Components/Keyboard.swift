import SwiftUI

/// Closes the keyboard from anywhere, without needing a reference to the focused field.
@MainActor
func dismissKeyboard() {
    #if os(iOS)
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    #endif
}
