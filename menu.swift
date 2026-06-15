import AppKit
import Foundation
import ApplicationServices

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var statusMenuItem: NSMenuItem!
    var startMenuItem: NSMenuItem!
    var stopMenuItem: NSMenuItem!
    var disableWhammyTiltMenuItem: NSMenuItem!
    
    var nodePath: String = "node"
    var resourcePath: String = ""
    var bridgeScriptPath: String = ""
    let logPath = "/tmp/macriff.log"
    var disableWhammyTilt: Bool = false
    
    func applicationDidFinishLaunching(_ aNotification: Notification) {
        // Request Accessibility permissions with native macOS prompt on launch
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as CFString
        let options = [key: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        
        // Resolve bundle resource paths
        let bundle = Bundle.main
        resourcePath = bundle.resourcePath ?? "/Users/cdapayne/Documents/GitHub/MacRiff"
        bridgeScriptPath = "\(resourcePath)/bridge.js"
        
        // Find Node.js installation path
        nodePath = findNodePath()
        print("[MacRiffApp] Using Node path: \(nodePath)")
        print("[MacRiffApp] Using Resource path: \(resourcePath)")

        
        // Create system status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        
        if let button = statusItem.button {
            button.title = "🎸 MacRiff"
        }
        
        let menu = NSMenu()
        
        statusMenuItem = NSMenuItem(title: "Status: Stopped", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        
        menu.addItem(NSMenuItem.separator())
        
        startMenuItem = NSMenuItem(title: "Start Bridge", action: #selector(startBridge), keyEquivalent: "s")
        startMenuItem.target = self
        menu.addItem(startMenuItem)
        
        stopMenuItem = NSMenuItem(title: "Stop Bridge", action: #selector(stopBridge), keyEquivalent: "t")
        stopMenuItem.target = self
        stopMenuItem.isEnabled = false
        menu.addItem(stopMenuItem)
        
        menu.addItem(NSMenuItem.separator())
        
        disableWhammyTiltMenuItem = NSMenuItem(title: "Disable Whammy & Star Power", action: #selector(toggleDisableWhammyTilt), keyEquivalent: "")
        disableWhammyTiltMenuItem.target = self
        disableWhammyTiltMenuItem.state = .off
        menu.addItem(disableWhammyTiltMenuItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let viewLogsItem = NSMenuItem(title: "View Logs...", action: #selector(viewLogs), keyEquivalent: "l")
        viewLogsItem.target = self
        menu.addItem(viewLogsItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        
        statusItem.menu = menu
        
        // Poll status every 2 seconds
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            self.updateStatus()
        }
        
        // Initial status check
        updateStatus()
    }
    
    func findNodePath() -> String {
        // 1. Quick check common locations first (avoids slow login shell spin-up)
        let commonPaths = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        
        for path in commonPaths {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        
        // 2. Fallback to querying node using a login shell (captures NVM, FNM, etc.)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", "which node"]
        
        let pipe = Pipe()
        process.standardOutput = pipe
        
        do {
            try process.run()
            process.waitUntilExit()
            
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty, path.contains("/") {
                return path
            }
        } catch {}
        
        return "node" // final fallback
    }

    
    @objc func toggleDisableWhammyTilt() {
        disableWhammyTilt.toggle()
        disableWhammyTiltMenuItem.state = disableWhammyTilt ? .on : .off
        
        // If the bridge is currently running, restart it with the new arguments
        if checkBridgeRunning() {
            DispatchQueue.global(qos: .userInitiated).async {
                self.stopBridgeSync()
                Thread.sleep(forTimeInterval: 0.5)
                self.startBridgeSync()
            }
        }
    }

    @objc func startBridge() {
        // Run in background thread so password prompt doesn't freeze menu bar UI
        DispatchQueue.global(qos: .userInitiated).async {
            self.startBridgeSync()
        }
    }
    
    func startBridgeSync() {
        let extraArgs = self.disableWhammyTilt ? " --no-special" : ""
        let osascript = """
        do shell script "cd \\"\(self.resourcePath)\\" && \\"\(self.nodePath)\\" bridge.js\(extraArgs) > \\"\(self.logPath)\\" 2>&1 < /dev/null &" with administrator privileges
        """
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", osascript]
        
        do {
            try process.run()
            process.waitUntilExit()
            
            // Wait a moment for process to spin up and update status on the main thread
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                self.updateStatus()
            }
        } catch {
            print("Failed to run start bridge osascript: \(error)")
        }
    }
    
    @objc func stopBridge() {
        // Run in background thread to keep UI completely responsive
        DispatchQueue.global(qos: .userInitiated).async {
            self.stopBridgeSync()
        }
    }
    
    func stopBridgeSync() {
        let osascript = """
        do shell script "pkill -f bridge.js" with administrator privileges
        """
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", osascript]
        
        do {
            try process.run()
            process.waitUntilExit()
            
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.updateStatus()
            }
        } catch {
            print("Failed to run stop bridge osascript: \(error)")
        }
    }

    
    @objc func viewLogs() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [logPath]
        try? process.run()
    }
    
    @objc func quitApp() {
        // Automatically stop the bridge on app termination
        let osascript = """
        do shell script "pkill -f bridge.js" with administrator privileges
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", osascript]
        try? process.run()
        process.waitUntilExit()
        
        NSApplication.shared.terminate(self)
    }
    
    func updateStatus() {
        // Offload pgrep checking to a background thread to keep UI completely thread-safe
        DispatchQueue.global(qos: .background).async {
            let isRunning = self.checkBridgeRunning()
            DispatchQueue.main.async {
                self.updateUI(isRunning: isRunning)
            }
        }
    }
    
    func updateUI(isRunning: Bool) {
        if isRunning {
            statusMenuItem.title = "Status: Running"
            startMenuItem.isEnabled = false
            stopMenuItem.isEnabled = true
            if let button = statusItem.button {
                button.title = "🎸 MacRiff (Active)"
            }
        } else {
            statusMenuItem.title = "Status: Stopped"
            startMenuItem.isEnabled = true
            stopMenuItem.isEnabled = false
            if let button = statusItem.button {
                button.title = "🎸 MacRiff"
            }
        }
    }

    
    func checkBridgeRunning() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "pgrep -f bridge.js"]
        
        let pipe = Pipe()
        process.standardOutput = pipe
        
        do {
            try process.run()
            process.waitUntilExit()
            
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            if let output = String(data: data, encoding: .utf8), !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return true
            }
        } catch {
            return false
        }
        return false
    }
}

// Bootstrap Cocoa application
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // Hide App icon from the Dock and run as a status bar agent
app.run()
