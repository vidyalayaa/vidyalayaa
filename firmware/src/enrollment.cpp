#include <Adafruit_PN532.h>
#include <Wire.h>
#include "usb_enrollment.h"

namespace {
Adafruit_PN532 nfc(4, 5, &Wire);
UsbEnrollment enrollment;
UsbLines<64> usb;
bool readerReady = false;
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  nfc.begin();
  readerReady = nfc.getFirmwareVersion() && nfc.SAMConfig() && nfc.setPassiveActivationRetries(1);
}

void loop() {
  usb.poll([](const char* line) { enrollment.command(line, true, readerReady); });
  if (enrollment.scanning()) {
    uint8_t uid[256]{}, size = 0;
    const bool present = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &size, 120);
    enrollment.sample(present, uid, size);
  }
  delay(5);
}
