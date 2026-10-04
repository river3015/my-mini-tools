import AVFoundation

/// Records 16 kHz mono 16-bit WAV. The recorder is created per recording so
/// the microphone is not held while idle.
final class Recorder {
    private var recorder: AVAudioRecorder?
    private let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("voice-input-\(ProcessInfo.processInfo.processIdentifier).wav")

    func start() -> Bool {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            guard recorder.record() else {
                log("failed to start recording")
                return false
            }
            self.recorder = recorder
            return true
        } catch {
            log("failed to start recording: \(error)")
            return false
        }
    }

    /// Returns the WAV data and its duration in seconds.
    func stop() -> (Data, TimeInterval)? {
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (data, duration)
    }

    /// True when every sample is zero, which is what macOS delivers without
    /// microphone permission.
    static func isSilent(_ wav: Data) -> Bool {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-input-check-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        guard (try? wav.write(to: url)) != nil,
            let file = try? AVAudioFile(forReading: url),
            let buffer = AVAudioPCMBuffer(
                pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
            (try? file.read(into: buffer)) != nil,
            let samples = buffer.floatChannelData?[0]
        else { return false }
        for i in 0..<Int(buffer.frameLength) where samples[i] != 0 {
            return false
        }
        return true
    }
}
