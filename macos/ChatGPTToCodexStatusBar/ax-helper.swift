import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// `chatgpt2codex-ax`: a legacy compatibility CLI compiled into the signed app
// bundle at Contents/MacOS/chatgpt2codex-ax (see scripts/build-macos-app.sh).
// The menu-bar-process Accessibility bridge is the primary engine so TCC is
// evaluated against the app's stable identity; this helper is fallback only:
//
//   chatgpt2codex-ax resolve    <<< {"appName":"...","role":"...","title":"...","description":"..."}
//   chatgpt2codex-ax press      <<< same shape
//   chatgpt2codex-ax setvalue   <<< same shape + {"text":"..."}
//   chatgpt2codex-ax click      <<< {"appName":"...","x":Double,"y":Double}
//   chatgpt2codex-ax type       <<< {"appName":"...","text":"..."}
//   chatgpt2codex-ax key        <<< {"appName":"...","keyCode":Int}
//   chatgpt2codex-ax preflight  <<< {} (no input required)
//
// `resolve` never activates or clicks the target app: it only reads
// AXUIElement attributes, so it is safe to call at dry-run preview time
// (src/control/tools.ts handleComputerRequestAction), before a local human
// has approved anything. `press`/`setvalue` re-resolve the element fresh on
// every invocation instead of trusting a stale reference from an earlier
// resolve call, so an element that moved or disappeared between preview and
// approval fails cleanly instead of acting on the wrong thing.
//
// `click`/`type`/`key` are the raw CGEvent-based input primitives preferred
// by src/control/mac-input.ts clickAtPoint/typeText/pressKey over AppleScript
// UI scripting (more reliable against apps that don't cooperate with
// System Events). They activate `appName` first (best-effort) so synthetic
// events land in the right process, exactly like the osascript fallback
// they replace. Coordinates passed to `click` are always pre-resolved,
// window-relative points computed by the TypeScript caller — this helper
// never picks an arbitrary absolute coordinate on its own.
//
// `preflight` reports the live Accessibility (AXIsProcessTrusted) and Screen
// Recording (CGPreflightScreenCaptureAccess) trust state for this process,
// so callers can report a clear reason before a control action is attempted
// instead of it failing silently partway through.
//
// `text` (the setvalue/type payload) is never written to stdout/stderr/logs.
//
// Exit code 0 + JSON on stdout for a definitive answer (including
// found:false for resolve, which is not an error — it just means the
// accessibility tree had no match, e.g. a not-yet-activated Electron/
// Chromium app). Exit code 1 for press/setvalue/click/type/key failures and
// for any unexpected condition, so the TypeScript caller's subprocess
// wrapper rejects and falls back to the existing fallback primitives.

// MARK: - stdin / stdout JSON plumbing

private func readStdinJSON() -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return [:]
    }
    return obj
}

private func emit(_ obj: [String: Any], code: Int32) -> Never {
    var withSource = obj
    withSource["source"] = "ax-helper"
    let data = (try? JSONSerialization.data(withJSONObject: withSource)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

private func emitOk(_ obj: [String: Any]) -> Never { emit(obj, code: 0) }
private func emitFail(_ obj: [String: Any]) -> Never { emit(obj, code: 1) }

// MARK: - AX primitives

/// Matches `name` against a running app using progressively looser,
/// locale-independent candidates, since `localizedName` is translated on
/// non-English systems (e.g. Korean macOS reports TextEdit's localizedName
/// as "텍스트 편집기") and callers generally pass the English/executable name.
/// Exact matches (localizedName/bundleIdentifier) win over the bundle-id
/// suffix and executable-basename fallbacks.
private func findRunningApp(_ name: String) -> NSRunningApplication? {
    let norm = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !norm.isEmpty else { return nil }

    let apps = NSWorkspace.shared.runningApplications

    if let exact = apps.first(where: {
        ($0.localizedName?.lowercased() == norm) || ($0.bundleIdentifier?.lowercased() == norm)
    }) {
        return exact
    }

    return apps.first { app in
        if let bundleId = app.bundleIdentifier?.lowercased() {
            if bundleId.hasSuffix("." + norm) {
                return true
            }
            if let lastComponent = bundleId.split(separator: ".").last, lastComponent == Substring(norm) {
                return true
            }
        }
        if let execName = app.executableURL?.lastPathComponent.lowercased(), execName == norm {
            return true
        }
        return false
    }
}

/// Normalize an AX role ("AXButton") and a System-Events-style role
/// ("button") to the same lowercase key so callers may pass either.
private func normalizeRole(_ role: String) -> String {
    var r = role.lowercased()
    if r.hasPrefix("ax") { r.removeFirst(2) }
    return r
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? String
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
        let children = value as? [AXUIElement]
    else {
        return []
    }
    return children
}

private func axWindows(_ appElement: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value) == .success,
        let windows = value as? [AXUIElement]
    else {
        return []
    }
    return windows
}

private func axFrame(_ element: AXUIElement) -> [String: Double]? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
        let posValue = posRef, let sizeValue = sizeRef
    else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return ["x": Double(point.x), "y": Double(point.y), "width": Double(size.width), "height": Double(size.height)]
}

