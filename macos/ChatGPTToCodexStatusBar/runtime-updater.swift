import Darwin
import Foundation

private struct CommandResult {
    let status: Int32
    let stdout: String
    let stderr: String
}

private enum UpdateError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value): return value
        }
    }
}

private func run(_ executable: String, _ arguments: [String]) throws -> CommandResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    process.waitUntilExit()
    return CommandResult(
        status: process.terminationStatus,
        stdout: String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "",
        stderr: String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    )
}

private func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name),
          CommandLine.arguments.indices.contains(index + 1)
    else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

private func emit(status: String, message: String, exitCode: Int32) -> Never {
    let payload: [String: String] = ["status": status, "message": message]
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print(message)
    }
    exit(exitCode)
}

private func download(_ url: URL, to destination: URL) throws {
    let semaphore = DispatchSemaphore(value: 0)
    var downloadedURL: URL?
    var responseError: Error?
    var responseStatus: Int?
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 600
    let session = URLSession(configuration: configuration)
    session.downloadTask(with: url) { temporaryURL, response, error in
        downloadedURL = temporaryURL
        responseError = error
        responseStatus = (response as? HTTPURLResponse)?.statusCode
        semaphore.signal()
    }.resume()
    semaphore.wait()
    session.finishTasksAndInvalidate()

    if let responseError {
        throw responseError
    }
    guard responseStatus == 200, let downloadedURL else {
        throw UpdateError.message("DMG download failed (HTTP \(responseStatus ?? 0)).")
    }
    try FileManager.default.moveItem(at: downloadedURL, to: destination)
}

private func mountDMG(_ dmg: URL) throws -> URL {
    let result = try run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", dmg.path])
    guard result.status == 0,
          let data = result.stdout.data(using: .utf8),
          let plist = try PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
          ) as? [String: Any],
          let entities = plist["system-entities"] as? [[String: Any]],
          let mountPath = entities.compactMap({ $0["mount-point"] as? String }).last
    else {
        throw UpdateError.message("Could not mount the downloaded DMG. \(result.stderr)")
    }
    return URL(fileURLWithPath: mountPath)
}

private func findApplication(in mountPoint: URL) throws -> URL {
    let preferred = mountPoint.appendingPathComponent("ChatGPT To Codex.app")
    if FileManager.default.fileExists(atPath: preferred.path) {
        return preferred
    }
    let children = try FileManager.default.contentsOfDirectory(
        at: mountPoint,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
    )
    guard let app = children.first(where: { $0.pathExtension == "app" }) else {
        throw UpdateError.message("The DMG does not contain a ChatGPT To Codex app.")
    }
    return app
}

private func teamIdentifier(of application: URL) throws -> String {
    let result = try run("/usr/bin/codesign", ["-d", "--verbose=4", application.path])
    let text = result.stdout + "\n" + result.stderr
    guard result.status == 0,
          let line = text.split(separator: "\n").first(where: { $0.hasPrefix("TeamIdentifier=") })
    else {
        throw UpdateError.message("The application does not have a verifiable signing team.")
    }
    let value = line.dropFirst("TeamIdentifier=".count).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, value != "not set" else {
        throw UpdateError.message("Automatic runtime updates require an Apple team-signed application.")
    }
    return value
}

private func health(port: Int) -> [String: Any]? {
    guard let url = URL(string: "http://127.0.0.1:\(port)/healthz") else { return nil }
    let semaphore = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    var request = URLRequest(url: url)
    request.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: request) { data, response, _ in
        if (response as? HTTPURLResponse)?.statusCode == 200,
           let data,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            result = json
        }
        semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 2)
    return result
}

