import Foundation

enum Transcriber {
    static let url = URL(string: "https://api.elevenlabs.io/v1/speech-to-text")!

    struct APIError: Error, CustomStringConvertible {
        let status: Int
        let body: String
        var description: String { "HTTP \(status): \(body)" }
    }

    /// Sends audio to ElevenLabs Scribe. Blocks the calling (background) thread.
    static func transcribe(audio: Data, filename: String, config: Config, apiKey: String) throws -> String {
        var fields: [(String, String)] = [
            ("model_id", config.model),
            ("language_code", config.language),
            ("tag_audio_events", "false"),
            ("no_verbatim", config.noVerbatim ? "true" : "false"),
        ]
        // Repeated fields form the keyterms list.
        fields += config.keyterms.map { ("keyterms", $0) }

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

        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try send(request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw APIError(status: status, body: String(decoding: data, as: UTF8.self))
        }
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
