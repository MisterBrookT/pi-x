// Always-on desktop pill for the pix proactive loop.
// Collapsed: a small floating capsule with a bell and pending count.
// Click: expands to what needs you; each loop has its named step (starts a Pi session), Later, and ✕ (drop).
// The iPhone shows the same list in Pix Remote ("For you").
// Reads ~/.pix/proactive/inbox.jsonl; all state changes go through proactive-daemon.ts.
// Build: swiftc -O scripts/proactive-pill.swift -o ~/.pix/proactive/pill
import AppKit
import SwiftUI

let home = FileManager.default.homeDirectoryForCurrentUser.path
let dir = ProcessInfo.processInfo.environment["PIX_PROACTIVE_DIR"] ?? "\(home)/.pix/proactive"
let inbox = "\(dir)/inbox.jsonl"
let daemon = ProcessInfo.processInfo.environment["PIX_PROACTIVE_DAEMON"] ?? "\(home)/workspace/tools/pix/scripts/proactive-daemon.ts"

struct Alert: Identifiable { let id, title, why, source, at, button, due, status, wakeAt: String }

/// Every open loop, newest first. `needsYou` splits them into the actionable list and the quiet rest.
func loadOpen() -> [Alert] {
    guard let text = try? String(contentsOfFile: inbox, encoding: .utf8) else { return [] }
    var merged: [String: [String: Any]] = [:]; var order: [String] = []
    for line in text.split(separator: "\n") {
        guard let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let id = o["id"] as? String else { continue }
        if merged[id] == nil { order.append(id) }
        merged[id, default: [:]].merge(o) { $1 }
    }
    return order.compactMap { id in
        let o = merged[id]!
        // Same rule as src/proactive.ts needsYou: pending, or an open loop whose wake time has come.
        let status = o["status"] as? String ?? ""
        let open = ["pending", "onit", "later", "waiting"].contains(status)
        let woke = (o["wakeAt"] as? String).flatMap { ISO8601DateFormatter.lenient($0) }.map { $0 <= Date() } ?? false
        guard open else { return nil }
        return Alert(id: id, title: o["title"] as? String ?? "", why: o["why"] as? String ?? "", source: o["source"] as? String ?? "", at: o["at"] as? String ?? "", button: o["button"] as? String ?? "", due: o["due"] as? String ?? "", status: status == "pending" || woke ? "pending" : status, wakeAt: o["wakeAt"] as? String ?? "")
    }.reversed()
}

extension ISO8601DateFormatter {
    static func lenient(_ s: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

func sh(_ args: [String]) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = args
    var env = ProcessInfo.processInfo.environment; env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"; p.environment = env
    try? p.run(); p.waitUntilExit()
}

final class Model: ObservableObject {
    @Published var alerts: [Alert] = []
    /// Open loops that do not need brook now (Pi is on it, later, waiting): shown small, below.
    @Published var quiet: [Alert] = []
    @Published var open = false
    var timer: Timer?
    init() { refresh(); timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() } }
    func refresh() {
        let all = loadOpen()
        let a = all.filter { $0.status == "pending" }, q = all.filter { $0.status != "pending" }
        let key = { (x: [Alert]) in x.map { "\($0.id)|\($0.title)|\($0.button)|\($0.due)|\($0.status)" } }
        if key(a) != key(alerts) { alerts = a }
        if key(q) != key(quiet) { quiet = q }
        if a.isEmpty && q.isEmpty { open = false }
    }
    func act(_ a: Alert) {
        // Same path as the phone: the daemon's `act` verb starts a normal Pi session with remote on.
        sh(["env", "PIX_PROACTIVE_DIR=\(dir)", "node", daemon, "act", a.id, "--focus"])
        refresh()
    }
    func dismiss(_ a: Alert) { sh(["env", "PIX_PROACTIVE_DIR=\(dir)", "node", daemon, "dismiss", a.id]); refresh() }
    func later(_ a: Alert) { sh(["env", "PIX_PROACTIVE_DIR=\(dir)", "node", daemon, "later", a.id]); refresh() }
}

