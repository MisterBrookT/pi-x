// click <x> <y>: left-click at a screen point (points).  click locked: exit 0 if the screen is locked.
import CoreGraphics
import Foundation
let a = CommandLine.arguments
if a.count == 2 && a[1] == "locked" {
  let d = CGSessionCopyCurrentDictionary() as? [String: Any]
  exit((d?["CGSSessionScreenIsLocked"] as? Bool) == true ? 0 : 1)
}
guard a.count == 3, let x = Double(a[1]), let y = Double(a[2]) else { exit(2) }
let p = CGPoint(x: x, y: y)
for t in [CGEventType.leftMouseDown, .leftMouseUp] {
  CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(60_000)
}
