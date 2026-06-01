#!/usr/bin/env swift

import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import Vision

typealias JSONDict = [String: Any]

func emit(_ object: JSONDict, exitCode: Int32 = 0) -> Never {
    do {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    } catch {
        let fallback = #"{"ok":false,"errorCode":"json-error","error":"Could not encode JSON response."}"#
        FileHandle.standardOutput.write(Data(fallback.utf8))
        FileHandle.standardOutput.write(Data([0x0a]))
        Darwin.exit(1)
    }
    Darwin.exit(exitCode)
}

func fail(_ code: String, _ message: String, exitCode: Int32 = 1) -> Never {
    emit([
        "ok": false,
        "errorCode": code,
        "error": message
    ], exitCode: exitCode)
}

func usage() -> Never {
    emit([
        "ok": true,
        "usage": [
            "macos-vision-helper list-windows [--json] [--all] [--app <name>]",
            "macos-vision-helper capture --window-id <id>",
            "macos-vision-helper ocr --image <path|base64|data-url> [--level fast|accurate|best]",
            "macos-vision-helper focus --window-id <id>",
            "macos-vision-helper type --window-id <id> --text <text>",
            "macos-vision-helper key --window-id <id> --key enter|tab|escape|backspace|page-down|page-up|ctrl-c"
        ]
    ])
}

func argValue(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else {
        return nil
    }
    return args[index + 1]
}

func requireWindowID(_ args: [String]) -> CGWindowID {
    guard let raw = argValue("--window-id", in: args), let number = UInt32(raw), number > 0 else {
        fail("invalid-window-id", "Missing or invalid --window-id.")
    }
    return CGWindowID(number)
}

func windowBoundsDict(_ bounds: CGRect) -> JSONDict {
    return [
        "x": bounds.origin.x,
        "y": bounds.origin.y,
        "width": bounds.size.width,
        "height": bounds.size.height
    ]
}

func cgWindowBounds(from info: NSDictionary) -> CGRect {
    guard let boundsDict = info[kCGWindowBounds as String] as? NSDictionary else {
        return .zero
    }
    var bounds = CGRect.zero
    CGRectMakeWithDictionaryRepresentation(boundsDict, &bounds)
    return bounds
}

func appWindows(includeOffscreen: Bool = false, appName: String? = nil) -> [JSONDict] {
    let options: CGWindowListOption = includeOffscreen ? [.optionAll, .excludeDesktopElements] : [.optionOnScreenOnly, .excludeDesktopElements]
    guard let rawList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    return rawList.compactMap { info in
        let owner = info[kCGWindowOwnerName as String] as? String ?? ""
        guard !owner.isEmpty else {
            return nil
        }
        if let appName = appName, !appName.isEmpty, owner != appName {
            return nil
        }
        let layer = info[kCGWindowLayer as String] as? Int ?? 0
        guard layer == 0 else {
            return nil
        }
        let windowID = info[kCGWindowNumber as String] as? UInt32 ?? 0
        guard windowID > 0 else {
            return nil
        }
        let bounds = cgWindowBounds(from: info as NSDictionary)
        guard bounds.size.width >= 40, bounds.size.height >= 40 else {
            return nil
        }
        return [
            "windowId": Int(windowID),
            "appName": owner,
            "title": info[kCGWindowName as String] as? String ?? "",
            "pid": info[kCGWindowOwnerPID as String] as? Int ?? 0,
            "visible": (info[kCGWindowIsOnscreen as String] as? Bool) ?? false,
            "bounds": windowBoundsDict(bounds)
        ]
    }
}

func windowInfo(_ windowID: CGWindowID, includeOffscreen: Bool = false) -> JSONDict? {
    return appWindows(includeOffscreen: includeOffscreen).first { window in
        guard let id = window["windowId"] as? Int else {
            return false
        }
        return id == Int(windowID)
    }
}

func requireWindow(_ windowID: CGWindowID, includeOffscreen: Bool = false) -> JSONDict {
    guard let info = windowInfo(windowID, includeOffscreen: includeOffscreen) else {
        fail("invalid-window", "Window \(windowID) is not a visible UI window.")
    }
    return info
}

