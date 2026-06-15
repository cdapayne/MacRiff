const usb = require('usb');
const { spawn } = require('child_process');
const path = require('path');

const VID = 0x0e6f; // PDP
const PIDS = [0x024c, 0x0248]; // Riffmaster Dongle PIDs

const DEBUG = process.env.DEBUG === 'true' || process.argv.includes('--debug');
const NO_SPECIAL = process.argv.includes('--no-special');

// Device mapping configurations
const MAPPINGS = [
  { name: 'Green Fret',    byte: 4, bit: 0x10, keyCode: 0   }, // A
  { name: 'Red Fret',      byte: 4, bit: 0x20, keyCode: 1   }, // S
  { name: 'Yellow Fret',   byte: 4, bit: 0x80, keyCode: 38  }, // J (mapped to Y)
  { name: 'Blue Fret',     byte: 4, bit: 0x40, keyCode: 40  }, // K (mapped to X)
  { name: 'Orange Fret',   byte: 5, bit: 0x10, keyCode: 37  }, // L (mapped to LB)
  { name: 'Strum UP',      byte: 5, bit: 0x01, keyCode: 126 }, // Up Arrow
  { name: 'Strum DOWN',    byte: 5, bit: 0x02, keyCode: 125 }, // Down Arrow
  { name: 'D-pad Left',    byte: 5, bit: 0x04, keyCode: 123 }, // Left Arrow
  { name: 'D-pad Right',   byte: 5, bit: 0x08, keyCode: 124 }, // Right Arrow
  { name: 'Start/Options', byte: 4, bit: 0x04, keyCode: 36  }, // Enter
  { name: 'Select/Share',  byte: 4, bit: 0x08, keyCode: 53  }  // Escape
];

// Initialize button states
const lastState = {};
for (const mapping of MAPPINGS) {
    lastState[mapping.name] = false;
}

// Analog Whammy bar and Tilt state tracking
const WHAMMY_REST = 0x44; // resting position (~68)
const WHAMMY_DEADZONE = 12; // deadzone to prevent drift
let lastScrollTime = 0;
let lastTiltState = false;


// Spawn the C-based key injector helper
const injectorPath = path.join(__dirname, 'injector');
const spawnOptions = {
    stdio: ['pipe', 'ignore', 'ignore']
};

// If running as root (sudo/do shell script), drop privileges of the injector subprocess 
// to the graphical console user so that CGEventPost reaches the user's active GUI session.
if (process.getuid && process.getuid() === 0) {
    try {
        const { execSync } = require('child_process');
        const username = execSync("stat -f '%Su' /dev/console", { encoding: 'utf8' }).trim();
        if (username && username !== 'root') {
            const uid = parseInt(execSync(`id -u "${username}"`, { encoding: 'utf8' }).trim(), 10);
            const gid = parseInt(execSync(`id -g "${username}"`, { encoding: 'utf8' }).trim(), 10);
            if (!isNaN(uid) && !isNaN(gid)) {
                spawnOptions.uid = uid;
                spawnOptions.gid = gid;
                if (DEBUG) {
                    console.log(`[Init] Dropping injector privileges to GUI user "${username}" (UID: ${uid}, GID: ${gid}) to enable event injection.`);
                }
            }
        }
    } catch (err) {
        console.warn(`[Warning] Could not drop injector privileges to console user: ${err.message}`);
    }
}

const injector = spawn(injectorPath, [], spawnOptions);

injector.on('exit', (code) => {
    console.error(`[Injector] Keyboard helper exited with code ${code}`);
    process.exit(code || 1);
});

// Helper function to send virtual key events to the C helper
function sendKeyEvent(keyCode, isPressed) {
    if (DEBUG) {
        console.log(`[Virtual Event] Keycode ${keyCode} -> ${isPressed ? 'DOWN' : 'UP'}`);
    }
    if (injector.stdin && injector.stdin.writable) {
        injector.stdin.write(`K ${keyCode} ${isPressed ? 1 : 0}\n`);
    }
}

