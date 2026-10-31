// Pix privacy cover: a calm picture (a dog asleep under the moon) over the Mac's displays so people nearby
// can't see. Manual only: shown while argv[1] (~/.pix/mac-controls.json) has "cover": true, which brook sets
// from phone Settings or ⌃⌥C. Real Mac mouse/keyboard input lifts it and writes "cover": false.
// It is only a picture on top: clicks pass through (ignoresMouseEvents), it never takes keyboard focus, and
// screen capture skips it (sharingType = .none), so computer use and screenshots see the real screen.
// Real input = hardware events (source pid 0); synthetic input (computer use, Screen Sharing) has a process id.
// `privacy-cover --snapshot out.png` renders the scene to a file (for tests and screenshots) and exits.
import AppKit
import CoreGraphics

func rgb(_ h: UInt32, _ a: CGFloat = 1) -> NSColor { NSColor(srgbRed: CGFloat(h >> 16 & 255) / 255, green: CGFloat(h >> 8 & 255) / 255, blue: CGFloat(h & 255) / 255, alpha: a) }

/// The scene, drawn in code (no network, no image files). Colours from the rc page's dark paper palette.
final class DogScene: NSView {
	override func draw(_ r: NSRect) {
		let b = bounds, u = min(b.width, b.height) / 900
		NSGradient(colors: [rgb(0x221e19), rgb(0x1b1814)])!.draw(in: b, angle: -90)
		// Moon and a few soft stars.
		rgb(0xefe8db, 0.04).setFill(); NSBezierPath(ovalIn: NSRect(x: b.width * 0.72 - 110 * u, y: b.height * 0.72 - 110 * u, width: 220 * u, height: 220 * u)).fill()
		NSGraphicsContext.saveGraphicsState()
		let cut = NSBezierPath(rect: b); cut.appendOval(in: NSRect(x: b.width * 0.72 - 20 * u, y: b.height * 0.72 - 30 * u, width: 84 * u, height: 84 * u)); cut.windingRule = .evenOdd; cut.addClip()
		rgb(0xefe8db, 0.85).setFill(); NSBezierPath(ovalIn: NSRect(x: b.width * 0.72 - 46 * u, y: b.height * 0.72 - 46 * u, width: 92 * u, height: 92 * u)).fill()
		NSGraphicsContext.restoreGraphicsState()
		for (x, y, s) in [(0.18, 0.80, 3.0), (0.30, 0.66, 2.0), (0.52, 0.86, 2.5), (0.86, 0.50, 2.0), (0.10, 0.55, 2.0), (0.62, 0.62, 1.6)] as [(CGFloat, CGFloat, CGFloat)] {
			rgb(0xefe8db, 0.45).setFill(); NSBezierPath(ovalIn: NSRect(x: b.width * x, y: b.height * y, width: s * u * 2, height: s * u * 2)).fill()
		}
		let cx = b.width / 2, cy = b.height * 0.36
		// Cushion.
		rgb(0x7b5f4a).setFill(); NSBezierPath(ovalIn: NSRect(x: cx - 230 * u, y: cy - 95 * u, width: 460 * u, height: 130 * u)).fill()
		rgb(0x8f6f56).setFill(); NSBezierPath(ovalIn: NSRect(x: cx - 205 * u, y: cy - 70 * u, width: 410 * u, height: 95 * u)).fill()
		let fur = rgb(0xd9b98f), dark = rgb(0xa8845e), ink = rgb(0x29261f)
		// Body, curled.
		fur.setFill(); NSBezierPath(ovalIn: NSRect(x: cx - 160 * u, y: cy - 40 * u, width: 300 * u, height: 150 * u)).fill()
		// Tail wrapped round the front.
		let tail = NSBezierPath(); tail.move(to: NSPoint(x: cx + 130 * u, y: cy + 10 * u))
		tail.curve(to: NSPoint(x: cx - 60 * u, y: cy - 40 * u), controlPoint1: NSPoint(x: cx + 150 * u, y: cy - 50 * u), controlPoint2: NSPoint(x: cx + 40 * u, y: cy - 60 * u))
		tail.lineWidth = 34 * u; tail.lineCapStyle = .round; dark.setStroke(); tail.stroke()
		// Head resting on the paws, left.
		fur.setFill(); NSBezierPath(ovalIn: NSRect(x: cx - 205 * u, y: cy - 30 * u, width: 140 * u, height: 115 * u)).fill()
		NSBezierPath(ovalIn: NSRect(x: cx - 235 * u, y: cy - 28 * u, width: 80 * u, height: 60 * u)).fill()  // muzzle
		dark.setFill()
		let ear = NSBezierPath(); ear.move(to: NSPoint(x: cx - 120 * u, y: cy + 75 * u))
		ear.curve(to: NSPoint(x: cx - 95 * u, y: cy - 5 * u), controlPoint1: NSPoint(x: cx - 70 * u, y: cy + 90 * u), controlPoint2: NSPoint(x: cx - 60 * u, y: cy + 20 * u))
		ear.curve(to: NSPoint(x: cx - 120 * u, y: cy + 75 * u), controlPoint1: NSPoint(x: cx - 120 * u, y: cy + 20 * u), controlPoint2: NSPoint(x: cx - 135 * u, y: cy + 50 * u))
		ear.fill()
		NSBezierPath(ovalIn: NSRect(x: cx - 238 * u, y: cy + 2 * u, width: 22 * u, height: 16 * u)).fill()  // nose
		ink.setFill(); NSBezierPath(ovalIn: NSRect(x: cx - 236 * u, y: cy + 5 * u, width: 16 * u, height: 11 * u)).fill()
		// Closed eye.
		let eye = NSBezierPath(); eye.move(to: NSPoint(x: cx - 175 * u, y: cy + 40 * u))
		eye.curve(to: NSPoint(x: cx - 145 * u, y: cy + 40 * u), controlPoint1: NSPoint(x: cx - 168 * u, y: cy + 30 * u), controlPoint2: NSPoint(x: cx - 152 * u, y: cy + 30 * u))
		eye.lineWidth = 4 * u; eye.lineCapStyle = .round; ink.setStroke(); eye.stroke()
		// Front paws.
		fur.setFill(); NSBezierPath(roundedRect: NSRect(x: cx - 200 * u, y: cy - 48 * u, width: 120 * u, height: 32 * u), xRadius: 16 * u, yRadius: 16 * u).fill()
		// z z z
		for (i, s) in [22.0, 30.0, 40.0].enumerated() {
			let z = NSAttributedString(string: "z", attributes: [.font: NSFont.systemFont(ofSize: CGFloat(s) * u, weight: .light), .foregroundColor: rgb(0xefe8db, 0.35 + 0.15 * CGFloat(i))])
			z.draw(at: NSPoint(x: cx - 150 * u + CGFloat(i) * 38 * u, y: cy + 115 * u + CGFloat(i) * 34 * u))
		}
		let t = NSAttributedString(string: "Away for a bit", attributes: [.font: NSFont.systemFont(ofSize: 15, weight: .regular), .foregroundColor: rgb(0xb3a994, 0.7)])
		t.draw(at: NSPoint(x: (b.width - t.size().width) / 2, y: 40))
	}
}

