// "Lee" in the iOS share sheet: send a screenshot, photo, text or link to
// Lee's focus or a chosen target, without opening Aeronaut
// (docs/plans/2026-09-28-tether-review-voice.md §4, POST /tether/send).
//
// Aeronaut writes the active Machine (URL, token, name, workspace) into the
// App Group's defaults (AppDelegate.swift, AppGroupBridge); this extension
// only reads them. Voice notes stay in the app.

import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ImageIO

let appGroup = "group.com.intrafocal.aeronaut"

@objc(ShareViewController)
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    let model = ShareModel(context: extensionContext)
    let host = UIHostingController(rootView: ShareView(model: model))
    addChild(host)
    host.view.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(host.view)
    NSLayoutConstraint.activate([
      host.view.topAnchor.constraint(equalTo: view.topAnchor),
      host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    host.didMove(toParent: self)
    model.start()
  }
}

// MARK: - The paired Machine, as Aeronaut left it

struct MachineConfig {
  let hostUrl: String
  let token: String
  let name: String
  let workspace: String?

  static func load() -> MachineConfig? {
    guard let d = UserDefaults(suiteName: appGroup),
          let url = d.string(forKey: "machine_host_url"), !url.isEmpty,
          let token = d.string(forKey: "machine_token"), !token.isEmpty else { return nil }
    let ws = d.string(forKey: "machine_workspace")
    return MachineConfig(hostUrl: url, token: token, name: d.string(forKey: "machine_name") ?? "Lee",
                         workspace: (ws?.isEmpty ?? true) ? nil : ws)
  }
}

// MARK: - What's being shared

struct SharedImage: Identifiable {
  let id = UUID()
  let jpeg: Data
  let thumb: UIImage
  let screenshot: Bool
}

/// Longest side, in pixels, of an image sent to Lee: keeps the extension under iOS's memory limit.
let maxImageSide: CGFloat = 2048
let maxImageBytes = 10 * 1024 * 1024

/// A downscaled JPEG straight from the image's data, without decoding the full image.
func downscaledJpeg(_ data: Data) -> (Data, UIImage)? {
  guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
  let opts: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceThumbnailMaxPixelSize: maxImageSide,
  ]
  guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
  let image = UIImage(cgImage: cg)
  guard let jpeg = image.jpegData(compressionQuality: 0.85), jpeg.count <= maxImageBytes else { return nil }
  return (jpeg, image)
}

// MARK: - Targets (shared/tether.ts SendTarget), kept as the JSON Lee sent

struct Target: Identifiable, Hashable {
  let json: [String: Any]
  var id: String {
    let kind = json["kind"] as? String ?? ""
    if let pty = json["pty_id"] as? Int { return "\(kind):\(pty)" }
    if let card = json["card_id"] as? String { return "\(kind):\(card)" }
    return kind
  }
  var kind: String { json["kind"] as? String ?? "" }
  var label: String {
    switch kind {
    case "page": return "Page: \(json["title"] as? String ?? "Untitled")"
    case "hester": return "Hester"
    case "tab": return "Tab: \(json["label"] as? String ?? "tab")"
    default: return kind
    }
  }
  static func == (a: Target, b: Target) -> Bool { a.id == b.id }
  func hash(into h: inout Hasher) { h.combine(id) }
}

// MARK: - The model

@MainActor
final class ShareModel: ObservableObject {
  weak var context: NSExtensionContext?
  let config = MachineConfig.load()

  @Published var images: [SharedImage] = []
  @Published var text = ""
  @Published var note = ""
  @Published var focus: Target?
  @Published var targets: [Target] = []
  @Published var selected: Target?
  @Published var status: String?
  @Published var busy = false
  @Published var loading = true

  init(context: NSExtensionContext?) { self.context = context }

