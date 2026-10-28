// appshot <pid> <x> <y> <w> <h> <out.png>: picture of one app inside a screen rect (points), built from its own
// windows (screencapture -l each, back to front: main window, then pop-ups such as WeChat's search results).
// Other apps' windows are left out. The Pix privacy cover hides the screen, and a region capture under it shows
// only the wallpaper; window captures still show the app. Exit 1: no window of that app in the rect.
import AppKit
import CoreGraphics
import Foundation

let a = CommandLine.arguments
guard a.count == 7, let pid = Int(a[1]), let x = Double(a[2]), let y = Double(a[3]), let w = Double(a[4]), let h = Double(a[5]) else { exit(2) }
let rect = CGRect(x: x, y: y, width: w, height: h)
let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []  // front to back
var parts: [(id: Int, frame: CGRect)] = []
for info in all where (info[kCGWindowOwnerPID as String] as? Int) == pid && (info[kCGWindowAlpha as String] as? Double ?? 1) > 0 {
	let b = info[kCGWindowBounds as String] as? [String: Double] ?? [:]
	let f = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
	guard f.width >= 40, f.height >= 40, f.intersects(rect), let id = info[kCGWindowNumber as String] as? Int else { continue }
	parts.append((id, f))
}
guard !parts.isEmpty else { exit(1) }
let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("appshot-\(getpid())")
try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
var ctx: CGContext?
var scale = 0.0
for part in parts.reversed() {
	let file = tmp.appendingPathComponent("\(part.id).png").path
	let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture"); p.arguments = ["-x", "-o", "-l\(part.id)", file]
	try? p.run(); p.waitUntilExit()
	guard let img = NSImage(contentsOfFile: file)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
	if ctx == nil {
		scale = Double(img.width) / part.frame.width
		ctx = CGContext(data: nil, width: Int(w * scale), height: Int(h * scale), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
		ctx?.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx?.fill(CGRect(x: 0, y: 0, width: w * scale, height: h * scale))
	}
	// CoreGraphics origin is bottom-left; screen points are top-left.
	let dx = (part.frame.minX - x) * scale, dy = (y + h - part.frame.maxY) * scale
	ctx?.draw(img, in: CGRect(x: dx, y: dy, width: part.frame.width * scale, height: part.frame.height * scale))
}
try? FileManager.default.removeItem(at: tmp)
guard let out = ctx?.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: out)
guard let data = rep.representation(using: .png, properties: [:]), (try? data.write(to: URL(fileURLWithPath: a[6]))) != nil else { exit(1) }
