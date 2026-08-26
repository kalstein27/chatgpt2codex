import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Accessibility/CGEvent executor that runs inside the signed menu-bar app
/// process so macOS TCC evaluates the app's stable Accessibility identity.
/// The runtime can only reach this executor through the authenticated
/// loopback local-control bridge. Text payloads are never included in results.
enum MenuBarAccessibilityBridge {
    private struct Match {
        let element: AXUIElement
        let role: String
        let title: String?
        let description: String?
        let windowTitle: String?
    }

    private struct ResolveOutcome {
        let match: Match?
        let matchCount: Int
        let resolvedAppName: String
        let bundleId: String?
        let reason: String?
    }

    static func execute(_ entry: [String: Any]) -> [String: Any] {
        guard let kind = entry["kind"] as? String else {
            return failure("missing-accessibility-bridge-kind")
        }

        if kind == "preflight" {
            return success([
                "accessibilityTrusted": AXIsProcessTrusted(),
                "screenRecordingAllowed": CGPreflightScreenCaptureAccess(),
                "source": "menu-bar",
            ])
        }

        if kind == "frontmost" {
            guard let app = NSWorkspace.shared.frontmostApplication else {
                return success([:])
            }
            var result: [String: Any] = [:]
            if let name = app.localizedName { result["appName"] = name }
            if let bundleId = app.bundleIdentifier { result["bundleId"] = bundleId }
            return success(result)
        }

        guard AXIsProcessTrusted() else {
            return failure("accessibility-not-authorized")
        }

        switch kind {
        case "windowregion":
            guard let appName = boundedString(entry["appName"], max: 256),
                  let runningApp = findRunningApp(appName)
            else { return failure("app-not-running") }
            guard activateAndConfirmFrontmost(appName) else { return failure("target-app-not-frontmost") }
            let appElement = AXUIElementCreateApplication(runningApp.processIdentifier)
            enableManualAccessibility(appElement)
            var windows = axWindows(appElement)
            if windows.isEmpty {
                usleep(150_000)
                windows = axWindows(appElement)
            }
            let window = axWindow(appElement, kAXFocusedWindowAttribute as CFString)
                ?? axWindow(appElement, kAXMainWindowAttribute as CFString)
                ?? windows.first
            guard let window, let frame = axFrame(window) else {
                return failure("app-window-not-found")
            }
            return success([
                "x": frame["x"] ?? 0,
                "y": frame["y"] ?? 0,
                "width": frame["width"] ?? 0,
                "height": frame["height"] ?? 0,
            ])

        case "resolve", "press", "setvalue":
            guard let appName = boundedString(entry["appName"], max: 256),
                  let role = boundedString(entry["role"], max: 41),
                  validRole(role)
            else {
                return failure("invalid-accessibility-target")
            }
            let title = boundedString(entry["title"], max: 2048)
            let description = boundedString(entry["description"], max: 2048)
            let outcome = resolveTarget(appName: appName, role: role, title: title, description: description)

            if kind == "resolve" {
                return success(resolveResult(outcome))
            }
            guard let match = outcome.match else {
                return failure("accessibility-target-not-found")
            }
            publishAgentCursor(for: match.element)
            if kind == "press" {
                let error = AXUIElementPerformAction(match.element, kAXPressAction as CFString)
                guard error == .success else { return failure("accessibility-press-failed") }
                return success(["found": true, "pressed": true, "role": match.role, "matchCount": outcome.matchCount])
            }
            guard let text = entry["text"] as? String else {
                return failure("missing-accessibility-value")
            }
            let error = AXUIElementSetAttributeValue(match.element, kAXValueAttribute as CFString, text as CFTypeRef)
            guard error == .success else { return failure("accessibility-setvalue-failed") }
            return success(["found": true, "set": true, "role": match.role, "matchCount": outcome.matchCount])

        case "click", "doubleclick":
            guard let x = number(entry["x"]), let y = number(entry["y"]), x.isFinite, y.isFinite else {
                return failure("invalid-click-point")
            }
            let button = boundedString(entry["button"], max: 16) ?? "left"
            let count = kind == "doubleclick" ? 2 : 1
            publishAgentCursor(x: x, y: y)
            let appName = entry["appName"] as? String
            if button == "left", count == 1, pressAppElementAtPoint(appName: appName, x: x, y: y) {
                return success(["ok": true, "delivery": "ax-hit-test"])
            }
            guard activateAndConfirmFrontmost(appName) else { return failure("target-app-not-frontmost") }
            return synthesizeClick(x: x, y: y, button: button, clickCount: count) ? success(["ok": true]) : failure("click-synthesis-failed")

        case "move":
            guard let x = number(entry["x"]), let y = number(entry["y"]), x.isFinite, y.isFinite else {
                return failure("invalid-move-point")
            }
            publishAgentCursor(x: x, y: y)
            return success(["ok": true, "delivery": "overlay-only"])

        case "drag":
            guard let rawPoints = entry["points"] as? [[String: Any]], rawPoints.count >= 2, rawPoints.count <= 32 else {
                return failure("invalid-drag-path")
            }
            let points = rawPoints.compactMap { item -> CGPoint? in
                guard let x = number(item["x"]), let y = number(item["y"]), x.isFinite, y.isFinite else { return nil }
                return CGPoint(x: x, y: y)
            }
            guard points.count == rawPoints.count else { return failure("invalid-drag-path") }
            let button = boundedString(entry["button"], max: 16) ?? "left"
            if let last = points.last { publishAgentCursor(x: Double(last.x), y: Double(last.y)) }
            guard activateAndConfirmFrontmost(entry["appName"] as? String) else { return failure("target-app-not-frontmost") }
            return synthesizeDrag(points: points, button: button) ? success(["ok": true]) : failure("drag-synthesis-failed")

        case "scroll":
            guard let x = number(entry["x"]), let y = number(entry["y"]),
                  let scrollX = number(entry["scrollX"]), let scrollY = number(entry["scrollY"]),
                  x.isFinite, y.isFinite, scrollX.isFinite, scrollY.isFinite
            else { return failure("invalid-scroll") }
            publishAgentCursor(x: x, y: y)
            guard activateAndConfirmFrontmost(entry["appName"] as? String) else { return failure("target-app-not-frontmost") }
            return synthesizeScroll(x: x, y: y, scrollX: scrollX, scrollY: scrollY) ? success(["ok": true]) : failure("scroll-synthesis-failed")

        case "type":
            guard let text = entry["text"] as? String else { return failure("missing-type-text") }
            guard activateAndConfirmFrontmost(entry["appName"] as? String) else { return failure("target-app-not-frontmost") }
            return synthesizeType(text) ? success(["ok": true]) : failure("type-synthesis-failed")

        case "key":
            guard let keyCode = number(entry["keyCode"]), keyCode >= 0, keyCode <= Double(UInt16.max) else {
                return failure("invalid-key-code")
            }
            guard activateAndConfirmFrontmost(entry["appName"] as? String) else { return failure("target-app-not-frontmost") }
            return synthesizeKey(Int(keyCode.rounded())) ? success(["ok": true]) : failure("key-synthesis-failed")

        case "keypress":
            guard let rawCodes = entry["keyCodes"] as? [NSNumber], !rawCodes.isEmpty, rawCodes.count <= 8 else {
                return failure("invalid-keypress")
            }
            let keyCodes = rawCodes.map { $0.intValue }
            guard keyCodes.allSatisfy({ $0 >= 0 && $0 <= Int(UInt16.max) }) else { return failure("invalid-keypress") }
            let modifiers = (entry["modifiers"] as? [String]) ?? []
            guard activateAndConfirmFrontmost(entry["appName"] as? String) else { return failure("target-app-not-frontmost") }
            return synthesizeKeypress(keyCodes: keyCodes, modifiers: modifiers) ? success(["ok": true]) : failure("keypress-synthesis-failed")
        default:
            return failure("unsupported-accessibility-bridge-kind")
        }
    }