func captureWindow(_ windowID: CGWindowID) {
    let info = requireWindow(windowID)
    let tmpURL = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("macos-vision-\(UUID().uuidString).png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-l", String(windowID), tmpURL.path]
    let stderrPipe = Pipe()
    process.standardError = stderrPipe
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        fail("capture-failed", "Could not run screencapture: \(error.localizedDescription)")
    }
    guard process.terminationStatus == 0 else {
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""
        fail("screen-recording-denied", "Could not capture the target window. Grant Screen Recording permission to the parent process. \(stderr)".trimmingCharacters(in: .whitespacesAndNewlines))
    }
    defer {
        try? FileManager.default.removeItem(at: tmpURL)
    }
    guard let png = try? Data(contentsOf: tmpURL),
          let image = cgImage(from: png) else {
        fail("capture-failed", "Could not read target window screenshot PNG.")
    }
    emit([
        "ok": true,
        "window": info,
        "image": [
            "mimeType": "image/png",
            "base64": png.base64EncodedString(),
            "width": image.width,
            "height": image.height
        ]
    ])
}

func imageData(from value: String) -> Data? {
    if FileManager.default.fileExists(atPath: value) {
        return try? Data(contentsOf: URL(fileURLWithPath: value))
    }
    let stripped: String
    if let comma = value.firstIndex(of: ","),
       value[..<comma].contains("base64") {
        stripped = String(value[value.index(after: comma)...])
    } else {
        stripped = value
    }
    return Data(base64Encoded: stripped)
}

func cgImage(from data: Data) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
        return nil
    }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func recognitionLevelName(_ level: VNRequestTextRecognitionLevel) -> String {
    switch level {
    case .fast:
        return "fast"
    case .accurate:
        return "accurate"
    @unknown default:
        return "unknown"
    }
}

func recognizeText(in image: CGImage, recognitionLevel: VNRequestTextRecognitionLevel) -> [JSONDict] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = recognitionLevel
    request.minimumTextHeight = 0.004
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US", "zh-Hans"]

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("ocr-failed", "Vision OCR failed: \(error.localizedDescription)")
    }

    let imageWidth = Double(image.width)
    let imageHeight = Double(image.height)
    return (request.results ?? []).compactMap { observation -> JSONDict? in
        guard let top = observation.topCandidates(1).first else {
            return nil
        }
        let box = observation.boundingBox
        return [
            "text": top.string,
            "confidence": top.confidence,
            "bbox": [
                "x": box.minX * imageWidth,
                "y": (1.0 - box.maxY) * imageHeight,
                "width": box.width * imageWidth,
                "height": box.height * imageHeight
            ]
        ]
    }
}

func parseRecognitionLevel(_ value: String) -> VNRequestTextRecognitionLevel? {
    switch value {
    case "fast":
        return .fast
    case "accurate":
        return .accurate
    default:
        return nil
    }
}

func chooseBestOCRResult(_ candidates: [(VNRequestTextRecognitionLevel, [JSONDict])]) -> (VNRequestTextRecognitionLevel, [JSONDict]) {
    let nonEmpty = candidates.filter { !$0.1.isEmpty }
    guard !nonEmpty.isEmpty else {
        return candidates.first ?? (.fast, [])
    }
    if let fast = candidates.first(where: { $0.0 == .fast }),
       let accurate = candidates.first(where: { $0.0 == .accurate }),
       !fast.1.isEmpty,
       !accurate.1.isEmpty,
       Double(accurate.1.count) >= Double(fast.1.count) * 0.75,
       Double(ocrTextLength(accurate.1)) >= Double(ocrTextLength(fast.1)) * 0.65 {
        return accurate
    }
    return nonEmpty.max { left, right in
        ocrCandidateScore(left.1) < ocrCandidateScore(right.1)
    }!
}

func ocrTextLength(_ results: [JSONDict]) -> Int {
    return results.reduce(0) { sum, item in
        sum + ((item["text"] as? String) ?? "").count
    }
}

