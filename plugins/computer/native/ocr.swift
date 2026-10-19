// OCR an image with Apple Vision. Prints one JSON object per text line:
// {"text":..., "x":..., "y":..., "w":..., "h":...} in image pixels, origin top-left.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1, let img = NSImage(contentsOfFile: args[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("usage: ocr <image>\n".data(using: .utf8)!); exit(2)
}
let W = Double(cg.width), H = Double(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg).perform([req])
for o in (req.results ?? []) {
  guard let t = o.topCandidates(1).first else { continue }
  let b = o.boundingBox
  let d: [String: Any] = ["text": t.string, "x": Int(b.minX * W), "y": Int((1 - b.maxY) * H), "w": Int(b.width * W), "h": Int(b.height * H)]
  let j = try JSONSerialization.data(withJSONObject: d)
  print(String(data: j, encoding: .utf8)!)
}
