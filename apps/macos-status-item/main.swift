import AppKit
import Foundation

struct State: Codable { let paused: Bool }

func fail(_ message: String) -> Never { fputs("\(message)\n", stderr); exit(2) }
func validatedStatePath() -> String {
  guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--state-file" else { fail("usage: --state-file <absolute path>") }
  let path = CommandLine.arguments[2]
  guard path.hasPrefix("/") else { fail("state file must be absolute") }
  return path
}
let statePath = validatedStatePath()

func readState() -> Bool {
  do {
    let data = try Data(contentsOf: URL(fileURLWithPath: statePath))
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    guard object?.count == 1, let paused = object?["paused"] as? Bool else { throw NSError(domain: "state", code: 1) }
    return !paused
  } catch let error as NSError where error.code == NSFileNoSuchFileError { return true }
  catch { fputs("lease pickup state unreadable; failing closed\n", stderr); return false }
}

func writeState(_ accepting: Bool) throws {
  let directory = (statePath as NSString).deletingLastPathComponent
  try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
  let temporary = "\(statePath).\(ProcessInfo.processInfo.processIdentifier).tmp"
  let data = try JSONSerialization.data(withJSONObject: ["paused": !accepting], options: [])
  try data.write(to: URL(fileURLWithPath: temporary), options: .atomic)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary)
  _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: statePath), withItemAt: URL(fileURLWithPath: temporary), backupItemName: nil, options: .usingNewMetadataOnly)
}

final class Delegate: NSObject, NSApplicationDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  let status = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  let action = NSMenuItem(title: "", action: #selector(toggle), keyEquivalent: "")
  var accepting = readState()
  var source: DispatchSourceFileSystemObject?
  var fd: Int32 = -1

  func applicationDidFinishLaunching(_ notification: Notification) {
    item.button?.setAccessibilityLabel("Mars Worker")
    let menu = NSMenu()
    status.isEnabled = false
    menu.addItem(status); menu.addItem(.separator()); action.target = self; menu.addItem(action)
    item.menu = menu; refresh()
    fd = open((statePath as NSString).fileSystemRepresentation, O_EVTONLY)
    if fd >= 0 {
      source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
      source?.setEventHandler { [weak self] in self?.reload() }
      source?.setCancelHandler { [weak self] in close(self?.fd ?? -1) }
      source?.resume()
    }
    DispatchQueue.global().async { while readLine() != nil {} ; DispatchQueue.main.async { NSApp.terminate(nil) } }
  }
  func reload() { accepting = readState(); refresh() }
  func refresh() { status.title = accepting ? "Accepting new leases" : "New leases paused"; action.title = accepting ? "Pause New Leases" : "Resume New Leases"; item.button?.toolTip = status.title }
  @objc func toggle() { do { try writeState(!accepting); accepting.toggle(); refresh() } catch { fputs("could not persist lease pickup state\n", stderr) } }
}

@main
struct Main {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = Delegate(); app.delegate = delegate
    app.run()
  }
}
