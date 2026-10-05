// Always-on desktop pill for the pix proactive loop.
// Collapsed: a small floating capsule with a bell and pending count.
// Click: expands to the list; each item has Do it (starts a Pi session) and Not now.
// The iPhone shows the same list in Pix Remote ("For you").
// Reads ~/.pix/proactive/inbox.jsonl; all state changes go through proactive-daemon.ts.
// Build: swiftc -O scripts/proactive-pill.swift -o ~/.pix/proactive/pill
import AppKit
import SwiftUI

let home = FileManager.default.homeDirectoryForCurrentUser.path
let dir = ProcessInfo.processInfo.environment["PIX_PROACTIVE_DIR"] ?? "\(home)/.pix/proactive"
let inbox = "\(dir)/inbox.jsonl"
let daemon = ProcessInfo.processInfo.environment["PIX_PROACTIVE_DAEMON"] ?? "\(home)/workspace/tools/pix/scripts/proactive-daemon.ts"

struct Alert: Identifiable { let id, title, why, source, at: String }

func loadPending() -> [Alert] {
    guard let text = try? String(contentsOfFile: inbox, encoding: .utf8) else { return [] }
    var merged: [String: [String: Any]] = [:]; var order: [String] = []
    for line in text.split(separator: "\n") {
        guard let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let id = o["id"] as? String else { continue }
        if merged[id] == nil { order.append(id) }
        merged[id, default: [:]].merge(o) { $1 }
    }
    return order.compactMap { id in
        let o = merged[id]!
        guard (o["status"] as? String) == "pending" else { return nil }
        return Alert(id: id, title: o["title"] as? String ?? "", why: o["why"] as? String ?? "", source: o["source"] as? String ?? "", at: o["at"] as? String ?? "")
    }.reversed()
}

func sh(_ args: [String]) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = args
    var env = ProcessInfo.processInfo.environment; env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"; p.environment = env
    try? p.run(); p.waitUntilExit()
}

final class Model: ObservableObject {
    @Published var alerts: [Alert] = []
    @Published var open = false
    var timer: Timer?
    init() { refresh(); timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() } }
    func refresh() { let a = loadPending(); if a.map(\.id) != alerts.map(\.id) { alerts = a; if a.isEmpty { open = false } } }
    func act(_ a: Alert) {
        // Same path as the phone: the daemon's `act` verb starts a normal Pi session with remote on.
        sh(["env", "PIX_PROACTIVE_DIR=\(dir)", "node", daemon, "act", a.id])
        refresh()
    }
    func dismiss(_ a: Alert) { sh(["env", "PIX_PROACTIVE_DIR=\(dir)", "node", daemon, "dismiss", a.id]); refresh() }
}

struct Pill: View {
    @ObservedObject var m: Model
    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if m.open && !m.alerts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(m.alerts) { a in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(a.title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                            Text(a.why).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(3)
                            HStack {
                                Text(a.source).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
                                Spacer()
                                Button("Not now") { m.dismiss(a) }.buttonStyle(.borderless).font(.system(size: 12))
                                Button("Do it") { m.act(a) }.buttonStyle(.borderedProminent).controlSize(.small)
                            }
                        }
                        if a.id != m.alerts.last?.id { Divider() }
                    }
                }
                .padding(12).frame(width: 320)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
            Button { if !m.alerts.isEmpty { m.open.toggle() } } label: {
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