func ocrCandidateScore(_ results: [JSONDict]) -> Double {
    let textLength = ocrTextLength(results)
    let confidence = results.reduce(0.0) { sum, item in
        if let value = item["confidence"] as? Float {
            return sum + Double(value)
        }
        if let value = item["confidence"] as? Double {
            return sum + value
        }
        return sum
    }
    return Double(results.count * 1000 + textLength) + confidence
}

func runOCR(_ imageArg: String, levelArg: String = "best") {
    guard let data = imageData(from: imageArg), let image = cgImage(from: data) else {
        fail("invalid-image", "Could not read image from --image.")
    }

    let recognitionLevel: VNRequestTextRecognitionLevel
    let results: [JSONDict]
    if levelArg == "best" {
        (recognitionLevel, results) = chooseBestOCRResult([
            (.fast, recognizeText(in: image, recognitionLevel: .fast)),
            (.accurate, recognizeText(in: image, recognitionLevel: .accurate))
        ])
    } else if let requestedLevel = parseRecognitionLevel(levelArg) {
        recognitionLevel = requestedLevel
        results = recognizeText(in: image, recognitionLevel: requestedLevel)
    } else {
        fail("invalid-ocr-level", "Unsupported OCR level: \(levelArg).")
    }

    emit([
        "ok": true,
        "image": [
            "width": image.width,
            "height": image.height
        ],
        "recognitionLevel": recognitionLevelName(recognitionLevel),
        "results": results
    ])
}

func accessibilityTrusted() -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func axWindows(for pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw)
    guard result == .success, let windows = raw as? [AXUIElement] else {
        return []
    }
    return windows
}

func axWindowNumber(_ window: AXUIElement) -> Int? {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(window, "AXWindowNumber" as CFString, &raw)
    guard result == .success else {
        return nil
    }
    if let number = raw as? Int {
        return number
    }
    if let number = raw as? NSNumber {
        return number.intValue
    }
    return nil
}

func axStringAttribute(_ window: AXUIElement, _ name: CFString) -> String {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(window, name, &raw)
    guard result == .success else {
        return ""
    }
    return raw as? String ?? ""
}

func axPointAttribute(_ window: AXUIElement, _ name: CFString) -> CGPoint? {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(window, name, &raw)
    guard result == .success, let value = raw, CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(axValue, .cgPoint, &point) else {
        return nil
    }
    return point
}

func axSizeAttribute(_ window: AXUIElement, _ name: CFString) -> CGSize? {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(window, name, &raw)
    guard result == .success, let value = raw, CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(axValue, .cgSize, &size) else {
        return nil
    }
    return size
}

func axWindowMatches(_ window: AXUIElement, windowID: CGWindowID, info: JSONDict) -> Bool {
    if axWindowNumber(window) == Int(windowID) {
        return true
    }

    let expectedTitle = info["title"] as? String ?? ""
    let actualTitle = axStringAttribute(window, kAXTitleAttribute as CFString)
    if !expectedTitle.isEmpty && actualTitle == expectedTitle {
        return true
    }

    guard let expectedBounds = info["bounds"] as? JSONDict,
          let expectedX = cgFloatValue(expectedBounds["x"]),
          let expectedY = cgFloatValue(expectedBounds["y"]),
          let expectedWidth = cgFloatValue(expectedBounds["width"]),
          let expectedHeight = cgFloatValue(expectedBounds["height"]),
          let actualPosition = axPointAttribute(window, kAXPositionAttribute as CFString),
          let actualSize = axSizeAttribute(window, kAXSizeAttribute as CFString) else {
        return false
    }

    let tolerance: CGFloat = 24
    return abs(actualPosition.x - expectedX) <= tolerance
        && abs(actualPosition.y - expectedY) <= tolerance
        && abs(actualSize.width - expectedWidth) <= tolerance
        && abs(actualSize.height - expectedHeight) <= tolerance
}