let args = CommandLine.arguments
if args.count > 2 && args[1] == "--snapshot" {
	let v = DogScene(frame: NSRect(x: 0, y: 0, width: 1440, height: 900))
	let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds)!; v.cacheDisplay(in: v.bounds, to: rep)
	try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2])); exit(0)
}

let flag = args.count > 1 ? args[1] : NSHomeDirectory() + "/.pix/mac-controls.json"
var lastReal = Date.distantPast
// One cover per Mac: several Pi hubs each start a helper; only the first keeps running.
let lockFd = open(NSHomeDirectory() + "/.pix/cover.lock", O_CREAT | O_RDWR, 0o644)
// The others wait (and quit with their hub), taking over if the running one goes away.
FileHandle.standardInput.readabilityHandler = { h in if h.availableData.isEmpty { exit(0) } }
while lockFd >= 0 && flock(lockFd, LOCK_EX | LOCK_NB) != 0 { sleep(5) }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

var wins: [NSWindow] = []
func build() {
	for w in wins { w.orderOut(nil) }
	wins = NSScreen.screens.map { s in
		let w = NSWindow(contentRect: s.frame, styleMask: .borderless, backing: .buffered, defer: false)
		w.level = .screenSaver; w.backgroundColor = .black; w.isOpaque = true
		w.sharingType = .none
		w.ignoresMouseEvents = true
		w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
		w.contentView = DogScene(frame: NSRect(origin: .zero, size: s.frame.size))
		w.setFrame(s.frame, display: false)
		return w
	}
}
build()
NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in build(); shown = nil }

func readControls() -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: flag)))) as? [String: Any] ?? [:] }
func coverOn() -> Bool { readControls()["cover"] as? Bool == true }
var shownAt = Date.distantPast
/// Real Mac input while covered: brook is back at the Mac, so turn the toggle off (not just hide).
func lift() {
	guard shown == true, Date().timeIntervalSince(shownAt) > 2 else { return }  // a moment's grace after turning on
	var c = readControls(); c["cover"] = false
	if let d = try? JSONSerialization.data(withJSONObject: c) { let tmp = flag + ".cover.tmp"; try? d.write(to: URL(fileURLWithPath: tmp)); rename(tmp, flag) }
	tick()
}

// Hardware input lifts the cover at once.
let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel, .leftMouseDragged, .flagsChanged]
let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
let cb: CGEventTapCallBack = { _, type, e, _ in
	if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return Unmanaged.passUnretained(e) }
	if e.getIntegerValueField(.eventSourceUnixProcessID) == 0 { lastReal = Date(); DispatchQueue.main.async { lift() } }
	return Unmanaged.passUnretained(e)
}
if let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask, callback: cb, userInfo: nil) {
	CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
	CGEvent.tapEnable(tap: tap, enable: true)
} else {
	FileHandle.standardError.write("pix-cover: no event tap; Mac input will not lift the cover, turn it off from the phone\n".data(using: .utf8)!)
}

var shown: Bool?
func tick() {
	let show = coverOn()
	if show == shown { return }
	shown = show
	if show { shownAt = Date() }
	for w in wins { if show { w.orderFrontRegardless() } else { w.orderOut(nil) } }
	print(show ? "cover on" : "cover off"); fflush(stdout)
}
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in tick() }
app.run()
