import AppKit
import Foundation

func log(_ message: String) {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    let line = "[\(formatter.string(from: Date()))] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
}

func play(_ sound: String) {
    DispatchQueue.main.async { NSSound(named: sound)?.play() }
}

enum APIKey {
    static let keychainService = "voice-input-elevenlabs"

    /// Reads the key through /usr/bin/security, which the Keychain item already
    /// trusts, so rebuilding the app does not trigger a Keychain prompt.
    static func load() throws -> String {
        if let key = ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"], !key.isEmpty {
            return key
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", keychainService, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0, !output.isEmpty else {
            throw ConfigError(
                "ElevenLabs API key not found. Store it in the Keychain:\n"
                    + "  security add-generic-password -s \(keychainService) -a \"$USER\" -w")
        }
        return output
    }
}

/// Keeps recent results so misrecognitions can be reviewed later.
enum History {
    static let url = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".local/state/voice-input/history.jsonl")
    static let maxLines = 1000

    private struct Entry: Encodable {
        let time: String
        let raw: String
        let text: String
    }

    static func append(raw: String, text: String) {
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let formatter = ISO8601DateFormatter()
            formatter.timeZone = .current
            let encoder = JSONEncoder()
            encoder.outputFormatting = .withoutEscapingSlashes
            let entry = Entry(time: formatter.string(from: Date()), raw: raw, text: text)
            let line = String(decoding: try encoder.encode(entry), as: UTF8.self)

            var lines = (try? String(contentsOf: url, encoding: .utf8))?
                .split(separator: "\n", omittingEmptySubsequences: true).map(String.init) ?? []
            lines.append(line)
            let kept = lines.suffix(maxLines).joined(separator: "\n") + "\n"
            try kept.write(to: url, atomically: true, encoding: .utf8)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            log("history write failed: \(error)")
        }
    }
}