func matchingAXWindow(for windowID: CGWindowID, info: JSONDict) -> AXUIElement? {
    guard let pid = info["pid"] as? Int, pid > 0 else {
        return nil
    }
    let windows = axWindows(for: pid_t(pid))
    if let exact = windows.first(where: { axWindowMatches($0, windowID: windowID, info: info) }) {
        return exact
    }
    let titledWindows = windows.filter { !axStringAttribute($0, kAXTitleAttribute as CFString).isEmpty }
    if titledWindows.count == 1 {
        return titledWindows[0]
    }
    if windows.count == 1 {
        return windows[0]
    }
    return nil
}

func waitForMatchingAXWindow(for windowID: CGWindowID, initialInfo: JSONDict, timeoutUsec: useconds_t = 1_500_000) -> AXUIElement? {
    let started = Date()
    var info = initialInfo
    while Date().timeIntervalSince(started) * 1_000_000 < Double(timeoutUsec) {
        if let refreshed = windowInfo(windowID, includeOffscreen: true) {
            info = refreshed
        }
        if let targetWindow = matchingAXWindow(for: windowID, info: info) {
            return targetWindow
        }
        usleep(150_000)
    }
    return matchingAXWindow(for: windowID, info: info)
}

func cgFloatValue(_ value: Any?) -> CGFloat? {
    if let value = value as? CGFloat {
        return value
    }
    if let value = value as? Double {
        return CGFloat(value)
    }
    if let value = value as? Int {
        return CGFloat(value)
    }
    if let value = value as? NSNumber {
        return CGFloat(truncating: value)
    }
    return nil
}

func clickInsideWindow(_ info: JSONDict) -> Bool {
    guard let bounds = info["bounds"] as? JSONDict,
          let x = cgFloatValue(bounds["x"]),
          let y = cgFloatValue(bounds["y"]),
          let width = cgFloatValue(bounds["width"]),
          let height = cgFloatValue(bounds["height"]),
          width > 80,
          height > 80 else {
        return false
    }
    let source = CGEventSource(stateID: .hidSystemState)
    let point = CGPoint(x: x + min(max(width * 0.5, 40), width - 40),
                        y: y + min(max(height * 0.5, 40), height - 40))
    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        return false
    }
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    up.post(tap: .cghidEventTap)
    usleep(120_000)
    return true
}

func windowInt(_ info: JSONDict, _ key: String) -> Int? {
    if let value = info[key] as? Int {
        return value
    }
    if let value = info[key] as? NSNumber {
        return value.intValue
    }
    return nil
}

func windowsReferToSameTarget(_ actual: JSONDict?, targetID: CGWindowID, targetInfo: JSONDict) -> Bool {
    guard let actual = actual else {
        return false
    }
    if windowInt(actual, "windowId") == Int(targetID) {
        return true
    }
    guard windowInt(actual, "pid") == windowInt(targetInfo, "pid"),
          (actual["appName"] as? String ?? "") == (targetInfo["appName"] as? String ?? "") else {
        return false
    }
    guard let actualBounds = actual["bounds"] as? JSONDict,
          let targetBounds = targetInfo["bounds"] as? JSONDict,
          let actualX = cgFloatValue(actualBounds["x"]),
          let actualY = cgFloatValue(actualBounds["y"]),
          let actualWidth = cgFloatValue(actualBounds["width"]),
          let actualHeight = cgFloatValue(actualBounds["height"]),
          let targetX = cgFloatValue(targetBounds["x"]),
          let targetY = cgFloatValue(targetBounds["y"]),
          let targetWidth = cgFloatValue(targetBounds["width"]),
          let targetHeight = cgFloatValue(targetBounds["height"]) else {
        return false
    }
    let tolerance: CGFloat = 32
    return abs(actualX - targetX) <= tolerance
        && abs(actualY - targetY) <= tolerance
        && abs(actualWidth - targetWidth) <= tolerance
        && abs(actualHeight - targetHeight) <= tolerance
}

