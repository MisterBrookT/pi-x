// Pix privacy cover: while brook drives the Mac from his phone, black out the Mac's own displays so people
// nearby can't see. It is only a picture on top: clicks pass through (ignoresMouseEvents), it never takes
// keyboard focus, and screen capture skips it (sharingType = .none), so computer use and screenshots
// still see and drive the real screen underneath.
//
// Shown while the phone is in use (the hub writes "until" epoch ms to argv[1]: while the Pix page is visible on the phone) and no one touched the
// Mac's real mouse or keyboard for 2 min. Real input = hardware events (source pid 0); synthetic input
// from computer use or Screen Sharing has a process id and does not lift the cover.
import AppKit
import CoreGraphics

let flag = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSHomeDirectory() + "/.pix/phone-active"
let idleNeeded = Double(ProcessInfo.processInfo.environment["PIX_COVER_MAC_IDLE_SEC"] ?? "") ?? 120  // never cover while brook uses the Mac
var lastReal = Date()
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
		let t = NSTextField(labelWithString: "In use from iPhone")
		t.textColor = NSColor(white: 1, alpha: 0.35); t.font = .systemFont(ofSize: 15)
		t.sizeToFit(); t.frame.origin = CGPoint(x: (s.frame.width - t.frame.width) / 2, y: 40)
		w.contentView?.addSubview(t)
		w.setFrame(s.frame, display: false)
		return w
	}
}
build()
NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in build(); shown = nil }

// Hardware input lifts the cover at once.
let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel, .leftMouseDragged, .flagsChanged]
let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
let cb: CGEventTapCallBack = { _, type, e, _ in
	if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return Unmanaged.passUnretained(e) }
	if e.getIntegerValueField(.eventSourceUnixProcessID) == 0 { lastReal = Date(); DispatchQueue.main.async { tick() } }
	return Unmanaged.passUnretained(e)
}
if let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask, callback: cb, userInfo: nil) {
	CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
	CGEvent.tapEnable(tap: tap, enable: true)
} else {
	// No input-monitoring permission: fall back to the HID idle timer (synthetic input also resets it).
	FileHandle.standardError.write("pix-cover: no event tap; using idle time\n".data(using: .utf8)!)
}

func phoneActive() -> Bool {
	guard let s = try? String(contentsOfFile: flag, encoding: .utf8), let until = Double(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
	return until > Date().timeIntervalSince1970 * 1000
}
var shown: Bool?
func tick() {
	let show = phoneActive() && Date().timeIntervalSince(lastReal) >= idleNeeded
	if show == shown { return }
	shown = show
	for w in wins { if show { w.orderFrontRegardless() } else { w.orderOut(nil) } }
	print(show ? "cover on" : "cover off"); fflush(stdout)
}
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in tick() }
// Quit with the hub: stdin closes when the parent goes away.
FileHandle.standardInput.readabilityHandler = { h in if h.availableData.isEmpty { exit(0) } }
app.run()