private func writeRuntimePointer(_ runtime: URL, stateDirectory: URL) throws {
    try FileManager.default.createDirectory(
        at: stateDirectory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    let pointer = stateDirectory.appendingPathComponent("active-runtime")
    try Data((runtime.path + "\n").utf8).write(to: pointer, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pointer.path)
}

private func requestReload(stateDirectory: URL) throws {
    let marker = stateDirectory.appendingPathComponent("runtime-reload-request")
    try Data("update\n".utf8).write(to: marker, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
}

private func restorePointer(_ previous: Data?, stateDirectory: URL) {
    let pointer = stateDirectory.appendingPathComponent("active-runtime")
    if let previous {
        try? previous.write(to: pointer, options: .atomic)
    } else {
        try? FileManager.default.removeItem(at: pointer)
    }
    try? requestReload(stateDirectory: stateDirectory)
}

private func performUpdate() throws -> (status: String, message: String) {
    guard let dmgValue = argument("--dmg-url"),
          let dmgURL = URL(string: dmgValue),
          dmgURL.scheme?.lowercased() == "https",
          let expectedVersion = argument("--version"),
          let portValue = argument("--port"),
          let port = Int(portValue),
          let currentApplicationValue = argument("--current-app")
    else {
        throw UpdateError.message("Invalid updater arguments.")
    }

    let currentApplication = URL(fileURLWithPath: currentApplicationValue)
    let fileManager = FileManager.default
    let temporaryDirectory = fileManager.temporaryDirectory
        .appendingPathComponent("chatgpt2codex-update-\(UUID().uuidString)", isDirectory: true)
    try fileManager.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    defer { try? fileManager.removeItem(at: temporaryDirectory) }

    let dmg = temporaryDirectory.appendingPathComponent("update.dmg")
    try download(dmgURL, to: dmg)
    let mountPoint = try mountDMG(dmg)
    defer { _ = try? run("/usr/bin/hdiutil", ["detach", mountPoint.path, "-quiet"]) }

    let candidateApplication = try findApplication(in: mountPoint)
    let candidateBundle = Bundle(url: candidateApplication)
    guard candidateBundle?.bundleIdentifier == "dev.chatgpttocodex.menubar" else {
        throw UpdateError.message("The downloaded app has an unexpected bundle identifier.")
    }
    let candidateVersion = candidateBundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    guard candidateVersion == expectedVersion else {
        throw UpdateError.message(
            "The downloaded app version (\(candidateVersion ?? "unknown")) does not match \(expectedVersion)."
        )
    }

    let signature = try run(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", "--verbose=2", candidateApplication.path]
    )
    guard signature.status == 0 else {
        throw UpdateError.message("The downloaded app signature is invalid. \(signature.stderr)")
    }
    let currentTeam = try teamIdentifier(of: currentApplication)
    let candidateTeam = try teamIdentifier(of: candidateApplication)
    guard currentTeam == candidateTeam else {
        throw UpdateError.message("The downloaded app is signed by a different Apple team.")
    }

    guard let sourceRuntime = candidateBundle?.resourceURL?
        .appendingPathComponent("chatgpt2codex"),
          fileManager.fileExists(atPath: sourceRuntime.appendingPathComponent("dist/cli.js").path),
          fileManager.fileExists(atPath: sourceRuntime.appendingPathComponent("package.json").path)
    else {
        throw UpdateError.message("The downloaded app does not contain a complete runtime.")
    }

    let supportDirectory = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/ChatGPT To Codex", isDirectory: true)
    let runtimesDirectory = supportDirectory.appendingPathComponent("Runtime", isDirectory: true)
    try fileManager.createDirectory(at: runtimesDirectory, withIntermediateDirectories: true)
    let safeVersion = expectedVersion.replacingOccurrences(
        of: #"[^A-Za-z0-9._-]"#,
        with: "-",
        options: .regularExpression
    )
    let destinationRuntime = runtimesDirectory
        .appendingPathComponent("\(safeVersion)-\(UUID().uuidString)", isDirectory: true)
    try fileManager.copyItem(at: sourceRuntime, to: destinationRuntime)

    let node = destinationRuntime.appendingPathComponent("bin/node")
    guard fileManager.isExecutableFile(atPath: node.path) else {
        try? fileManager.removeItem(at: destinationRuntime)
        throw UpdateError.message("The downloaded runtime does not include executable Node.js.")
    }
    let nodeVersion = try run(node.path, ["-p", "Number(process.versions.node.split('.')[0])"])
    guard nodeVersion.status == 0,
          let nodeMajor = Int(nodeVersion.stdout.trimmingCharacters(in: .whitespacesAndNewlines)),
          nodeMajor >= 22
    else {
        try? fileManager.removeItem(at: destinationRuntime)
        throw UpdateError.message("The downloaded runtime requires a valid bundled Node.js 22 or newer.")
    }

    let stateDirectory = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/share/chatgpt2codex", isDirectory: true)
    let pointer = stateDirectory.appendingPathComponent("active-runtime")
    let previousPointer = try? Data(contentsOf: pointer)
    let previousHealth = health(port: port)
    try writeRuntimePointer(destinationRuntime, stateDirectory: stateDirectory)

    if previousHealth == nil {
        return (
            "staged",
            "Runtime \(expectedVersion) is staged and will be used the next time MCP starts. The macOS app can stay open."
        )
    }

    try requestReload(stateDirectory: stateDirectory)
    let deadline = Date().addingTimeInterval(45)
    while Date() < deadline {
        if let current = health(port: port),
           current["runtimeVersion"] as? String == expectedVersion {
            return (
                "applied",
                "Runtime \(expectedVersion) is active. The Cloudflare tunnel and connector URL were preserved."
            )
        }
        Thread.sleep(forTimeInterval: 0.5)
    }

    restorePointer(previousPointer, stateDirectory: stateDirectory)
    throw UpdateError.message(
        "The new runtime did not become healthy, so the previous runtime was restored. The connector URL was preserved."
    )
}

do {
    let result = try performUpdate()
    emit(status: result.status, message: result.message, exitCode: 0)
} catch {
    emit(status: "failed", message: error.localizedDescription, exitCode: 1)
}