func focusTargetWindow(_ windowID: CGWindowID) -> JSONDict {
    guard accessibilityTrusted() else {
        fail("accessibility-denied", "Accessibility permission is required to focus and type into the target window.")
    }
    let info = requireWindow(windowID, includeOffscreen: true)
    guard let pid = info["pid"] as? Int, pid > 0 else {
        fail("invalid-window", "Target window has no owning process id.")
    }
    let pidValue = pid_t(pid)
    let appElement = AXUIElementCreateApplication(pidValue)
    if let runningApp = NSRunningApplication(processIdentifier: pidValue) {
        runningApp.activate(options: [.activateIgnoringOtherApps])
    }
    AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    usleep(250_000)

    guard let visibleInfo = windowInfo(windowID) else {
        fail("invalid-window", "Window \(windowID) is not visible and cannot receive visual input.")
    }
    guard clickInsideWindow(visibleInfo) else {
        fail("focus-failed", "Could not click inside target window \(windowID).")
    }

    if let targetWindow = waitForMatchingAXWindow(for: windowID, initialInfo: visibleInfo) {
        AXUIElementSetAttributeValue(targetWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(targetWindow, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
    usleep(150_000)

    let focusedApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
    let topWindow = appWindows().first
    guard windowsReferToSameTarget(topWindow, targetID: windowID, targetInfo: visibleInfo) else {
        let targetApp = visibleInfo["appName"] as? String ?? ""
        let topApp = topWindow?["appName"] as? String ?? ""
        let topId = windowInt(topWindow ?? [:], "windowId") ?? 0
        fail("focus-failed", "Focused window is \(topApp)#\(topId) / app \(focusedApp), not target \(targetApp)#\(Int(windowID)).")
    }
    return [
        "ok": true,
        "window": visibleInfo,
        "focusedApp": focusedApp,
        "topWindow": topWindow ?? [:]
    ]
}

func focusWindow(_ windowID: CGWindowID) {
    emit(focusTargetWindow(windowID))
}

func ensureFocus(_ windowID: CGWindowID) -> JSONDict {
    return focusTargetWindow(windowID)
}

func typeText(_ windowID: CGWindowID, _ text: String) {
    let focus = ensureFocus(windowID)
    let pid = focusedPid(focus)
    usleep(150_000)
    if text.count > 24 {
        pasteText(text, pid: pid)
    } else {
        postKeyboardText(text, pid: pid)
    }
    emit([
        "ok": true,
        "typedChars": text.count,
        "windowId": Int(windowID)
    ])
}

func focusedPid(_ focus: JSONDict) -> pid_t? {
    guard let window = focus["window"] as? JSONDict,
          let pid = windowInt(window, "pid"),
          pid > 0 else {
        return nil
    }
    return pid_t(pid)
}

func pasteText(_ text: String, pid: pid_t?) {
    let pasteboard = NSPasteboard.general
    let previousString = pasteboard.string(forType: .string)
    pasteboard.clearContents()
    guard pasteboard.setString(text, forType: .string) else {
        fail("input-failed", "Could not write text to pasteboard.")
    }
    postCommandModifiedKey(CGKeyCode(kVK_ANSI_V), pid: pid)
    usleep(800_000)
    pasteboard.clearContents()
    if let previousString = previousString {
        _ = pasteboard.setString(previousString, forType: .string)
    }
}

func postKeyboardText(_ text: String, pid: pid_t?) {
    for scalar in text.unicodeScalars {
        if let stroke = asciiKeyStroke(for: scalar) {
            postKeyStroke(stroke.code, flags: stroke.flags, pid: pid)
        } else {
            postUnicodeText(String(scalar), pid: pid)
        }
    }
}

func asciiKeyStroke(for scalar: UnicodeScalar) -> (code: CGKeyCode, flags: CGEventFlags)? {
    switch scalar {
    case "a": return (CGKeyCode(kVK_ANSI_A), [])
    case "b": return (CGKeyCode(kVK_ANSI_B), [])
    case "c": return (CGKeyCode(kVK_ANSI_C), [])
    case "d": return (CGKeyCode(kVK_ANSI_D), [])
    case "e": return (CGKeyCode(kVK_ANSI_E), [])
    case "f": return (CGKeyCode(kVK_ANSI_F), [])
    case "g": return (CGKeyCode(kVK_ANSI_G), [])
    case "h": return (CGKeyCode(kVK_ANSI_H), [])
    case "i": return (CGKeyCode(kVK_ANSI_I), [])
    case "j": return (CGKeyCode(kVK_ANSI_J), [])
    case "k": return (CGKeyCode(kVK_ANSI_K), [])
    case "l": return (CGKeyCode(kVK_ANSI_L), [])
    case "m": return (CGKeyCode(kVK_ANSI_M), [])
    case "n": return (CGKeyCode(kVK_ANSI_N), [])
    case "o": return (CGKeyCode(kVK_ANSI_O), [])
    case "p": return (CGKeyCode(kVK_ANSI_P), [])
    case "q": return (CGKeyCode(kVK_ANSI_Q), [])
    case "r": return (CGKeyCode(kVK_ANSI_R), [])
    case "s": return (CGKeyCode(kVK_ANSI_S), [])
    case "t": return (CGKeyCode(kVK_ANSI_T), [])
    case "u": return (CGKeyCode(kVK_ANSI_U), [])
    case "v": return (CGKeyCode(kVK_ANSI_V), [])
    case "w": return (CGKeyCode(kVK_ANSI_W), [])
    case "x": return (CGKeyCode(kVK_ANSI_X), [])
    case "y": return (CGKeyCode(kVK_ANSI_Y), [])
    case "z": return (CGKeyCode(kVK_ANSI_Z), [])
    case "A": return (CGKeyCode(kVK_ANSI_A), .maskShift)
    case "B": return (CGKeyCode(kVK_ANSI_B), .maskShift)
    case "C": return (CGKeyCode(kVK_ANSI_C), .maskShift)
    case "D": return (CGKeyCode(kVK_ANSI_D), .maskShift)
    case "E": return (CGKeyCode(kVK_ANSI_E), .maskShift)
    case "F": return (CGKeyCode(kVK_ANSI_F), .maskShift)
    case "G": return (CGKeyCode(kVK_ANSI_G), .maskShift)
    case "H": return (CGKeyCode(kVK_ANSI_H), .maskShift)
    case "I": return (CGKeyCode(kVK_ANSI_I), .maskShift)
    case "J": return (CGKeyCode(kVK_ANSI_J), .maskShift)
    case "K": return (CGKeyCode(kVK_ANSI_K), .maskShift)
    case "L": return (CGKeyCode(kVK_ANSI_L), .maskShift)
    case "M": return (CGKeyCode(kVK_ANSI_M), .maskShift)
    case "N": return (CGKeyCode(kVK_ANSI_N), .maskShift)
    case "O": return (CGKeyCode(kVK_ANSI_O), .maskShift)
    case "P": return (CGKeyCode(kVK_ANSI_P), .maskShift)
    case "Q": return (CGKeyCode(kVK_ANSI_Q), .maskShift)
    case "R": return (CGKeyCode(kVK_ANSI_R), .maskShift)
    case "S": return (CGKeyCode(kVK_ANSI_S), .maskShift)
    case "T": return (CGKeyCode(kVK_ANSI_T), .maskShift)
    case "U": return (CGKeyCode(kVK_ANSI_U), .maskShift)
    case "V": return (CGKeyCode(kVK_ANSI_V), .maskShift)
    case "W": return (CGKeyCode(kVK_ANSI_W), .maskShift)
    case "X": return (CGKeyCode(kVK_ANSI_X), .maskShift)
    case "Y": return (CGKeyCode(kVK_ANSI_Y), .maskShift)
    case "Z": return (CGKeyCode(kVK_ANSI_Z), .maskShift)
    case "0": return (CGKeyCode(kVK_ANSI_0), [])
    case "1": return (CGKeyCode(kVK_ANSI_1), [])
    case "2": return (CGKeyCode(kVK_ANSI_2), [])
    case "3": return (CGKeyCode(kVK_ANSI_3), [])
    case "4": return (CGKeyCode(kVK_ANSI_4), [])
    case "5": return (CGKeyCode(kVK_ANSI_5), [])
    case "6": return (CGKeyCode(kVK_ANSI_6), [])
    case "7": return (CGKeyCode(kVK_ANSI_7), [])
    case "8": return (CGKeyCode(kVK_ANSI_8), [])
    case "9": return (CGKeyCode(kVK_ANSI_9), [])
    case ")": return (CGKeyCode(kVK_ANSI_0), .maskShift)
    case "!": return (CGKeyCode(kVK_ANSI_1), .maskShift)
    case "@": return (CGKeyCode(kVK_ANSI_2), .maskShift)
    case "#": return (CGKeyCode(kVK_ANSI_3), .maskShift)
    case "$": return (CGKeyCode(kVK_ANSI_4), .maskShift)
    case "%": return (CGKeyCode(kVK_ANSI_5), .maskShift)
    case "^": return (CGKeyCode(kVK_ANSI_6), .maskShift)
    case "&": return (CGKeyCode(kVK_ANSI_7), .maskShift)
    case "*": return (CGKeyCode(kVK_ANSI_8), .maskShift)
    case "(": return (CGKeyCode(kVK_ANSI_9), .maskShift)
    case " ": return (CGKeyCode(kVK_Space), [])
    case "-": return (CGKeyCode(kVK_ANSI_Minus), [])
    case "_": return (CGKeyCode(kVK_ANSI_Minus), .maskShift)
    case "=": return (CGKeyCode(kVK_ANSI_Equal), [])
    case "+": return (CGKeyCode(kVK_ANSI_Equal), .maskShift)
    case "[": return (CGKeyCode(kVK_ANSI_LeftBracket), [])
    case "{": return (CGKeyCode(kVK_ANSI_LeftBracket), .maskShift)
    case "]": return (CGKeyCode(kVK_ANSI_RightBracket), [])
    case "}": return (CGKeyCode(kVK_ANSI_RightBracket), .maskShift)
    case "\\": return (CGKeyCode(kVK_ANSI_Backslash), [])
    case "|": return (CGKeyCode(kVK_ANSI_Backslash), .maskShift)
    case ";": return (CGKeyCode(kVK_ANSI_Semicolon), [])
    case ":": return (CGKeyCode(kVK_ANSI_Semicolon), .maskShift)
    case "'": return (CGKeyCode(kVK_ANSI_Quote), [])
    case "\"": return (CGKeyCode(kVK_ANSI_Quote), .maskShift)
    case ",": return (CGKeyCode(kVK_ANSI_Comma), [])
    case "<": return (CGKeyCode(kVK_ANSI_Comma), .maskShift)
    case ".": return (CGKeyCode(kVK_ANSI_Period), [])
    case ">": return (CGKeyCode(kVK_ANSI_Period), .maskShift)
    case "/": return (CGKeyCode(kVK_ANSI_Slash), [])
    case "?": return (CGKeyCode(kVK_ANSI_Slash), .maskShift)
    case "`": return (CGKeyCode(kVK_ANSI_Grave), [])
    case "~": return (CGKeyCode(kVK_ANSI_Grave), .maskShift)
    default:
        return nil
    }
}

func postKeyStroke(_ code: CGKeyCode, flags: CGEventFlags = [], pid: pid_t?) {
    let source = CGEventSource(stateID: .hidSystemState)
    if flags.contains(.maskShift) {
        guard let shiftDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Shift), keyDown: true),
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false),
              let shiftUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Shift), keyDown: false) else {
            fail("input-failed", "Could not create keyboard event.")
        }
        down.flags = flags
        up.flags = flags
        postKeyboardEvent(shiftDown, pid: pid)
        usleep(4_000)
        postKeyboardEvent(down, pid: pid)
        postKeyboardEvent(up, pid: pid)
        usleep(4_000)
        postKeyboardEvent(shiftUp, pid: pid)
    } else {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            fail("input-failed", "Could not create keyboard event.")
        }
        postKeyboardEvent(down, pid: pid)
        postKeyboardEvent(up, pid: pid)
    }
    usleep(60_000)
}