// Find device
console.log(`Searching for PDP Riffmaster Dongle (VID: 0x${VID.toString(16)}, PIDs: ${PIDS.map(p => '0x' + p.toString(16)).join(', ')})...`);
let device;
for (const pid of PIDS) {
    device = usb.findByIds(VID, pid);
    if (device) {
        console.log(`Found device with PID: 0x${pid.toString(16)}`);
        break;
    }
}

if (!device) {
    console.error(`\n[Error] PDP Riffmaster Dongle NOT found!`);
    console.log("Currently connected USB devices:");
    const list = usb.getDeviceList();
    list.forEach((dev) => {
        try {
            console.log(`- VID: 0x${dev.deviceDescriptor.idVendor.toString(16).padStart(4, '0')}, PID: 0x${dev.deviceDescriptor.idProduct.toString(16).padStart(4, '0')}`);
        } catch (e) {
            // ignore descriptors we can't read
        }
    });
    console.log("\nPlease ensure the wireless dongle is plugged in.");
    process.exit(1);
}

console.log("Device found! Opening connection...");
device.open();

let iface;
let endpoint;
let wasKernelDriverActive = false;

console.log("Setting active USB configuration 1...");
device.setConfiguration(1, (err) => {
    if (err) {
        console.error(`[Error] Failed to set active configuration: ${err.message}`);
        console.error("Please run the script with 'sudo' (e.g., sudo node bridge.js).");
        try { device.close(); } catch (e) {}
        process.exit(1);
    }

    try {
        iface = device.interface(0);
    } catch (ifaceErr) {
        console.error(`[Error] Failed to get interface 0: ${ifaceErr.message}`);
        console.error("Please ensure the script is run with 'sudo' (e.g., sudo node bridge.js).");
        try { device.close(); } catch (e) {}
        process.exit(1);
    }

    // Detach kernel driver if active (macOS support varies)
    try {
        if (typeof iface.isKernelDriverActive === 'function' && iface.isKernelDriverActive()) {
            console.log("Kernel driver is active. Attempting to detach...");
            iface.detachKernelDriver();
            wasKernelDriverActive = true;
            console.log("Kernel driver detached.");
        } else {
            console.log("No active kernel driver detected, or not supported on this platform.");
        }
    } catch (detachErr) {
        console.warn(`[Warning] Could not detach kernel driver: ${detachErr.message}`);
    }

    // Claim the interface
    console.log("Claiming interface 0...");
    try {
        iface.claim();
        console.log("Interface 0 claimed successfully.");
    } catch (claimErr) {
        console.error(`[Error] Failed to claim interface: ${claimErr.message}`);
        console.error("Please run the script with 'sudo' (e.g., sudo node bridge.js).");
        try { device.close(); } catch (e) {}
        process.exit(1);
    }

    // Locate primary Interrupt IN endpoint
    endpoint = iface.endpoints.find(
        ep => ep.direction === 'in' && ep.transferType === usb.usb.LIBUSB_TRANSFER_TYPE_INTERRUPT
    );

    if (!endpoint) {
        console.error("[Error] Interrupt IN Endpoint not found on Interface 0!");
        cleanupAndExit(1);
        return;
    }

    // Locate primary Interrupt OUT endpoint
    const outEndpoint = iface.endpoints.find(
        ep => ep.direction === 'out' && ep.transferType === usb.usb.LIBUSB_TRANSFER_TYPE_INTERRUPT
    );

    console.log(`Found Interrupt IN Endpoint at address 0x${endpoint.address.toString(16)} (Max Packet Size: ${endpoint.descriptor.wMaxPacketSize} bytes).`);
    
    let sequence = 0;
    function getNextSequence() {
        sequence = (sequence + 1) & 0xff;
        if (sequence === 0) sequence = 1;
        return sequence;
    }

    function sendGIPHandshake() {
        if (!outEndpoint) {
            console.warn("[Warning] Interrupt OUT Endpoint not found. Skipping handshake.");
            return;
        }

        if (DEBUG) {
            console.log("Sending GIP handshake sequence...");
        }

        const packets = [
            // 1. Identify Request (0x04, 0x20, seq, 0x00)
            () => Buffer.from([0x04, 0x20, getNextSequence(), 0x00]),
            // 2. Power On (0x05, 0x20, seq, 0x01, 0x00)
            () => Buffer.from([0x05, 0x20, getNextSequence(), 0x01, 0x00]),
            // 3. Enable LED (0x0a, 0x20, seq, 0x03, 0x00, 0x01, 0x14)
            () => Buffer.from([0x0a, 0x20, getNextSequence(), 0x03, 0x00, 0x01, 0x14]),
            // 4. Security Passed (0x06, 0x20, seq, 0x02, 0x01, 0x00)
            () => Buffer.from([0x06, 0x20, getNextSequence(), 0x02, 0x01, 0x00]),
            // 5. Rumble Init (0x09, 0x00, seq, 0x09, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0xeb)
            () => Buffer.from([0x09, 0x00, getNextSequence(), 0x09, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0xeb])
        ];

        let idx = 0;
        function sendNext() {
            if (idx >= packets.length) {
                if (DEBUG) {
                    console.log("GIP handshake sequence sent.");
                }
                return;
            }
            const pkt = packets[idx++];
            outEndpoint.transfer(pkt(), (writeErr) => {
                if (writeErr) {
                    console.warn(`[Warning] Handshake transfer failed (index: ${idx}): ${writeErr.message}`);
                } else if (DEBUG) {
                    console.log(`[Handshake Out] Sent: ${pkt().toString('hex')}`);
                }
                setTimeout(sendNext, 20);
            });
        }
        sendNext();
    }

    if (outEndpoint) {
        console.log(`Found Interrupt OUT Endpoint at address 0x${outEndpoint.address.toString(16)}.`);
        sendGIPHandshake();
    } else {
        console.warn("[Warning] Interrupt OUT Endpoint not found. GIP handshake skipped.");
    }

    console.log("Starting packet polling... Press Ctrl+C to exit.");

    // Start polling using the exact endpoint packet size
    endpoint.startPoll(1, endpoint.descriptor.wMaxPacketSize);

    let lastData = null;

    endpoint.on('data', (data) => {
        if (data.length < 4) {
            return;
        }

        const cmd = data[0];

        // GIP Announce (0x02): Device arrival / connection broadcast
        if (cmd === 0x02) {
            if (DEBUG) {
                console.log(`[Raw Announce Packet] length=${data.length} bytes: ${data.toString('hex')}`);
            }
            console.log("Device announcement received. Re-sending handshake sequence...");
            sendGIPHandshake();
            return;
        }

        // GIP Input (0x20): Standard gamepad input report
        if (cmd === 0x20) {
            if (DEBUG) {
                // If DEBUG is active, track and log ONLY the changed bytes to avoid console spamming
                if (!lastData || lastData.length !== data.length) {
                    lastData = Buffer.from(data);
                    console.log(`[Raw Input Packet] length=${data.length} bytes: ${data.toString('hex')}`);
                } else {
                    const changes = [];
                    for (let index = 0; index < data.length; index++) {
                        if (data[index] !== lastData[index]) {
                            changes.push(`Byte ${index}: 0x${lastData[index].toString(16).padStart(2, '0')} -> 0x${data[index].toString(16).padStart(2, '0')}`);
                            lastData[index] = data[index];
                        }
                    }
                    if (changes.length > 0) {
                        console.log(`[Input Changed] ${changes.join(', ')}`);
                    }
                }
            }

            if (data.length < 6) {
                return;
            }

            for (const mapping of MAPPINGS) {
                const isPressed = (data[mapping.byte] & mapping.bit) !== 0;
                const previousState = lastState[mapping.name];

                if (isPressed !== previousState) {
                    lastState[mapping.name] = isPressed;
                    console.log(`[Input State] ${mapping.name}: ${isPressed ? 'PRESSED' : 'RELEASED'}`);
                    sendKeyEvent(mapping.keyCode, isPressed);
                }
            }

            // Handle Whammy Bar (analog on Byte 7, mapping to Scroll Wheel events)
            if (!NO_SPECIAL && data.length > 7) {
                const whammyVal = data[7];
                const delta = whammyVal - WHAMMY_REST;
                if (Math.abs(delta) > WHAMMY_DEADZONE) {
                    const scrollSpeed = Math.round(delta / 16);
                    if (scrollSpeed !== 0) {
                        const now = Date.now();
                        // Throttle events to max 60Hz to avoid event queue saturation
                        if (now - lastScrollTime >= 16) {
                            lastScrollTime = now;
                            if (DEBUG) {
                                console.log(`[Virtual Event] Scroll Delta: ${scrollSpeed} (raw: 0x${whammyVal.toString(16)})`);
                            }
                            if (injector.stdin && injector.stdin.writable) {
                                injector.stdin.write(`S ${scrollSpeed}\n`);
                            }
                        }
                    }
                }
            }

            // Handle Tilt Sensor (analog on Byte 6, mapping to Spacebar for Star Power)
            if (!NO_SPECIAL && data.length > 6) {
                const tiltVal = data[6];
                const isTilted = tiltVal >= 0x70; // 112 in decimal
                if (isTilted !== lastTiltState) {
                    lastTiltState = isTilted;
                    console.log(`[Input State] Tilt Sensor: ${isTilted ? 'PRESSED' : 'RELEASED'} (raw value: 0x${tiltVal.toString(16)})`);
                    sendKeyEvent(49, isTilted); // Spacebar (49)
                }
            }
        } else if (DEBUG) {
            // Other GIP messages (e.g. status 0x03, auth 0x06, etc.)
            console.log(`[GIP Packet 0x${cmd.toString(16).padStart(2, '0')}] length=${data.length} bytes: ${data.toString('hex')}`);
        }
    });

    endpoint.on('error', (endpointErr) => {
        console.error(`[Endpoint Error] ${endpointErr.message}`);
    });
});