private func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let arr = names as? [String] else {
        return []
    }
    return arr
}

/// Best-effort: many Electron/Chromium (and some WebKit) apps keep an empty
/// AX tree until an assistive-technology client explicitly asks for one.
/// Setting these two attributes on the application element is the standard
/// way to make Chromium populate its tree; harmless (and ignored) on apps
/// that don't recognize them.
private func enableManualAccessibility(_ appElement: AXUIElement) {
    AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

// MARK: - CGEvent raw input primitives (click / type / key)

/// Best-effort: bring `appName` to the front before synthesizing input, the
/// same way the AppleScript fallback's `tell application ... to activate`
/// does. A short settle delay gives the app time to actually become key
/// before events are posted; harmless (and skipped) when appName is absent
/// or not currently running.
private func activateAndConfirmFrontmost(_ appName: String?) -> Bool {
    guard let appName, let app = findRunningApp(appName) else { return false }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return true }
    guard app.activate(options: [.activateAllWindows]) else { return false }
    for _ in 0..<12 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return true }
        usleep(50_000)
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
}

private func pressAppElementAtPoint(appName: String?, x: Double, y: Double) -> Bool {
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

/// Synthesizes a left-click at an absolute screen point via CGEvent. The
/// point is always pre-resolved by the TypeScript caller (window-relative
/// fraction -> absolute point via the app's current window bounds); this
/// helper never picks a coordinate itself.
private func mouseEventTypes(_ button: String) -> (CGEventType, CGEventType, CGEventType, CGMouseButton)? {
    switch button.lowercased() {
    case "left": return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
    case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
    case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
    default: return nil
    }
}

private func synthesizeClick(x: Double, y: Double, button: String = "left", clickCount: Int = 1) -> Bool {
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

private func synthesizeMove(x: Double, y: Double) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
    else { return false }
    event.post(tap: .cghidEventTap)
    return true
}

private func synthesizeDrag(points: [CGPoint], button: String = "left") -> Bool {
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

private func synthesizeScroll(x: Double, y: Double, scrollX: Double, scrollY: Double) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let event = CGEvent(
            scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
            wheel1: Int32(max(-4000, min(4000, -scrollY.rounded()))),
            wheel2: Int32(max(-4000, min(4000, -scrollX.rounded()))), wheel3: 0
          )
    else { return false }
    event.location = CGPoint(x: x, y: y)
    event.post(tap: .cghidEventTap)
    return true
}

/// Synthesizes literal-text keyboard input via CGEvent's Unicode-string
/// keyboard events, one down/up pair per character. This sidesteps virtual
/// keycode/layout mapping entirely (unlike `key`), matching what AppleScript
/// `keystroke <text>` does. Never logs the string itself.
private func synthesizeType(_ text: String) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
    for character in text {
        let utf16 = Array(String(character).utf16)
        guard
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else {
            return false
        }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        down.post(tap: .cghidEventTap)
        usleep(4_000)
        up.post(tap: .cghidEventTap)
        usleep(4_000)
    }
    return true
}