func postUnicodeText(_ text: String, pid: pid_t?) {
    for character in text {
        var units = Array(String(character).utf16)
        guard !units.isEmpty else {
            continue
        }
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            fail("input-failed", "Could not create keyboard event.")
        }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        postKeyboardEvent(down, pid: pid)
        postKeyboardEvent(up, pid: pid)
        usleep(10_000)
    }
}

func postKeyboardEvent(_ event: CGEvent, pid: pid_t?) {
    if let pid = pid, pid > 0 {
        event.postToPid(pid)
    } else {
        event.post(tap: .cghidEventTap)
    }
}

func keyCode(for name: String) -> CGKeyCode? {
    switch name {
    case "enter":
        return CGKeyCode(kVK_Return)
    case "tab":
        return CGKeyCode(kVK_Tab)
    case "escape":
        return CGKeyCode(kVK_Escape)
    case "backspace":
        return CGKeyCode(kVK_Delete)
    case "page-down", "pagedown":
        return CGKeyCode(kVK_PageDown)
    case "page-up", "pageup":
        return CGKeyCode(kVK_PageUp)
    case "ctrl-c", "control-c":
        return CGKeyCode(kVK_ANSI_C)
    default:
        return nil
    }
}

func sendKey(_ windowID: CGWindowID, _ key: String) {
    let focus = ensureFocus(windowID)
    let pid = focusedPid(focus)
    if key == "ctrl-c" || key == "control-c" {
        postControlModifiedKey(CGKeyCode(kVK_ANSI_C), pid: pid)
        emit([
            "ok": true,
            "key": key,
            "windowId": Int(windowID)
        ])
    }
    guard let code = keyCode(for: key) else {
        fail("invalid-key", "Unsupported key: \(key).")
    }
    let source = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
        fail("input-failed", "Could not create keyboard event.")
    }
    postKeyboardEvent(down, pid: pid)
    postKeyboardEvent(up, pid: pid)
    emit([
        "ok": true,
        "key": key,
        "windowId": Int(windowID)
    ])
}

