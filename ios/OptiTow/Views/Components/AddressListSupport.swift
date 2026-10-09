import SwiftUI

/// Scrolls the form so the view with this id is at the top of the visible area. Set by the form; a
/// no-op elsewhere (previews). Always compares equal: the action only wraps the form's scroll proxy,
/// so changing it must not invalidate every view that reads it.
struct FormScroller: Equatable {
    let action: (String) -> Void

    func callAsFunction(_ id: String) { action(id) }
    static func == (lhs: FormScroller, rhs: FormScroller) -> Bool { true }
}

extension EnvironmentValues {
    @Entry var scrollFormTo = FormScroller { _ in }
}

/// True while an address field's suggestion list is open. The form hides its pinned Save bar then,
/// so the list is not squeezed between the bar and the keyboard.
struct AddressListOpenKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}