/// Synthesizes a single virtual-keycode press (e.g. Return, Tab, arrows) via
/// CGEvent, matching AppleScript `key code <n>`.
private func synthesizeKey(_ keyCode: Int) -> Bool {
    guard let source = CGEventSource(stateID: .hidSystemState) else { return false }
    guard
        let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: false)
    else {
        return false
    }
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)
    return true
}

// MARK: - Live permission preflight

/// Reports this process's live Accessibility/Screen Recording TCC trust
/// state, mirroring main.swift's ServiceController.accessibilityTrusted /
/// screenRecordingAllowed. Read-only: never prompts.
private func preflightResultJSON() -> [String: Any] {
    let accessibilityTrusted = AXIsProcessTrusted()
    let screenRecordingAllowed = CGPreflightScreenCaptureAccess()
    return [
        "accessibilityTrusted": accessibilityTrusted,
        "screenRecordingAllowed": screenRecordingAllowed,
    ]
}

private struct AxMatch {
    let element: AXUIElement
    let role: String
    let title: String?
    let description: String?
    let windowTitle: String?
}

/// Bounded breadth-first search across every window's subtree for elements
/// whose role matches and whose title or description matches the requested
/// value. A hard node-visit cap keeps a pathological tree from hanging.
private func findMatches(windows: [AXUIElement], normalizedRole: String, title: String?, description: String?) -> [AxMatch] {
    guard title != nil || description != nil else { return [] }
    var matches: [AxMatch] = []
    var visited = 0
    let limit = 6000
    for window in windows {
        let windowTitle = axString(window, kAXTitleAttribute as CFString)
        var queue: [AXUIElement] = [window]
        while !queue.isEmpty, visited < limit {
            let el = queue.removeFirst()
            visited += 1
            let elRole = axString(el, kAXRoleAttribute as CFString)
            if normalizeRole(elRole ?? "") == normalizedRole {
                let elTitle = axString(el, kAXTitleAttribute as CFString)
                let elDescription = axString(el, kAXDescriptionAttribute as CFString)
                let titleOk = title == nil || elTitle == title
                let descriptionOk = description == nil || elDescription == description
                if titleOk, descriptionOk {
                    matches.append(AxMatch(element: el, role: elRole ?? normalizedRole, title: elTitle, description: elDescription, windowTitle: windowTitle))
                }
            }
            queue.append(contentsOf: axChildren(el))
        }
    }
    return matches
}

private struct ResolveOutcome {
    let match: AxMatch?
    let matchCount: Int
    let resolvedAppName: String
    let bundleId: String?
    let reason: String?
}

private func resolveTarget(appName: String, role: String, title: String?, description: String?) -> ResolveOutcome {
    guard let runningApp = findRunningApp(appName) else {
        return ResolveOutcome(match: nil, matchCount: 0, resolvedAppName: appName, bundleId: nil, reason: "app not running: \(appName)")
    }
    let appElement = AXUIElementCreateApplication(runningApp.processIdentifier)
    enableManualAccessibility(appElement)
    var windows = axWindows(appElement)
    if windows.isEmpty {
        // Give Chromium/Electron a brief moment to build its AX tree after
        // AXManualAccessibility is set, then retry once.
        usleep(150_000)
        windows = axWindows(appElement)
    }
    let normalizedRole = normalizeRole(role)
    let matches = findMatches(windows: windows, normalizedRole: normalizedRole, title: title, description: description)
    return ResolveOutcome(
        match: matches.first,
        matchCount: matches.count,
        resolvedAppName: runningApp.localizedName ?? appName,
        bundleId: runningApp.bundleIdentifier,
        reason: matches.isEmpty ? "no matching accessibility element (empty/opt-out AX tree, or no title/description match)" : nil
    )
}

