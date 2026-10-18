#pragma once
// Copy to provisioning.h only on a controlled provisioning workstation.
// These are required configuration placeholders, never working credentials.
constexpr char WIFI_SSID[] = "REQUIRED_WIFI_SSID";
constexpr char WIFI_PASSWORD[] = "REQUIRED_WIFI_PASSWORD";
constexpr char API_ORIGIN[] = "https://api.YOUR_DOMAIN";
constexpr char DEVICE_CODE[] = "REQUIRED_DEVICE_CODE";
constexpr char DEVICE_SECRET[] = "REQUIRED_UNIQUE_DEVICE_SECRET";
// PEM root CA for the actual API certificate chain. Never call setInsecure().
constexpr char API_ROOT_CA[] = "REQUIRED_ROOT_CA_PEM";
