import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

enum HelperError: Error, CustomStringConvertible {
    case invalidArguments(String)
    case windowNotFound(String)
    case captureFailed(String)

    var description: String {
        switch self {
        case .invalidArguments(let message):
            return message
        case .windowNotFound(let message):
            return message
        case .captureFailed(let message):
            return message
        }
    }
}

struct HelperOutput: Encodable {
    let pngBase64: String
    let appName: String
    let title: String
    let focused: Bool
}

struct WindowCandidate {
    let windowID: CGWindowID
    let appName: String
    let title: String
    let focused: Bool
    let width: Double
    let height: Double
    let area: Double
}

struct Command {
    let subcommand: String
    let appName: String?
}

func normalize(_ value: String?) -> String {
    (value ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
}

func parseCommand() throws -> Command {
    var iterator = CommandLine.arguments.dropFirst().makeIterator()
    guard let subcommand = iterator.next(), !subcommand.isEmpty else {
        throw HelperError.invalidArguments("missing subcommand")
    }

    var appName: String?
    while let argument = iterator.next() {
        switch argument {
        case "--json":
            continue
        case "--app-name":
            guard let value = iterator.next(), !value.isEmpty else {
                throw HelperError.invalidArguments("missing value for --app-name")
            }
            appName = value
        default:
            throw HelperError.invalidArguments("unsupported argument: \(argument)")
        }
    }

    return Command(subcommand: subcommand, appName: appName)
}

func screenWindowInfoList() -> [[String: Any]] {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) else {
        return []
    }
    return raw as? [[String: Any]] ?? []
}

func selectWindowCandidate(appName requestedAppName: String?) throws -> WindowCandidate {
    let requested = normalize(requestedAppName)
    let frontmostProcessID = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let windows = screenWindowInfoList().compactMap { info -> WindowCandidate? in
        guard let layer = info[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0 else {
            return nil
        }

        guard let windowNumber = info[kCGWindowNumber as String] as? NSNumber else {
            return nil
        }

        let appName = (info[kCGWindowOwnerName as String] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if appName.isEmpty {
            return nil
        }

        let title = (info[kCGWindowName as String] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bounds = info[kCGWindowBounds as String] as? [String: Any]
        let width = (bounds?["Width"] as? NSNumber)?.doubleValue ?? 0
        let height = (bounds?["Height"] as? NSNumber)?.doubleValue ?? 0
        if width <= 1 || height <= 1 {
            return nil
        }

        let ownerPID = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        let focused = ownerPID != nil && frontmostProcessID != nil && ownerPID == frontmostProcessID

        if !requested.isEmpty {
            let normalizedAppName = normalize(appName)
            let normalizedTitle = normalize(title)
            if normalizedAppName != requested && !normalizedAppName.contains(requested) && !normalizedTitle.contains(requested) {
                return nil
            }
        } else if let frontmostProcessID, ownerPID != frontmostProcessID {
            return nil
        }

        return WindowCandidate(
            windowID: CGWindowID(windowNumber.uint32Value),
            appName: appName,
            title: title,
            focused: focused,
            width: width,
            height: height,
            area: width * height
        )
    }

    let sorted = windows.sorted { left, right in
        if left.focused != right.focused {
            return left.focused && !right.focused
        }

        if left.area != right.area {
            return left.area > right.area
        }

        let leftHasTitle = !left.title.isEmpty
        let rightHasTitle = !right.title.isEmpty
        if leftHasTitle != rightHasTitle {
            return leftHasTitle && !rightHasTitle
        }

        if left.height != right.height {
            return left.height > right.height
        }

        if left.width != right.width {
            return left.width > right.width
        }

        return left.windowID < right.windowID
    }

    if let first = sorted.first {
        return first
    }

    if requested.isEmpty {
        throw HelperError.windowNotFound("no visible frontmost window found")
    }

    throw HelperError.windowNotFound("no visible window found for \(requestedAppName ?? "requested app")")
}

func captureWithScreencapture(windowID: CGWindowID) throws -> Data {
    let tempURL = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent(UUID().uuidString)
        .appendingPathExtension("png")
    defer {
        try? FileManager.default.removeItem(at: tempURL)
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l", String(windowID), tempURL.path]
    let stderr = Pipe()
    process.standardError = stderr
    try process.run()
    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        let message = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "screencapture failed"
        throw HelperError.captureFailed(message)
    }

    return try Data(contentsOf: tempURL)
}

@available(macOS 14.0, *)
func captureWithScreenCaptureKit(candidate: WindowCandidate) async throws -> Data {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == candidate.windowID }) else {
        throw HelperError.windowNotFound("screen capture kit could not resolve window \(candidate.windowID)")
    }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.showsCursor = false
    let pixelScale = CGFloat(filter.pointPixelScale)
    configuration.width = max(1, Int(filter.contentRect.width * pixelScale))
    configuration.height = max(1, Int(filter.contentRect.height * pixelScale))

    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw HelperError.captureFailed("failed to encode screenshot as PNG")
    }
    return data
}

func captureWindowImage(candidate: WindowCandidate) async throws -> Data {
    if #available(macOS 14.0, *) {
        do {
            return try await captureWithScreenCaptureKit(candidate: candidate)
        } catch {
            return try captureWithScreencapture(windowID: candidate.windowID)
        }
    }

    return try captureWithScreencapture(windowID: candidate.windowID)
}

func emitJSON(_ output: HelperOutput) throws {
    let encoder = JSONEncoder()
    let data = try encoder.encode(output)
    guard let text = String(data: data, encoding: .utf8) else {
        throw HelperError.captureFailed("failed to encode helper output")
    }
    FileHandle.standardOutput.write(Data(text.utf8))
}

@main
struct YobiMacScreenCaptureHelper {
    static func main() async {
        do {
            let command = try parseCommand()
            guard command.subcommand == "capture-window" else {
                throw HelperError.invalidArguments("unsupported subcommand: \(command.subcommand)")
            }

            let candidate = try selectWindowCandidate(appName: command.appName)
            let pngData = try await captureWindowImage(candidate: candidate)
            try emitJSON(
                HelperOutput(
                    pngBase64: pngData.base64EncodedString(),
                    appName: candidate.appName,
                    title: candidate.title,
                    focused: candidate.focused
                )
            )
        } catch {
            let message: String
            if let helperError = error as? HelperError {
                message = helperError.description
            } else {
                message = error.localizedDescription
            }

            FileHandle.standardError.write(Data(message.utf8))
            exit(1)
        }
    }
}
