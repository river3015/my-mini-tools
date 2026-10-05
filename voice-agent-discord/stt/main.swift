// macOS 26 の SpeechTranscriber で日本語の音声ファイルを文字にする常駐プログラム。
// 標準入力から WAV ファイルのパスを1行ずつ受け取り、結果を JSON 1行で標準出力に返す。
// 起動直後（言語アセットの準備ができたら）に {"ready":true} を出す
import AVFoundation
import Foundation
import Speech

let locale = Locale(identifier: "ja_JP")

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func transcribe(_ path: String) async throws -> String {
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
  async let text: String = {
    var out = ""
    for try await result in transcriber.results where result.isFinal {
      out += String(result.text.characters)
    }
    return out
  }()
  _ = try await SpeechAnalyzer(inputAudioFile: file, modules: [transcriber], finishAfterFile: true)
  return try await text
}

guard await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil else {
  emit(["error": "SpeechTranscriber does not support \(locale.identifier)"])
  exit(1)
}
// 初回だけ言語のアセットをダウンロードする
if let request = try await AssetInventory.assetInstallationRequest(supporting: [SpeechTranscriber(locale: locale, preset: .transcription)]) {
  try await request.downloadAndInstall()
}
emit(["ready": true])

for try await line in FileHandle.standardInput.bytes.lines {
  let path = line.trimmingCharacters(in: .whitespaces)
  if path.isEmpty { continue }
  let start = Date()
  do {
    let text = try await transcribe(path)
    emit(["text": text, "seconds": Date().timeIntervalSince(start)])
  } catch {
    emit(["error": "\(error)"])
  }
}
