# Vidyalayaa ESP32 DevKit firmware

Version `1.1.0-devkit` targets the original **ESP32 DevKit / ESP32-WROOM-32 with 4 MB flash**. One image supports gate attendance and USB enrollment. An unconfigured board starts in USB mode. A configured board starts in gate mode unless you connect **GPIO32 to GND before resetting it**. In USB mode the device pauses attendance capture and Wi-Fi uploads. To resume gate operation, remove the jumper and reset.

## Upload and check a bare ESP32

From the repository root, run `pio run -d firmware -e esp32dev -t upload --upload-port COM9`, replacing COM9 if Windows assigns a different port. For a new board with a packaged `vidyalayaa-devkit-factory.bin`, run:

```powershell
py -m pip install esptool==4.9.0 pyserial==3.5
py -m esptool --chip esp32 --port COM9 write_flash 0x0 vidyalayaa-devkit-factory.bin
```

Use the factory image only when initializing a board. It writes bootloader, partition layout, OTA selection and application regions. Do not use it as a routine update for a reader with credentials or pending taps. For an existing compatible installation, back up and drain pending taps first and use the documented PlatformIO app upload. Never run `erase_flash` or `uploadfs` on a reader holding attendance events. The firmware initializes a blank queue partition and preserves a nonblank partition that fails to mount.

If the tool stays on **Connecting**, hold **BOOT**, tap **EN/RESET**, and release **BOOT** when it connects. Close Arduino Serial Monitor and the browser’s USB connection before upload. After upload, verify the version and diagnostics over USB:

```powershell
py firmware/provision.py --port COM9 --status
```

From the release bundle, use `py provision.py --port COM9 --status`. A fresh bare board should report `firmware=1.1.0-devkit`, `mode=enrollment`, `nfc=MISSING`, and `rtc=UNKNOWN`. No NFC module, clock, secret or school claim is required for that boot check.

## Connect the peripherals

| Peripheral | ESP32 pins |
| --- | --- |
| PN532 in I²C mode | SDA GPIO21, SCL GPIO22, IRQ GPIO4, reset GPIO5, and common GND |
| DS3231 with backup cell | SDA GPIO21, SCL GPIO22, and common GND |
| Optional indicators | Green LED GPIO26, red LED GPIO27, buzzer GPIO25 |
| USB enrollment mode | GPIO32 to GND before reset |

Use compatible module supply levels and 3.3 V logic on ESP32 signal pins. Confirm your module’s pin names and I²C mode settings before wiring. This firmware supports 4- or 7-byte Type A card UIDs.

## Provision a gate reader

The Super Admin first saves the reader API origin and its trusted root CA PEM in **Platform → Device inventory → Device provisioning**. School Admins then use **NFC devices → Set up over USB** for the claimed reader in desktop Chrome or Edge. Start the board in USB setup mode, connect it, enter the Wi-Fi name, password and current Device Secret, then select **Save to ESP32**. The website includes the approved API settings automatically. A PN532 and RTC are optional for this setup. After the ESP32 confirms saving, remove the GPIO32 jumper and reset to start gate mode. Repeat the USB setup to apply an updated certificate or Wi-Fi settings.

1. As Super Admin, register the unit. As School Admin, claim it into its attendance location with the device code and claim code.
2. Connect the ESP32 over USB and start it in USB enrollment mode. Have the **ESP32-reachable HTTPS API origin** and the corresponding trusted root CA PEM available. A browser URL or a laptop’s `127.0.0.1` address cannot serve as the reader’s API endpoint.
3. Run `py firmware/provision.py --port COM9 --api https://<api-host> --ca-file api-root-ca.pem`. Enter the **device code**, Wi-Fi details and **device secret** when prompted. The helper checks the claimed reader and TLS certificate before storing the configuration. The claim code stays in the School Admin workflow.
4. Remove the GPIO32 jumper and reset. Check `--status` and **NFC devices** for the firmware version, heartbeat, reader and clock. Verify a test tap in **Attendance → Movement history** and **Daily attendance**.

To rotate a device secret or update Wi-Fi, boot into USB mode again and rerun provisioning with the same device code. Credentials are stored in the ESP32’s NVS. The DevKit build does not enable flash encryption or secure boot. Use the separately validated secure hardware profile for a production installation that requires protection against physical flash extraction.

When upgrading from the prototype with credentials compiled into the sketch, enter the same device code and provision over USB after uploading. Retain its queue partition and drain pending taps before replacing a field reader image.

## Enroll student cards over USB

Fit the GPIO32 jumper and reset a provisioned reader, or use an unprovisioned unit over USB. Open **Attendance → NFC cards** in desktop Chrome or Edge on HTTPS or localhost. Under **Issue card to student**, connect the USB reader, choose a student or class, enter the printed serial and select **Arm reader**. Tap when prompted. The website stores the student, serial and chip UID. After the server confirms a class assignment, the next unissued student is selected.

The separate `enrollment` PlatformIO target remains available for a USB-only reader.

## Attendance behavior and verification

- Gate mode checks HTTPS certificates, reports heartbeat, and uploads in a background task so network latency does not block card reads.
- The queue reserves a persistent sequence and stores a CRC-checked file before the green feedback. Upload retries use the original event UUID. Only the acknowledged prefix is purged.
- The DS3231 uses UTC. NTP refreshes its last trusted sync. Missing or suspect time is sent with its trust source so the server can reconstruct or quarantine it.
- The local build and bare-board check are separate from school acceptance. Test PN532 card reads, DS3231 backup time, Wi-Fi loss and recovery, power cuts with queued taps, and the real attendance API before using it at a live school gate.
- The `firmware-production/` ESP-IDF profile is separate and covers secure-boot, encrypted storage and signed OTA work. The DevKit image uses USB updates.