func postControlModifiedKey(_ code: CGKeyCode, pid: pid_t?) {
    let source = CGEventSource(stateID: .hidSystemState)
    guard let controlDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Control), keyDown: true),
          let keyDown = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false),
          let controlUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Control), keyDown: false) else {
        fail("input-failed", "Could not create keyboard event.")
    }
    keyDown.flags = .maskControl
    keyUp.flags = .maskControl
    postKeyboardEvent(controlDown, pid: pid)
    usleep(20_000)
    postKeyboardEvent(keyDown, pid: pid)
    postKeyboardEvent(keyUp, pid: pid)
    usleep(20_000)
    postKeyboardEvent(controlUp, pid: pid)
}

func postCommandModifiedKey(_ code: CGKeyCode, pid: pid_t?) {
    let source = CGEventSource(stateID: .hidSystemState)
    guard let commandDown = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: true),
          let keyDown = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false),
          let commandUp = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Command), keyDown: false) else {
        fail("input-failed", "Could not create keyboard event.")
    }
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    postKeyboardEvent(commandDown, pid: pid)
    usleep(20_000)
    postKeyboardEvent(keyDown, pid: pid)
    postKeyboardEvent(keyUp, pid: pid)
    usleep(20_000)
    postKeyboardEvent(commandUp, pid: pid)
}

let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty || args.contains("--help") || args.contains("-h") {
    usage()
}

switch args[0] {
case "list-windows":
    emit([
        "ok": true,
        "windows": appWindows(includeOffscreen: args.contains("--all"), appName: argValue("--app", in: args))
    ])
case "capture":
    captureWindow(requireWindowID(args))
case "ocr":
    guard let image = argValue("--image", in: args), !image.isEmpty else {
        fail("invalid-image", "Missing --image.")
    }
    runOCR(image, levelArg: argValue("--level", in: args) ?? "best")
case "focus":
    focusWindow(requireWindowID(args))
case "type":
    let windowID = requireWindowID(args)
    guard let text = argValue("--text", in: args) else {
        fail("invalid-text", "Missing --text.")
    }
    typeText(windowID, text)
case "key":
    let windowID = requireWindowID(args)
    guard let key = argValue("--key", in: args) else {
        fail("invalid-key", "Missing --key.")
    }
    sendKey(windowID, key)
default:
    fail("unsupported-command", "Unsupported command: \(args[0]).")
}
