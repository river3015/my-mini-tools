import AppKit

enum Paster {
    /// Marks events we post so the hotkey tap can ignore them.
    static let syntheticEventTag: Int64 = 0x766F_6963  // "voic"

    /// Pastes via the clipboard, then restores the previous clipboard contents.
    static func paste(_ text: String) {
        let pasteboard = NSPasteboard.general
        let saved: [NSPasteboardItem] = (pasteboard.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        sendCommandV()
        // Give the target app time to read the clipboard before restoring it.
        Thread.sleep(forTimeInterval: 0.5)
        pasteboard.clearContents()
        if !saved.isEmpty { pasteboard.writeObjects(saved) }
    }

    private static func sendCommandV() {
        let source = CGEventSource(stateID: .hidSystemState)
        let vKey: CGKeyCode = 9
        for keyDown in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: keyDown) else {
                continue
            }
            event.flags = .maskCommand
            event.setIntegerValueField(.eventSourceUserData, value: syntheticEventTag)
            event.post(tap: .cghidEventTap)
        }
    }
}