private func resolveResultJSON(_ outcome: ResolveOutcome) -> [String: Any] {
    guard let match = outcome.match else {
        return [
            "found": false,
            "reason": outcome.reason ?? "not found",
            "app": outcome.resolvedAppName,
            "matchCount": 0,
        ]
    }
    var result: [String: Any] = [
        "found": true,
        "role": match.role,
        "app": outcome.resolvedAppName,
        "matchCount": outcome.matchCount,
        "actions": axActionNames(match.element),
    ]
    if let bundleId = outcome.bundleId { result["bundleId"] = bundleId }
    if let title = match.title { result["title"] = title }
    if let description = match.description { result["description"] = description }
    if let windowTitle = match.windowTitle { result["window"] = windowTitle }
    if let frame = axFrame(match.element) { result["frame"] = frame }
    return result
}

// MARK: - entry point

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    emitFail(["found": false, "reason": "usage: chatgpt2codex-ax <resolve|press|setvalue|click|type|key|preflight>"])
}
let subcommand = arguments[1]
let input = readStdinJSON()

switch subcommand {
case "resolve", "press", "setvalue":
    guard let appName = input["appName"] as? String, !appName.isEmpty,
        let role = input["role"] as? String, !role.isEmpty
    else {
        emitFail(["found": false, "reason": "appName and role are required"])
    }
    let title = input["title"] as? String
    let description = input["description"] as? String

    switch subcommand {
    case "resolve":
        let outcome = resolveTarget(appName: appName, role: role, title: title, description: description)
        emitOk(resolveResultJSON(outcome))

    case "press":
        let outcome = resolveTarget(appName: appName, role: role, title: title, description: description)
        guard let match = outcome.match else {
            emitFail(resolveResultJSON(outcome))
        }
        let err = AXUIElementPerformAction(match.element, kAXPressAction as CFString)
        guard err == .success else {
            emitFail(["found": true, "pressed": false, "reason": "AXPress failed (AXError \(err.rawValue))"])
        }
        emitOk(["found": true, "pressed": true, "role": match.role, "matchCount": outcome.matchCount])

    default: // setvalue
        guard let text = input["text"] as? String else {
            emitFail(["found": false, "reason": "text is required for setvalue"])
        }
        let outcome = resolveTarget(appName: appName, role: role, title: title, description: description)
        guard let match = outcome.match else {
            emitFail(resolveResultJSON(outcome))
        }
        let err = AXUIElementSetAttributeValue(match.element, kAXValueAttribute as CFString, text as CFTypeRef)
        guard err == .success else {
            emitFail(["found": true, "set": false, "reason": "AXSetValue failed (AXError \(err.rawValue))"])
        }
        emitOk(["found": true, "set": true, "role": match.role, "matchCount": outcome.matchCount])
    }

case "click":
    guard let x = input["x"] as? Double, let y = input["y"] as? Double else {
        emitFail(["ok": false, "reason": "x and y are required for click"])
    }
    let appName = input["appName"] as? String
    if pressAppElementAtPoint(appName: appName, x: x, y: y) {
        emitOk(["ok": true, "delivery": "ax-hit-test"])
    }
    guard activateAndConfirmFrontmost(appName) else {
        emitFail(["ok": false, "reason": "target app is not frontmost"])
    }
    guard synthesizeClick(x: x, y: y) else {
        emitFail(["ok": false, "reason": "failed to synthesize click event"])
    }
    emitOk(["ok": true])

case "type":
    guard let text = input["text"] as? String else {
        emitFail(["ok": false, "reason": "text is required for type"])
    }
    guard activateAndConfirmFrontmost(input["appName"] as? String) else {
        emitFail(["ok": false, "reason": "target app is not frontmost"])
    }
    guard synthesizeType(text) else {
        emitFail(["ok": false, "reason": "failed to synthesize keyboard event"])
    }
    emitOk(["ok": true])

case "key":
    guard let keyCode = input["keyCode"] as? Int else {
        emitFail(["ok": false, "reason": "keyCode is required for key"])
    }
    guard activateAndConfirmFrontmost(input["appName"] as? String) else {
        emitFail(["ok": false, "reason": "target app is not frontmost"])
    }
    guard synthesizeKey(keyCode) else {
        emitFail(["ok": false, "reason": "failed to synthesize key event"])
    }
    emitOk(["ok": true])

case "preflight":
    emitOk(preflightResultJSON())

default:
    emitFail(["found": false, "reason": "unknown subcommand: \(subcommand)"])
}