/// "Pi is on it", "back Oct 15", "waiting": what a quiet loop is doing.
func quietLabel(_ q: Alert) -> String {
    if q.status == "onit" { return "Pi is on it" }
    let back = ISO8601DateFormatter.lenient(q.wakeAt).map { d -> String in let f = DateFormatter(); f.dateFormat = "MMM d"; return "back \(f.string(from: d))" } ?? ""
    return q.status == "waiting" ? (back.isEmpty ? "waiting" : "waiting · \(back)") : back
}

/// One quiet loop: a single grey line; hovering expands it to the full title and why.
struct QuietRow: View {
    let q: Alert
    @State var hover = false
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: q.status == "onit" ? "play.circle" : "clock").font(.system(size: 10)).padding(.top, 2)
                Text(q.title).font(.system(size: 11)).lineLimit(hover ? nil : 1).fixedSize(horizontal: false, vertical: hover)
                Spacer(minLength: 4)
                Text(quietLabel(q)).font(.system(size: 10)).lineLimit(1)
            }
            if hover && !q.why.isEmpty {
                Text(q.why).font(.system(size: 10)).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true).padding(.leading, 16)
            }
        }
        .foregroundStyle(.secondary).contentShape(Rectangle())
        .onHover { h in withAnimation(.easeOut(duration: 0.12)) { hover = h } }
    }
}

struct Pill: View {
    @ObservedObject var m: Model
    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if m.open && !(m.alerts.isEmpty && m.quiet.isEmpty) {
                VStack(alignment: .leading, spacing: 10) {
                    if m.alerts.isEmpty { Text("Nothing needs you").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary) }
                    ForEach(m.alerts) { a in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(a.title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                            Text(a.why).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(3)
                            HStack {
                                Text(a.due.isEmpty ? a.source : "\(a.source) · due \(a.due)").font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
                                Spacer()
                                Button("Later") { m.later(a) }.buttonStyle(.borderless).font(.system(size: 12))
                                Button { m.dismiss(a) } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).font(.system(size: 11)).help("Drop")
                                Button(a.button.isEmpty ? "Do it" : a.button) { m.act(a) }.buttonStyle(.borderedProminent).controlSize(.small)
                            }
                        }
                        if a.id != m.alerts.last?.id { Divider() }
                    }
                    if !m.quiet.isEmpty {
                        if !m.alerts.isEmpty { Divider() }
                        ForEach(m.quiet) { q in QuietRow(q: q) }
                    }
                }
                .padding(12).frame(width: 320)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
            Button { if !(m.alerts.isEmpty && m.quiet.isEmpty) { m.open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: m.alerts.isEmpty ? "bell" : "bell.badge.fill")
                        .symbolRenderingMode(.palette).foregroundStyle(m.alerts.isEmpty ? .secondary : Color.orange, .primary)
                    if !m.alerts.isEmpty { Text("\(m.alerts.count)").font(.system(size: 13, weight: .semibold)) }
                }
                .padding(.horizontal, 14).frame(height: 34)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.white.opacity(0.15)))
            }.buttonStyle(.plain)
        }
        .padding(6)
        .fixedSize()
    }
}

final class Panel: NSPanel { override var canBecomeKey: Bool { true } }

final class App: NSObject, NSApplicationDelegate {
    var panel: Panel!
    let model = Model()
    func applicationDidFinishLaunching(_: Notification) {
        let host = NSHostingView(rootView: Pill(m: model))
        panel = Panel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.contentView = host; panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
        panel.level = .floating; panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        let place = { [weak self] in
            guard let self, let s = NSScreen.main else { return }
            let size = host.fittingSize; let f = s.visibleFrame
            // Anchor bottom-right; grow upward when expanded.
            let x = UserDefaults.standard.object(forKey: "pillRight") as? CGFloat ?? (f.maxX - 24)
            let y = UserDefaults.standard.object(forKey: "pillBottom") as? CGFloat ?? (f.minY + 24)
            self.panel.setFrame(NSRect(x: x - size.width, y: y, width: size.width, height: size.height), display: true)
        }
        place()
        NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: host, queue: .main) { _ in place() }
        host.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: panel, queue: .main) { [weak self] _ in
            guard let f = self?.panel.frame else { return }
            UserDefaults.standard.set(f.maxX, forKey: "pillRight"); UserDefaults.standard.set(f.minY, forKey: "pillBottom")
        }
        panel.orderFrontRegardless()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App(); app.delegate = delegate
app.run()
