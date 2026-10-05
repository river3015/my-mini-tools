// Push-to-talk dictation for macOS using ElevenLabs Scribe.
//
// Hold the hotkey (right Command by default) while speaking. On release, the
// recording is transcribed with keyterms from the config, the replacement
// dictionary is applied, and the text is pasted into the frontmost app.

import AVFoundation
import AppKit

let minSeconds: TimeInterval = 0.3

final class Dictation {
    private var config: Config
    private var configMTime: Date?
    private let transcriber: Transcriber
    private let pasteEnabled: Bool
    private let hotkey: Hotkey
    private let recorder = Recorder()
    private var recording = false
    private var cancelled = false
    // Serial so results are pasted in the order they were spoken.
    private let jobs = DispatchQueue(label: "voice-input.jobs")
    private var tap: CFMachPort?

    init(config: Config, transcriber: Transcriber, pasteEnabled: Bool) {
        self.config = config
        self.configMTime = Dictation.mtime()
        self.transcriber = transcriber
        self.pasteEnabled = pasteEnabled
        self.hotkey = Hotkey.all[config.hotkey]!
    }

    private static func mtime() -> Date? {
        try? FileManager.default.attributesOfItem(atPath: Config.path.path)[.modificationDate] as? Date
    }

    /// Picks up vocabulary edits without a restart. The hotkey needs a restart.
    private func reloadConfig() {
        let mtime = Dictation.mtime()
        guard mtime != configMTime else { return }
        configMTime = mtime
        do {
            config = try Config.load()
            log("config reloaded: \(config.keyterms.count) keyterms")
        } catch {
            log("config reload failed, keeping the previous config: \(error)")
        }
    }

    func start() throws {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, info in
            let dictation = Unmanaged<Dictation>.fromOpaque(info!).takeUnretainedValue()
            dictation.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }
        guard
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                eventsOfInterest: CGEventMask(mask), callback: callback,
                userInfo: Unmanaged.passUnretained(self).toOpaque())
        else {
            throw ConfigError("cannot listen to the keyboard. Allow Input Monitoring for VoiceInput.app")
        }
        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        log("ready. hold \(config.hotkey) to dictate")
    }

    private func handle(type: CGEventType, event: CGEvent) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        default:
            break
        }
        if event.getIntegerValueField(.eventSourceUserData) == Paster.syntheticEventTag { return }

        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if type == .flagsChanged && keyCode == hotkey.keyCode {
            let down = event.flags.rawValue & hotkey.deviceMask != 0
            down ? hotkeyDown() : hotkeyUp()
        } else if recording {
            // Another key while holding the hotkey means a normal shortcut.
            cancelled = true
        }
    }

    private func hotkeyDown() {
        guard !recording else { return }
        cancelled = false
        recording = recorder.start()
        if recording { play("Tink") }
    }

    private func hotkeyUp() {
        guard recording else { return }
        recording = false
        guard let (wav, duration) = recorder.stop(), !cancelled, duration >= minSeconds else { return }
        play("Pop")
        jobs.async { self.process(wav) }
    }

    private func process(_ wav: Data) {
        if Recorder.isSilent(wav) {
            log("recorded silence only. check the microphone permission")
            play("Basso")
            return
        }
        reloadConfig()
        let started = Date()
        let raw: String
        let provider: Provider
        do {
            (raw, provider) = try transcriber.transcribe(audio: wav, filename: "audio.wav", config: config)
        } catch {
            log("transcription failed: \(error)")
            play("Basso")
            return
        }
        let text = config.apply(to: raw)
        log(String(format: "%.1fs %@: ", Date().timeIntervalSince(started), provider.rawValue) + text)
        History.append(raw: raw, text: text, provider: provider)
        if pasteEnabled && !text.isEmpty { Paster.paste(text) }
    }
}

func requestPermissions() {
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        if !granted { log("microphone access denied. Allow it in System Settings > Privacy & Security") }
    }
    // These add the app to the lists in System Settings and show a prompt once.
    if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
    if !CGPreflightPostEventAccess() { _ = CGRequestPostEventAccess() }
}

func main() -> Int32 {
    let args = Array(CommandLine.arguments.dropFirst())
    do {
        if args.first == "--check-config" {
            let config = try Config.load()
            print("hotkey=\(config.hotkey) language=\(config.language) model=\(config.model) "
                + "no_verbatim=\(config.noVerbatim) providers=\(config.providers.map(\.rawValue)) "
                + "groq_model=\(config.groqModel) keyterms=\(config.keyterms) "
                + "replacements=\(config.replacements.map { "\($0.0)->\($0.1)" })")
            return 0
        }
        var config = try Config.load()
        let transcriber = Transcriber()
        let available = Set(transcriber.availableProviders)
        log("providers: " + config.providers.map { "\($0.rawValue)\(available.contains($0) ? "" : " (no API key)")" }
            .joined(separator: " -> "))

        if args.first == "--file", args.count == 2 || (args.count == 4 && args[2] == "--provider") {
            if args.count == 4 {
                guard let provider = Provider(rawValue: args[3]) else { throw ConfigError("unknown provider") }
                config.providers = [provider]
            }
            let url = URL(fileURLWithPath: args[1])
            let (raw, provider) = try transcriber.transcribe(
                audio: try Data(contentsOf: url), filename: url.lastPathComponent, config: config)
            log("provider: \(provider.rawValue)")
            print(config.apply(to: raw))
            return 0
        }
        guard args.isEmpty || args == ["--no-paste"] else {
            print("usage: VoiceInput [--no-paste | --file AUDIO [--provider NAME] | --check-config]")
            return 2
        }

        // "Quit & Reopen" after granting a permission, or login item restoration,
        // can start a second copy outside launchd; both would paste.
        let others = NSRunningApplication.runningApplications(
            withBundleIdentifier: Bundle.main.bundleIdentifier ?? ""
        ).filter { $0.processIdentifier != getpid() }
        if !others.isEmpty {
            log("already running (pid \(others.map(\.processIdentifier))), exiting")
            return 0
        }

        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        requestPermissions()
        let dictation = Dictation(config: config, transcriber: transcriber, pasteEnabled: args.isEmpty)
        try dictation.start()
        app.run()
        return 0
    } catch {
        log("\(error)")
        return 1
    }
}

exit(main())
