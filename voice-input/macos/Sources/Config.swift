import Foundation

struct Hotkey {
    let keyCode: Int64
    // Device-dependent modifier bit that tells left and right keys apart.
    let deviceMask: UInt64

    static let all: [String: Hotkey] = [
        "cmd_r": Hotkey(keyCode: 54, deviceMask: 0x10),
        "alt_r": Hotkey(keyCode: 61, deviceMask: 0x40),
        "ctrl_r": Hotkey(keyCode: 62, deviceMask: 0x2000),
        "shift_r": Hotkey(keyCode: 60, deviceMask: 0x04),
    ]
}

struct Config {
    var hotkey = "cmd_r"
    var language = "ja"
    var model = "scribe_v2"
    var noVerbatim = true
    var keyterms: [String] = []
    // Ordered: replacements are applied from top to bottom.
    var replacements: [(String, String)] = []

    static let path: URL =
        if let override = ProcessInfo.processInfo.environment["VOICE_INPUT_CONFIG"] {
            URL(fileURLWithPath: override)
        } else {
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".config/voice-input/config.toml")
        }

    static func load(from url: URL = path) throws -> Config {
        var config = Config()
        guard FileManager.default.fileExists(atPath: url.path) else { return config }
        let doc = try TOMLSubset.parse(String(contentsOf: url, encoding: .utf8))
        for (key, value) in doc.root {
            switch (key, value) {
            case ("hotkey", .string(let s)): config.hotkey = s
            case ("language", .string(let s)): config.language = s
            case ("model", .string(let s)): config.model = s
            case ("no_verbatim", .bool(let b)): config.noVerbatim = b
            case ("keyterms", .array(let a)): config.keyterms = a
            default: throw ConfigError("unknown key or wrong type: \(key)")
            }
        }
        for (table, entries) in doc.tables {
            guard table == "replacements" else { throw ConfigError("unknown table: \(table)") }
            for (src, value) in entries {
                guard case .string(let dst) = value else {
                    throw ConfigError("replacement must be a string: \(src)")
                }
                config.replacements.append((src, dst))
            }
        }
        guard Hotkey.all[config.hotkey] != nil else {
            throw ConfigError("hotkey must be one of: \(Hotkey.all.keys.sorted().joined(separator: ", "))")
        }
        config.keyterms = validKeyterms(config.keyterms)
        return config
    }

    // Constraints of the ElevenLabs keyterms parameter.
    private static func validKeyterms(_ terms: [String]) -> [String] {
        let forbidden = Set("<>{}[]\\")
        var valid: [String] = []
        for raw in terms {
            let term = raw.trimmingCharacters(in: .whitespaces)
            if term.isEmpty || term.count >= 50 || term.split(separator: " ").count > 5 {
                log("skip keyterm (length or word count): \(term)")
            } else if term.contains(where: forbidden.contains) {
                log("skip keyterm (forbidden character): \(term)")
            } else {
                valid.append(term)
            }
        }
        return Array(valid.prefix(1000))
    }

    func apply(to text: String) -> String {
        replacements.reduce(text) { $0.replacingOccurrences(of: $1.0, with: $1.1) }
    }
}

struct ConfigError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Parser for the TOML subset used by config.toml: strings, booleans,
/// (multi-line) arrays of strings, and [tables] of key = "string".
enum TOMLSubset {
    enum Value {
        case string(String)
        case bool(Bool)
        case array([String])
    }

    struct Document {
        var root: [(String, Value)] = []
        var tables: [(String, [(String, Value)])] = []
    }

