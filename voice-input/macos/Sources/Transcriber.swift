import Foundation

enum Provider: String, CaseIterable {
    case elevenlabs
    case groq

    var keychainService: String { "voice-input-\(rawValue)" }
    var environmentVariable: String { rawValue == "elevenlabs" ? "ELEVENLABS_API_KEY" : "GROQ_API_KEY" }
}

struct APIError: Error, CustomStringConvertible {
    let provider: Provider
    let status: Int
    let body: String
    var description: String { "\(provider.rawValue) HTTP \(status): \(body)" }

    /// Out of credits or quota, as opposed to a one-off failure.
    var isQuotaExhausted: Bool {
        status == 402 || body.contains("insufficient_credits") || body.contains("quota_exceeded")
    }
}

/// Tries providers in the configured order and falls back on failure.
/// A provider that ran out of credits is skipped for a while.
final class Transcriber {
    private let skipAfterQuotaError: TimeInterval = 3600
    private var exhaustedUntil: [Provider: Date] = [:]
    private var keys: [Provider: String] = [:]

    init() {
        for provider in Provider.allCases {
            if let key = APIKey.load(for: provider) { keys[provider] = key }
        }
    }

    var availableProviders: [Provider] { Provider.allCases.filter { keys[$0] != nil } }

    /// Blocks the calling (background) thread. Returns the text and the provider used.
    func transcribe(audio: Data, filename: String, config: Config) throws -> (String, Provider) {
        var lastError: Error = ConfigError(
            "no usable provider. Store an API key: security add-generic-password -s voice-input-<provider> -a \"$USER\" -w")
        for provider in config.providers {
            guard let key = keys[provider] else { continue }
            if let until = exhaustedUntil[provider], until > Date() { continue }
            do {
                let text =
                    switch provider {
                    case .elevenlabs: try Self.elevenLabs(audio, filename, config, key)
                    case .groq: try Self.groq(audio, filename, config, key)
                    }
                return (text, provider)
            } catch let error as APIError where error.isQuotaExhausted {
                log("\(provider.rawValue) is out of credits, skipping it for an hour: \(error)")
                exhaustedUntil[provider] = Date().addingTimeInterval(skipAfterQuotaError)
                lastError = error
            } catch {
                log("\(provider.rawValue) failed, trying the next provider: \(error)")
                lastError = error
            }
        }
        throw lastError
    }

    // https://elevenlabs.io/docs/api-reference/speech-to-text/convert
    private static func elevenLabs(_ audio: Data, _ filename: String, _ config: Config, _ key: String) throws
        -> String
    {
        var fields: [(String, String)] = [
            ("model_id", config.model),
            ("language_code", config.language),
            ("tag_audio_events", "false"),
            ("no_verbatim", config.noVerbatim ? "true" : "false"),
        ]
        // Repeated fields form the keyterms list.
        fields += config.keyterms.map { ("keyterms", $0) }
        return try post(
            .elevenlabs, url: "https://api.elevenlabs.io/v1/speech-to-text",
            headers: ["xi-api-key": key], fields: fields, audio: audio, filename: filename)
    }

    // https://console.groq.com/docs/speech-to-text
    private static func groq(_ audio: Data, _ filename: String, _ config: Config, _ key: String) throws -> String {
        var fields: [(String, String)] = [
            ("model", config.groqModel),
            ("language", config.language),
            ("response_format", "json"),
            ("temperature", "0"),
        ]
        // Whisper has no keyterms; a prompt listing the terms biases spelling.
        // The prompt is limited to 224 tokens, so keep it short.
        var prompt = ""
        for term in config.keyterms {
            let next = prompt.isEmpty ? term : prompt + "、" + term
            if next.count > 200 { break }
            prompt = next
        }
        if !prompt.isEmpty { fields.append(("prompt", prompt)) }
        return try post(
            .groq, url: "https://api.groq.com/openai/v1/audio/transcriptions",
            headers: ["Authorization": "Bearer \(key)"], fields: fields, audio: audio, filename: filename)
    }

    private static func post(
        _ provider: Provider, url: String, headers: [String: String], fields: [(String, String)],
        audio: Data, filename: String
    ) throws -> String {
        let boundary = "voice-input-\(UUID().uuidString)"
        var body = Data()
        for (name, value) in fields {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        body.append(
            "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n"
                + "Content-Type: application/octet-stream\r\n\r\n")
        body.append(audio)
        body.append("\r\n--\(boundary)--\r\n")

        var request = URLRequest(url: URL(string: url)!, timeoutInterval: 60)
        request.httpMethod = "POST"
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try send(request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw APIError(provider: provider, status: status, body: String(decoding: data, as: UTF8.self))
        }
        // Both APIs return {"text": "..."}.
        struct Result: Decodable { let text: String }
        return try JSONDecoder().decode(Result.self, from: data).text
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<(Data, URLResponse), Error> = .failure(URLError(.unknown))
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let data, let response {
                result = .success((data, response))
            } else {
                result = .failure(error ?? URLError(.badServerResponse))
            }
            semaphore.signal()
        }.resume()
        semaphore.wait()
        return try result.get()
    }
}

extension Data {
    fileprivate mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}