    private static func success(_ result: [String: Any]) -> [String: Any] {
        ["ok": true, "result": result]
    }

    private static func failure(_ error: String) -> [String: Any] {
        ["ok": false, "error": error]
    }

    private static func publishAgentCursor(for element: AXUIElement) {
        guard let frame = axFrame(element),
              let x = frame["x"], let y = frame["y"],
              let width = frame["width"], let height = frame["height"]
        else { return }
        publishAgentCursor(x: x + width / 2, y: y + height / 2)
    }

    private static func publishAgentCursor(x: Double, y: Double) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: Notification.Name("C2CTAgentCursorMove"),
                object: nil,
                userInfo: ["x": x, "y": y]
            )
        }
    }

    private static func boundedString(_ value: Any?, max: Int) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= max else { return nil }
        return value
    }

    private static func validRole(_ role: String) -> Bool {
        guard role.count <= 41, let first = role.first, first.isLetter else { return false }
        return role.allSatisfy { $0.isLetter || $0 == " " }
    }

    private static func number(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        return nil
    }

    private static func findRunningApp(_ name: String) -> NSRunningApplication? {
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return nil }
        let apps = NSWorkspace.shared.runningApplications
        if let exact = apps.first(where: {
            $0.localizedName?.lowercased() == normalized || $0.bundleIdentifier?.lowercased() == normalized
        }) {
            return exact
        }
        return apps.first { app in
            if let bundleId = app.bundleIdentifier?.lowercased() {
                if bundleId.hasSuffix("." + normalized) { return true }
                if bundleId.split(separator: ".").last == Substring(normalized) { return true }
            }
            return app.executableURL?.lastPathComponent.lowercased() == normalized
        }
    }

    private static func normalizeRole(_ role: String) -> String {
        var value = role.lowercased()
        if value.hasPrefix("ax") { value.removeFirst(2) }
        return value
    }

    private static func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return value as? String
    }

    private static func axChildren(_ element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let children = value as? [AXUIElement]
        else { return [] }
        return children
    }

    private static func axWindows(_ appElement: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement]
        else { return [] }
        return windows
    }

    private static func axWindow(_ appElement: AXUIElement, _ attribute: CFString) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, attribute, &value) == .success,
              let value,
              CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private static func axFrame(_ element: AXUIElement) -> [String: Double]? {
        var positionRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let positionRef, let sizeRef,
              CFGetTypeID(positionRef) == AXValueGetTypeID(),
              CFGetTypeID(sizeRef) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionRef as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        else { return nil }
        return ["x": Double(point.x), "y": Double(point.y), "width": Double(size.width), "height": Double(size.height)]
    }

    private static func axActionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let values = names as? [String] else { return [] }
        return values
    }

    private static func enableManualAccessibility(_ appElement: AXUIElement) {
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    private static func findMatches(
        windows: [AXUIElement],
        normalizedRole: String,
        title: String?,
        description: String?
    ) -> [Match] {
        guard title != nil || description != nil else { return [] }
        var matches: [Match] = []
        var visited = 0
        let limit = 6000
        for window in windows {
            let windowTitle = axString(window, kAXTitleAttribute as CFString)
            var queue: [AXUIElement] = [window]
            while !queue.isEmpty && visited < limit {
                let element = queue.removeFirst()
                visited += 1
                let role = axString(element, kAXRoleAttribute as CFString)
                if normalizeRole(role ?? "") == normalizedRole {
                    let elementTitle = axString(element, kAXTitleAttribute as CFString)
                    let elementDescription = axString(element, kAXDescriptionAttribute as CFString)
                    let titleMatches = title == nil || elementTitle == title
                    let descriptionMatches = description == nil || elementDescription == description
                    if titleMatches && descriptionMatches {
                        matches.append(Match(
                            element: element,
                            role: role ?? normalizedRole,
                            title: elementTitle,
                            description: elementDescription,
                            windowTitle: windowTitle
                        ))
                    }
                }
                queue.append(contentsOf: axChildren(element))
            }
        }
        return matches
    }

    private static func resolveTarget(appName: String, role: String, title: String?, description: String?) -> ResolveOutcome {
        guard let runningApp = findRunningApp(appName) else {
            return ResolveOutcome(match: nil, matchCount: 0, resolvedAppName: appName, bundleId: nil, reason: "app not running")
        }
        let appElement = AXUIElementCreateApplication(runningApp.processIdentifier)
        enableManualAccessibility(appElement)
        var windows = axWindows(appElement)
        if windows.isEmpty {
            usleep(150_000)
            windows = axWindows(appElement)
        }
        let matches = findMatches(
            windows: windows,
            normalizedRole: normalizeRole(role),
            title: title,
            description: description
        )
        return ResolveOutcome(
            match: matches.first,
            matchCount: matches.count,
            resolvedAppName: runningApp.localizedName ?? appName,
            bundleId: runningApp.bundleIdentifier,
            reason: matches.isEmpty ? "no matching accessibility element" : nil
        )
    }

    private static func resolveResult(_ outcome: ResolveOutcome) -> [String: Any] {
        guard let match = outcome.match else {
            return [
                "found": false,
                "reason": outcome.reason ?? "not found",
                "app": outcome.resolvedAppName,
                "matchCount": 0,
                "source": "menu-bar",
            ]
        }
        var result: [String: Any] = [
            "found": true,
            "role": match.role,
            "app": outcome.resolvedAppName,
            "matchCount": outcome.matchCount,
            "actions": axActionNames(match.element),
            "source": "menu-bar",
        ]
        if let bundleId = outcome.bundleId { result["bundleId"] = bundleId }
        if let title = match.title { result["title"] = title }
        if let description = match.description { result["description"] = description }
        if let windowTitle = match.windowTitle { result["window"] = windowTitle }
        if let frame = axFrame(match.element) { result["frame"] = frame }
        return result
    }

    private static func activateAndConfirmFrontmost(_ appName: String?) -> Bool {
        guard let appName, let app = findRunningApp(appName) else { return false }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return true }
        guard app.activate(options: [.activateAllWindows]) else { return false }
        for _ in 0..<12 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return true }
            usleep(50_000)
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    }

    private static func pressAppElementAtPoint(appName: String?, x: Double, y: Double) -> Bool {
        guard let appName, let app = findRunningApp(appName) else { return false }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        enableManualAccessibility(appElement)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(appElement, Float(x), Float(y), &hit) == .success,
              let hit
        else { return false }
        var rawActions: CFArray?
        guard AXUIElementCopyActionNames(hit, &rawActions) == .success,
              let actions = rawActions as? [String],
              actions.contains(kAXPressAction as String)
        else { return false }
        return AXUIElementPerformAction(hit, kAXPressAction as CFString) == .success
    }

    private static func mouseEventTypes(_ button: String) -> (CGEventType, CGEventType, CGEventType, CGMouseButton)? {
        switch button.lowercased() {
        case "left": return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
        case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
        case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
        default: return nil
        }
    }

    private static func synthesizeClick(x: Double, y: Double, button: String = "left", clickCount: Int = 1) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let types = mouseEventTypes(button),
              (1...2).contains(clickCount)
        else { return false }
        let originalCursorPosition = CGEvent(source: nil)?.location
        defer {
            if let originalCursorPosition {
                _ = CGWarpMouseCursorPosition(originalCursorPosition)
            }
        }
        let point = CGPoint(x: x, y: y)
        for clickIndex in 1...clickCount {
            guard let down = CGEvent(mouseEventSource: source, mouseType: types.0, mouseCursorPosition: point, mouseButton: types.3),
                  let up = CGEvent(mouseEventSource: source, mouseType: types.1, mouseCursorPosition: point, mouseButton: types.3)
            else { return false }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
            down.post(tap: .cghidEventTap)
            usleep(20_000)
            up.post(tap: .cghidEventTap)
            if clickIndex < clickCount { usleep(60_000) }
        }
        return true
    }

    private static func synthesizeMove(x: Double, y: Double) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
        else { return false }
        event.post(tap: .cghidEventTap)
        return true
    }

    private static func synthesizeDrag(points: [CGPoint], button: String = "left") -> Bool {
        guard points.count >= 2, points.count <= 32,
              let source = CGEventSource(stateID: .hidSystemState),
              let types = mouseEventTypes(button),
              let first = points.first, let last = points.last,
              let down = CGEvent(mouseEventSource: source, mouseType: types.0, mouseCursorPosition: first, mouseButton: types.3)
        else { return false }
        let originalCursorPosition = CGEvent(source: nil)?.location
        defer {
            if let originalCursorPosition {
                _ = CGWarpMouseCursorPosition(originalCursorPosition)
            }
        }
        down.post(tap: .cghidEventTap)
        usleep(25_000)
        for point in points.dropFirst().dropLast() {
            guard let drag = CGEvent(mouseEventSource: source, mouseType: types.2, mouseCursorPosition: point, mouseButton: types.3) else { return false }
            drag.post(tap: .cghidEventTap)
            usleep(12_000)
        }
        guard let dragLast = CGEvent(mouseEventSource: source, mouseType: types.2, mouseCursorPosition: last, mouseButton: types.3),
              let up = CGEvent(mouseEventSource: source, mouseType: types.1, mouseCursorPosition: last, mouseButton: types.3)
        else { return false }
        dragLast.post(tap: .cghidEventTap)
        usleep(20_000)
        up.post(tap: .cghidEventTap)
        return true
    }

    private static func synthesizeScroll(x: Double, y: Double, scrollX: Double, scrollY: Double) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let event = CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 2,
                wheel1: Int32(max(-4000, min(4000, -scrollY.rounded()))),
                wheel2: Int32(max(-4000, min(4000, -scrollX.rounded()))),
                wheel3: 0
              )
        else { return false }
        event.location = CGPoint(x: x, y: y)
        event.post(tap: .cghidEventTap)
        return true
    }

    private static func synthesizeType(_ text: String) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
        for character in text {
            let utf16 = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            else { return false }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            down.post(tap: .cghidEventTap)
            usleep(4_000)
            up.post(tap: .cghidEventTap)
            usleep(4_000)
        }
        return true
    }

    private static func synthesizeKey(_ keyCode: Int) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: false)
        else { return false }
        down.post(tap: .cghidEventTap)
        usleep(20_000)
        up.post(tap: .cghidEventTap)
        return true
    }

    private static func synthesizeKeypress(keyCodes: [Int], modifiers: [String]) -> Bool {
        guard let source = CGEventSource(stateID: .hidSystemState), !keyCodes.isEmpty, keyCodes.count <= 8 else { return false }
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier.lowercased() {
            case "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option": flags.insert(.maskAlternate)
            case "control": flags.insert(.maskControl)
            case "function": flags.insert(.maskSecondaryFn)
            default: return false
            }
        }
        for keyCode in keyCodes {
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: false)
            else { return false }
            down.flags = flags
            up.flags = flags
            down.post(tap: .cghidEventTap)
            usleep(20_000)
            up.post(tap: .cghidEventTap)
            usleep(20_000)
        }
        return true
    }
}
