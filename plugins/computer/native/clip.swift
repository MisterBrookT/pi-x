// Save and restore the whole general pasteboard (every item, every type), not only its text.
//   clip save <file>      clip restore <file>
import AppKit
let a = CommandLine.arguments
guard a.count == 3 else { exit(2) }
let pb = NSPasteboard.general, url = URL(fileURLWithPath: a[2])
if a[1] == "save" {
  var items: [[String: Data]] = []
  for item in pb.pasteboardItems ?? [] {
    var d: [String: Data] = [:]
    for t in item.types { if let v = item.data(forType: t) { d[t.rawValue] = v } }
    items.append(d)
  }
  try PropertyListSerialization.data(fromPropertyList: items, format: .binary, options: 0).write(to: url)
} else if a[1] == "restore" {
  let data = try Data(contentsOf: url)
  guard let items = try PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Data]] else { exit(1) }
  pb.clearContents()
  pb.writeObjects(items.map { d in
    let it = NSPasteboardItem()
    for (t, v) in d { it.setData(v, forType: NSPasteboard.PasteboardType(t)) }
    return it
  })
} else { exit(2) }
