import SwiftUI

/// The two looks of the app. The choice is stored under `storageKey` in `UserDefaults`, so it
/// survives restarts, and is published to every view through `\.appTheme`.
///
/// Switching is purely visual: both themes use the same layout, and the style modifiers keep the
/// same view structure in each, so a switch never rebuilds a view, resets a draft or moves the scroll.
enum AppTheme: String, CaseIterable, Sendable {
    case standard
    case neumorphic

    static let storageKey = "app_theme"

    var isNeumorphic: Bool { self == .neumorphic }
    var toggled: AppTheme { isNeumorphic ? .standard : .neumorphic }

    /// The screen behind the cards.
    var canvas: Color { isNeumorphic ? Soft.canvas : Theme.background }
    /// What a card, or a list row sitting on the canvas, is filled with.
    var surface: Color { isNeumorphic ? Soft.canvas : Theme.surface }
}

private struct AppThemeKey: EnvironmentKey {
    static let defaultValue = AppTheme.standard
}

extension EnvironmentValues {
    var appTheme: AppTheme {
        get { self[AppThemeKey.self] }
        set { self[AppThemeKey.self] = newValue }
    }
}