    static func parse(_ text: String) throws -> Document {
        var doc = Document()
        var current: Int?  // index into doc.tables
        var lines = text.components(separatedBy: "\n").enumerated().makeIterator()

        while let (index, rawLine) = lines.next() {
            let lineNo = index + 1
            var line = stripComment(rawLine).trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }

            if line.hasPrefix("[") && line.hasSuffix("]") && !line.contains("=") {
                let name = String(line.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
                doc.tables.append((name, []))
                current = doc.tables.count - 1
                continue
            }

            // Arrays may span lines; read until the closing bracket.
            while !bracketsClosed(line) {
                guard let (_, next) = lines.next() else {
                    throw ConfigError("line \(lineNo): unterminated array")
                }
                line += " " + stripComment(next).trimmingCharacters(in: .whitespaces)
            }

            var scanner = Cursor(line)
            let key = try scanner.key(lineNo)
            scanner.skipSpaces()
            guard scanner.eat("=") else { throw ConfigError("line \(lineNo): expected '='") }
            scanner.skipSpaces()
            let value = try scanner.value(lineNo)
            scanner.skipSpaces()
            guard scanner.atEnd else { throw ConfigError("line \(lineNo): trailing characters") }

            if let i = current {
                doc.tables[i].1.append((key, value))
            } else {
                doc.root.append((key, value))
            }
        }
        return doc
    }

    private static func stripComment(_ line: String) -> String {
        var quote: Character?
        var escaped = false
        for (i, c) in zip(line.indices, line) {
            if let q = quote {
                if escaped { escaped = false } else if c == "\\" && q == "\"" { escaped = true } else if c == q { quote = nil }
            } else if c == "\"" || c == "'" {
                quote = c
            } else if c == "#" {
                return String(line[..<i])
            }
        }
        return line
    }

    private static func bracketsClosed(_ line: String) -> Bool {
        var depth = 0
        var quote: Character?
        var escaped = false
        for c in line {
            if let q = quote {
                if escaped { escaped = false } else if c == "\\" && q == "\"" { escaped = true } else if c == q { quote = nil }
            } else if c == "\"" || c == "'" {
                quote = c
            } else if c == "[" {
                depth += 1
            } else if c == "]" {
                depth -= 1
            }
        }
        return depth == 0
    }

    private struct Cursor {
        let chars: [Character]
        var pos = 0
        init(_ s: String) { chars = Array(s) }

        var atEnd: Bool { pos >= chars.count }
        var peek: Character? { atEnd ? nil : chars[pos] }

        mutating func skipSpaces() {
            while let c = peek, c == " " || c == "\t" { pos += 1 }
        }

        mutating func eat(_ c: Character) -> Bool {
            if peek == c { pos += 1; return true }
            return false
        }

        mutating func key(_ lineNo: Int) throws -> String {
            if peek == "\"" || peek == "'" { return try string(lineNo) }
            var key = ""
            while let c = peek, c.isLetter || c.isNumber || c == "_" || c == "-" {
                key.append(c)
                pos += 1
            }
            guard !key.isEmpty else { throw ConfigError("line \(lineNo): expected a key") }
            return key
        }

        mutating func value(_ lineNo: Int) throws -> Value {
            switch peek {
            case "\"", "'":
                return .string(try string(lineNo))
            case "[":
                pos += 1
                var items: [String] = []
                while true {
                    skipSpaces()
                    if eat("]") { return .array(items) }
                    items.append(try string(lineNo))
                    skipSpaces()
                    if eat(",") { continue }
                    skipSpaces()
                    guard eat("]") else { throw ConfigError("line \(lineNo): expected ',' or ']'") }
                    return .array(items)
                }
            default:
                let rest = String(chars[pos...])
                for (word, b) in [("true", true), ("false", false)] where rest.hasPrefix(word) {
                    pos += word.count
                    return .bool(b)
                }
                throw ConfigError("line \(lineNo): unsupported value")
            }
        }

        mutating func string(_ lineNo: Int) throws -> String {
            let quote = chars[pos]
            pos += 1
            var out = ""
            while let c = peek {
                pos += 1
                if c == quote { return out }
                if c == "\\" && quote == "\"" {
                    guard let e = peek else { break }
                    pos += 1
                    switch e {
                    case "n": out.append("\n")
                    case "t": out.append("\t")
                    case "\"", "\\": out.append(e)
                    default: throw ConfigError("line \(lineNo): unsupported escape \\\(e)")
                    }
                } else {
                    out.append(c)
                }
            }
            throw ConfigError("line \(lineNo): unterminated string")
        }
    }
}