  var canSubmit: Bool {
    guard let t = selected, t.kind != "page", t.kind != "board" else { return false }
    return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var hasContent: Bool {
    !images.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  func start() {
    Task {
      await loadAttachments()
      await loadTargets()
      loading = false
    }
  }

  func cancel() {
    context?.cancelRequest(withError: NSError(domain: "LeeShare", code: 0))
  }

  private func loadAttachments() async {
    let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    var texts: [String] = []
    for p in providers where images.count < 4 {
      if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
        if let data = await loadImageData(p), let (jpeg, thumb) = downscaledJpeg(data) {
          let png = p.hasItemConformingToTypeIdentifier(UTType.png.identifier)
          images.append(SharedImage(jpeg: jpeg, thumb: thumb, screenshot: png))
        }
      } else if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        if let url = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
          texts.append(url.absoluteString)
        }
      } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        if let s = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
          texts.append(s)
        }
      }
    }
    text = texts.joined(separator: "\n")
  }

  private func loadImageData(_ p: NSItemProvider) async -> Data? {
    guard let item = try? await p.loadItem(forTypeIdentifier: UTType.image.identifier) else { return nil }
    if let url = item as? URL { return try? Data(contentsOf: url) }
    if let data = item as? Data { return data }
    if let image = item as? UIImage { return image.jpegData(compressionQuality: 0.9) }
    return nil
  }

  private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest? {
    guard let c = config, var comps = URLComponents(string: c.hostUrl + path) else { return nil }
    if method == "GET", let ws = c.workspace { comps.queryItems = [URLQueryItem(name: "workspace", value: ws)] }
    guard let url = comps.url else { return nil }
    var r = URLRequest(url: url, timeoutInterval: 20)
    r.httpMethod = method
    r.setValue("Bearer \(c.token)", forHTTPHeaderField: "Authorization")
    if let body = body {
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    return r
  }

  /// Lee answers `{success, data}` or a bare body.
  private func unwrap(_ data: Data) -> [String: Any]? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return (obj["data"] as? [String: Any]) ?? obj
  }

  private func loadTargets() async {
    guard config != nil else {
      status = "Open Aeronaut and pair a Machine first."
      return
    }
    guard let r = request("/tether/targets") else { return }
    do {
      let (data, resp) = try await URLSession.shared.data(for: r)
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      guard code == 200, let body = unwrap(data) else {
        status = code == 401 ? "Lee rejected Aeronaut's token. Re-pair in Aeronaut." : "Lee answered \(code)."
        return
      }
      focus = (body["focus"] as? [String: Any]).map(Target.init(json:))
      targets = (body["targets"] as? [[String: Any]] ?? []).map(Target.init(json:)).filter { $0.kind != "board" }
      selected = focus ?? targets.first
    } catch {
      status = "Can't reach \(config?.name ?? "Lee"). Is Lee running?"
    }
  }

  func send(submit: Bool) {
    guard let target = selected, !busy else { return }
    var items: [[String: Any]] = []
    let caption = note.trimmingCharacters(in: .whitespacesAndNewlines)
    for img in images {
      var item: [String: Any] = [
        "kind": "image", "mime": "image/jpeg", "data_b64": img.jpeg.base64EncodedString(),
        "source": img.screenshot ? "screenshot" : "photo",
      ]
      if !caption.isEmpty, target.kind == "page" { item["caption"] = caption }
      items.append(item)
    }
    var words = text.trimmingCharacters(in: .whitespacesAndNewlines)
    // A note goes with the text (a caption only on a Page, where images take it).
    if !caption.isEmpty, !(target.kind == "page" && !images.isEmpty) {
      words = words.isEmpty ? caption : "\(caption)\n\n\(words)"
    }
    if !words.isEmpty { items.append(["kind": "text", "text": words]) }
    guard !items.isEmpty else { return }
    var body: [String: Any] = ["target": target.json, "items": Array(items.prefix(4)), "submit": submit]
    if let ws = config?.workspace { body["workspace"] = ws }
    guard let r = request("/tether/send", method: "POST", body: body) else { return }
    busy = true
    status = nil
    Task {
      defer { busy = false }
      do {
        let (data, resp) = try await URLSession.shared.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 200 {
          status = "\(submit ? "Sent" : "Delivered") to \(target.label)"
          try? await Task.sleep(nanoseconds: 700_000_000)
          context?.completeRequest(returningItems: nil)
        } else {
          let err = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
          status = err.map { "Lee: \($0)" } ?? "Lee answered \(code)."
        }
      } catch {
        status = "Can't reach \(config?.name ?? "Lee")."
      }
    }
  }
}

// MARK: - The sheet

struct ShareView: View {
  @ObservedObject var model: ShareModel

  var body: some View {
    NavigationView {
      Form {
        if !model.images.isEmpty {
          Section {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack {
                ForEach(model.images) { img in
                  Image(uiImage: img.thumb).resizable().scaledToFill()
                    .frame(width: 88, height: 88).clipShape(RoundedRectangle(cornerRadius: 8))
                }
              }
            }
          }
        }
        if !model.text.isEmpty {
          Section { Text(model.text).lineLimit(6).font(.callout) }
        }
        Section {
          TextField("Add a note", text: $model.note, axis: .vertical).lineLimit(1...5)
        }
        Section(header: Text("To")) {
          if model.loading {
            ProgressView()
          } else if model.focus == nil && model.targets.isEmpty {
            Text("No targets").foregroundColor(.secondary)
          } else {
            Picker("Target", selection: $model.selected) {
              if let f = model.focus {
                Text("\(f.label) (in front)").tag(Optional(f))
              }
              ForEach(model.targets) { t in Text(t.label).tag(Optional(t)) }
            }
            .pickerStyle(.inline)
            .labelsHidden()
          }
        }
        if let s = model.status {
          Section { Text(s).font(.footnote).foregroundColor(.secondary) }
        }
      }
      .navigationTitle(model.config?.name ?? "Lee")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { model.cancel() } }
        ToolbarItemGroup(placement: .bottomBar) {
          Button("Deliver") { model.send(submit: false) }
            .disabled(model.busy || model.selected == nil || !model.hasContent)
          Spacer()
          Button("Send") { model.send(submit: true) }
            .font(.body.weight(.semibold))
            .disabled(model.busy || !model.canSubmit)
        }
      }
    }
  }
}
