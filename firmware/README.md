# ESP32 + PN532 + DS3231 firmware example

This is an explicitly labelled Arduino/PlatformIO **prototype example**, not a field-certified production image. It implements UUID tap events, persisted monotonic sequences, UTC RTC timestamps, durable-before-green feedback, CRC queue recovery, TLS certificate verification, per-event DELETE acknowledgement, retained retries, heartbeat, sync-ack, capped backoff and jitter. No school/student ID is supplied by firmware.

Connect I2C SDA/SCL to board pins 21/22; PN532 IRQ 4/reset 5; LED green 26/red 27; buzzer 25. Confirm electrical requirements and pin conflicts for the actual board. Copy `include/provisioning.example.h` to ignored `include/provisioning.h`; inject the unit's unique credential and the real root CA. Build: `pio run -d firmware`; initialize the empty queue filesystem only on a new, unused device with `pio run -d firmware -t uploadfs` (this erases that partition; never run it on a device holding pending taps); flash: `pio run -d firmware -t upload`; monitor: `pio device monitor -d firmware`.

The queue partition is separate from both OTA application partitions. It refuses new events on storage failure/full capacity and never displays green until the queued record is flushed and renamed. Boot scans detect CRC failures and quarantine the damaged record. A sequence reserved before a power cut can produce a gap, which must be reported and investigated; it is never fabricated into a tap.

The example uses one file per event instead of production segment files. Production acceptance requires a measured 72-hour capacity, 500 random power cuts, queue cursor redundancy/CRC, flash wear evaluation, nonblocking FreeRTOS NFC/sync tasks, task watchdogs, and robust RTC drift/last-sync validation. A blocking upload in this prototype can pause card reading for up to the HTTP timeout. Do not deploy it at a busy school gate until these items pass.

## Production secure provisioning and OTA

Use ESP-IDF for the production firmware. Enable Secure Boot v2, flash encryption, encrypted NVS, signed A/B OTA, anti-rollback security versions, disabled debug interfaces, and a self-test/rollback deadline. Store Wi-Fi and per-device secret in encrypted NVS rather than compiled constants. Never place a Supabase key or provider credential on a device.

OTA metadata/status tables and `/device/ota/status` are implemented, but this prototype intentionally does not install remotely offered images. The API returns `ota.available=false`. Implement and validate signed image verification against the actual chip revision and production bootloader, then add a reviewed release offer endpoint. This external hardware/OTA gate is also listed in `docs/READINESS.md`.

Required rig cases: cut power during append/purge/upload; reboot with 200 queued events; corrupt record/cursor; fill partition; wrong RTC/OSF; blocked/unknown card; revoked credential; 24-hour outage; simultaneous five-reader upload; unsigned/tampered/downgraded/wrong-board OTA. Record evidence before enabling production updates.

Local compilation evidence: PlatformIO 6.1.18, espressif32 6.12.0, esp32dev, Arduino-ESP32 2.0.17; build passed. RAM 47,996 bytes; application flash 1,000,573 bytes. This does not validate physical NFC, power-loss behavior or secure OTA. On Windows, use a Python virtual environment in a path without spaces if PlatformIO post-install scripts fail on the Python executable path.