// Setup clean exit handler
let exiting = false;
function cleanupAndExit(exitCode = 0) {
    if (exiting) return;
    exiting = true;
    
    console.log("\n[Shutdown] Releasing USB interface and cleaning up...");
    
    if (endpoint) {
        try {
            endpoint.stopPoll(() => {
                performRelease();
            });
        } catch (e) {
            performRelease();
        }
    } else {
        performRelease();
    }

    function performRelease() {
        if (iface) {
            try {
                iface.release(true, (releaseErr) => {
                    if (releaseErr) {
                        console.error(`[Shutdown Error] Failed to release interface: ${releaseErr.message}`);
                    } else {
                        console.log("[Shutdown] Interface released.");
                    }

                    // Try to re-attach kernel driver if we detached it
                    if (wasKernelDriverActive) {
                        try {
                            iface.attachKernelDriver();
                            console.log("[Shutdown] Kernel driver re-attached.");
                        } catch (e) {
                            console.warn(`[Shutdown Warning] Could not re-attach kernel driver: ${e.message}`);
                        }
                    }

                    try {
                        device.close();
                        console.log("[Shutdown] USB connection closed.");
                    } catch (closeErr) {
                        console.error(`[Shutdown Error] Error closing device: ${closeErr.message}`);
                    }

                    // Terminate injector helper
                    injector.kill('SIGTERM');
                    process.exit(exitCode);
                });
            } catch (err) {
                console.error(`[Shutdown Error] Error during release: ${err.message}`);
                injector.kill('SIGTERM');
                process.exit(1);
            }
        } else {
            try {
                if (device) {
                    device.close();
                    console.log("[Shutdown] USB connection closed.");
                }
            } catch (closeErr) {}
            injector.kill('SIGTERM');
            process.exit(exitCode);
        }
    }
}

process.on('SIGINT', () => {
    cleanupAndExit(0);
});

process.on('SIGTERM', () => {
    cleanupAndExit(0);
});
