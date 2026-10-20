idf_component_register(SRCS "main.cpp" "hardware.cpp" "network.cpp" "../core/queue.cpp"
 INCLUDE_DIRS "." "../core" "../../firmware/include"
 REQUIRES esp_wifi esp_event esp_netif nvs_flash esp_http_client esp_https_ota app_update spi_flash esp_driver_i2c esp_driver_gpio esp_driver_ledc esp_timer esp_system json mbedtls efuse esp_partition bootloader_support esp_hw_support)
target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
