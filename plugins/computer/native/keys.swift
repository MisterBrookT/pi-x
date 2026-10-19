// Post keys to one app's process without bringing it to the front (CGEventPostToPid).
//   keys <pid> code <keycode> [cmd|shift|alt|ctrl ...]   one chord
//   keys <pid> text <string>                             type unicode text
import CoreGraphics
import Foundation
let a = CommandLine.arguments
guard a.count >= 4, let p = Int32(a[1]) else { exit(2) }
let pid = pid_t(p)
let src = CGEventSource(stateID: .hidSystemState)
if a[2] == "code", let code = UInt16(a[3]) {
  var flags: CGEventFlags = []
  for m in a.dropFirst(4) {
    switch m { case "cmd": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "alt": flags.insert(.maskAlternate); case "ctrl": flags.insert(.maskControl); default: exit(2) }
  }
  for down in [true, false] {
    guard let e = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: down) else { exit(1) }
    e.flags = flags; e.postToPid(pid); usleep(20_000)
  }
} else if a[2] == "text" {
  for ch in a[3].utf16 {
    var c = ch
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down) else { exit(1) }
      e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c); e.postToPid(pid); usleep(8_000)
    }
  }
} else { exit(2) }
