#include "reader.h"
#include "protocol.generated.h"
#include <algorithm>
#include <cstring>
#include <cstdio>
#include <ctime>
#include "esp_app_desc.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_ota_ops.h"
#include "esp_efuse.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif_sntp.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_system.h"
#include "mbedtls/sha256.h"
static std::atomic<bool> connected{false};
struct Reply {std::string body;uint32_t retry=0;};
static esp_err_t receive(esp_http_client_event_t* event){
 auto* r=static_cast<Reply*>(event->user_data);if(event->event_id==HTTP_EVENT_ON_DATA){if(r->body.size()+event->data_len>256*1024)return ESP_FAIL;r->body.append(static_cast<const char*>(event->data),event->data_len);}
 if(event->event_id==HTTP_EVENT_ON_HEADER&&strcasecmp(event->header_key,"Retry-After")==0)r->retry=std::min(3600,atoi(event->header_value))*1000;return ESP_OK;
}
static int request(const char* path,const char* body,Reply& reply){
 std::string url=provision.origin+path;esp_http_client_config_t config{};config.url=url.c_str();config.cert_pem=provision.ca.c_str();config.timeout_ms=8000;config.disable_auto_redirect=true;config.skip_cert_common_name_check=false;config.event_handler=receive;config.user_data=&reply;config.buffer_size=4096;
 auto client=esp_http_client_init(&config);if(!client)return -1;std::string authorization="Bearer "+provision.secret;
 esp_http_client_set_header(client,"Authorization",authorization.c_str());esp_http_client_set_header(client,"X-Device-Id",provision.code.c_str());
 if(body){esp_http_client_set_method(client,HTTP_METHOD_POST);esp_http_client_set_header(client,"Content-Type","application/json");esp_http_client_set_post_field(client,body,strlen(body));}
 esp_task_wdt_reset();auto error=esp_http_client_perform(client);int status=error==ESP_OK?esp_http_client_get_status_code(client):-1;esp_http_client_cleanup(client);esp_task_wdt_reset();return status;
}
static std::string text(cJSON* object,const char* key){auto* item=cJSON_GetObjectItemCaseSensitive(object,key);return cJSON_IsString(item)?item->valuestring:"";}
static int number(cJSON* object,const char* key,int fallback){auto* item=cJSON_GetObjectItemCaseSensitive(object,key);return cJSON_IsNumber(item)?item->valueint:fallback;}
static void string(cJSON* o,const char*k,const std::string& value){cJSON_AddStringToObject(o,k,value.c_str());}
static void numeric(cJSON*o,const char*k,uint64_t n){cJSON_AddNumberToObject(o,k,double(n));}
static void identity(cJSON* o){string(o,"device_id",provision.code);string(o,"boot_id",boot_id);}
static int post(const char* path,cJSON* object,Reply& reply){char* body=cJSON_PrintUnformatted(object);if(!body)return -1;auto status=request(path,body,reply);cJSON_free(body);return status;}
static void wifi_event(void*,esp_event_base_t base,int32_t id,void*){
 if(base==WIFI_EVENT&&id==WIFI_EVENT_STA_DISCONNECTED)connected=false;
 if(base==IP_EVENT&&id==IP_EVENT_STA_GOT_IP){connected=true;static bool started=false;if(!started){esp_sntp_config_t cfg=ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");cfg.sync_cb=[](timeval* at){ntp_epoch=at->tv_sec;};if(esp_netif_sntp_init(&cfg)==ESP_OK)started=true;}}
}
void start_wifi(){
 ESP_ERROR_CHECK(esp_netif_init());ESP_ERROR_CHECK(esp_event_loop_create_default());esp_netif_create_default_wifi_sta();wifi_init_config_t config=WIFI_INIT_CONFIG_DEFAULT();ESP_ERROR_CHECK(esp_wifi_init(&config));
 ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT,WIFI_EVENT_STA_DISCONNECTED,wifi_event,nullptr));ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,nullptr));
 wifi_config_t station{};memcpy(station.sta.ssid,provision.ssid.data(),provision.ssid.size());memcpy(station.sta.password,provision.password.data(),provision.password.size());station.sta.threshold.authmode=WIFI_AUTH_WPA2_PSK;station.sta.pmf_cfg.capable=true;
 ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&station));ESP_ERROR_CHECK(esp_wifi_start());esp_wifi_connect();
}
static bool fetch_config(){
 Reply reply;if(request("/api/v1/device/config",nullptr,reply)!=200){config_verified=false;return false;}auto* json=cJSON_Parse(reply.body.c_str());if(!json)return false;
 auto version=number(json,"config_version",0);if(version<=0){cJSON_Delete(json);return false;}
 heartbeat_seconds=std::clamp(number(json,"heartbeat_interval_s",60),30,300);debounce_ms=std::clamp(number(json,"tap_debounce_ms",1500),500,10000);batch_max=std::clamp(number(json,"batch_max_events",50),1,VIDYALAYAA_MAX_BATCH_EVENTS);
 auto* feedback=cJSON_GetObjectItemCaseSensitive(json,"feedback");auto* enabled=cJSON_GetObjectItemCaseSensitive(feedback,"buzzer");if(cJSON_IsBool(enabled))buzzer_enabled=cJSON_IsTrue(enabled);
 config_version=version;config_verified=true;cJSON_Delete(json);return true;
}
static int ota_status(const std::string& target,const char* state,const char* code=""){
 auto* json=cJSON_CreateObject();string(json,"device_id",provision.code);string(json,"target_version",target);string(json,"state",state);string(json,"reported_at",iso(clock_ms()));auto* detail=cJSON_AddObjectToObject(json,"detail");string(detail,"code",code);Reply reply;auto result=post("/api/v1/device/ota/status",json,reply);cJSON_Delete(json);return result;
}
struct Digest {mbedtls_sha256_context context;uint64_t bytes=0;};
static esp_err_t ota_receive(esp_http_client_event_t* e){auto* hash=static_cast<Digest*>(e->user_data);if(e->event_id==HTTP_EVENT_ON_DATA){hash->bytes+=e->data_len;return mbedtls_sha256_update(&hash->context,static_cast<unsigned char*>(e->data),e->data_len)==0?ESP_OK:ESP_FAIL;}return ESP_OK;}
static esp_err_t ota_auth(esp_http_client_handle_t h){std::string value="Bearer "+provision.secret;esp_http_client_set_header(h,"Authorization",value.c_str());esp_http_client_set_header(h,"X-Device-Id",provision.code.c_str());return ESP_OK;}
static void install_offer(cJSON* offer){
 if(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(offer,"available")))return;
 const auto version=text(offer,"version"),path=text(offer,"url"),sha=text(offer,"sha256"),hardware=text(offer,"hardware_model");
 if(version.empty()||version==esp_app_get_description()->version||hardware!=provision.hardware||path.rfind("/api/v1/device/ota/image/",0)!=0||path.find('?')!=std::string::npos||path.find("..")!=std::string::npos||sha.size()!=64)return;
 uint64_t size=number(offer,"size",0);auto* partition=esp_ota_get_next_update_partition(nullptr);if(!partition||size<1024||size>partition->size)return;
 ota_status(version,"OFFERED");std::string url=provision.origin+path;Digest hash;mbedtls_sha256_init(&hash.context);mbedtls_sha256_starts(&hash.context,0);
 esp_http_client_config_t http{};http.url=url.c_str();http.cert_pem=provision.ca.c_str();http.timeout_ms=8000;http.disable_auto_redirect=true;http.skip_cert_common_name_check=false;http.event_handler=ota_receive;http.user_data=&hash;http.buffer_size=4096;
 esp_https_ota_config_t config{};config.http_config=&http;config.http_client_init_cb=ota_auth;esp_https_ota_handle_t handle=nullptr;
 auto error=esp_https_ota_begin(&config,&handle);if(error!=ESP_OK){mbedtls_sha256_free(&hash.context);ota_status(version,"FAILED","DOWNLOAD_START");return;}
 esp_app_desc_t image{};error=esp_https_ota_get_img_desc(handle,&image);
 if(error!=ESP_OK||version!=image.version||image.secure_version<esp_app_get_description()->secure_version||!esp_efuse_check_secure_version(image.secure_version)){esp_https_ota_abort(handle);mbedtls_sha256_free(&hash.context);ota_status(version,"FAILED","VERSION_OR_ROLLBACK");return;}
 ota_status(version,"DOWNLOADING");do{esp_task_wdt_reset();error=esp_https_ota_perform(handle);vTaskDelay(pdMS_TO_TICKS(1));}while(error==ESP_ERR_HTTPS_OTA_IN_PROGRESS);
 unsigned char result[32];mbedtls_sha256_finish(&hash.context,result);mbedtls_sha256_free(&hash.context);char digest[65];for(int n=0;n<32;n++)snprintf(digest+n*2,3,"%02x",result[n]);
 if(error!=ESP_OK||!esp_https_ota_is_complete_data_received(handle)||hash.bytes!=size||sha!=digest){esp_https_ota_abort(handle);ota_status(version,"FAILED","IMAGE_HASH_OR_SIZE");return;}
 ota_status(version,"VERIFYING");
 // Secure Boot V2 verifies the image signature; the bootloader enforces the burned trust root.
 nvs_handle_t state;if(nvs_open("ota",NVS_READWRITE,&state)!=ESP_OK){esp_https_ota_abort(handle);ota_status(version,"FAILED","OTA_STATE_STORAGE");return;}
 error=nvs_set_str(state,"pending",version.c_str());if(error==ESP_OK)error=nvs_commit(state);
 if(error!=ESP_OK){nvs_close(state);esp_https_ota_abort(handle);ota_status(version,"FAILED","OTA_STATE_STORAGE");return;}
 error=esp_https_ota_finish(handle);if(error!=ESP_OK){nvs_erase_key(state,"pending");nvs_commit(state);nvs_close(state);ota_status(version,"FAILED","SIGNED_IMAGE_VERIFICATION");return;}
 nvs_close(state);esp_restart();
}
static void report_previous_update(){
 nvs_handle_t state;if(nvs_open("ota",NVS_READWRITE,&state)!=ESP_OK)return;char target[81];size_t n=sizeof(target);
 if(nvs_get_str(state,"pending",target,&n)==ESP_OK){esp_ota_img_states_t status;esp_ota_get_state_partition(esp_ota_get_running_partition(),&status);if(strcmp(target,esp_app_get_description()->version)!=0){if(ota_status(target,"ROLLED_BACK","SELF_TEST_OR_BOOT_FAILURE")==204){nvs_erase_key(state,"pending");nvs_commit(state);}}else if(status==ESP_OTA_IMG_VALID){if(ota_status(target,"INSTALLED")==204){nvs_erase_key(state,"pending");nvs_commit(state);}}}
 nvs_close(state);
}
static void heartbeat(){
 auto* json=cJSON_CreateObject();identity(json);string(json,"device_time",iso(clock_ms()));numeric(json,"uptime_ms",esp_timer_get_time()/1000);string(json,"firmware_version",esp_app_get_description()->version);numeric(json,"config_version",config_version);
 {Lock lock(queue_mutex);numeric(json,"pending_events",durable->pending());auto first=durable->peek(1);if(first.empty())cJSON_AddNullToObject(json,"oldest_pending_sequence");else numeric(json,"oldest_pending_sequence",first[0].event.sequence);numeric(json,"last_sequence",durable->last_sequence());numeric(json,"storage_used_pct",durable->used_percent());}
 string(json,"reader_status",reader_ok?"OK":"FAIL");string(json,"rtc_status",rtc_drift?"DRIFT":rtc_ok?"OK":"LOST_POWER");if(last_sync)string(json,"last_ntp_sync",iso(uint64_t(last_sync)*1000));else cJSON_AddNullToObject(json,"last_ntp_sync");wifi_ap_record_t ap;if(esp_wifi_sta_get_ap_info(&ap)==ESP_OK)cJSON_AddNumberToObject(json,"wifi_rssi_dbm",ap.rssi);else cJSON_AddNullToObject(json,"wifi_rssi_dbm");string(json,"reset_reason",std::to_string(esp_reset_reason()));auto* logs=cJSON_AddArrayToObject(json,"logs");
 uint32_t corrupt;{Lock lock(queue_mutex);corrupt=durable->corruptions();}if(corrupt){auto* log=cJSON_CreateObject();string(log,"ts",iso(clock_ms()));string(log,"level","ERROR");string(log,"code","QUEUE_CORRUPTION");auto* detail=cJSON_AddObjectToObject(log,"detail");numeric(detail,"count",corrupt);cJSON_AddItemToArray(logs,log);}
 Reply reply;if(post("/api/v1/device/heartbeat",json,reply)==200){rtc_drift=false;auto* answer=cJSON_Parse(reply.body.c_str());if(answer){if(number(answer,"config_version",0)!=int(config_version))fetch_config();report_previous_update();install_offer(cJSON_GetObjectItemCaseSensitive(answer,"ota"));cJSON_Delete(answer);}}cJSON_Delete(json);
}
static void sync_ack(){
 auto* json=cJSON_CreateObject();identity(json);{Lock lock(queue_mutex);numeric(json,"purged_through_sequence",durable->purged());numeric(json,"pending_events",durable->pending());numeric(json,"queue_corruption_count",durable->corruptions());}Reply reply;post("/api/v1/device/sync-ack",json,reply);cJSON_Delete(json);
}
static uint32_t sync_batch(uint32_t& backoff){
 std::vector<vidya::Pending> batch;{Lock lock(queue_mutex);batch=durable->peek(batch_max);}if(batch.empty())return 2100;
 auto* json=cJSON_CreateObject();const auto id=uuid();string(json,"batch_id",id);string(json,"device_id",provision.code);string(json,"firmware_version",esp_app_get_description()->version);string(json,"sent_at",iso(clock_ms()));auto* events=cJSON_AddArrayToObject(json,"events");static const char* sources[]={"RTC_SYNCED","RTC_UNSYNCED","NTP","MONOTONIC"};
 for(const auto& entry:batch){const auto& e=entry.event;auto* event=cJSON_CreateObject();string(event,"event_id",uuid_string(e.event_id));string(event,"boot_id",uuid_string(e.boot_id));string(event,"device_id",provision.code);char card[21];for(unsigned i=0;i<e.uid_length;i++)snprintf(card+i*2,3,"%02X",e.uid[i]);string(event,"card_uid",card);string(event,"event_timestamp",iso(e.timestamp_ms));string(event,"time_source",sources[std::min(unsigned(e.source),3u)]);numeric(event,"sequence_number",e.sequence);numeric(event,"uptime_ms",e.uptime_ms);string(event,"firmware_version",entry.firmware);cJSON_AddItemToArray(events,event);}
 Reply reply;auto code=post("/api/v1/device/events/batch",json,reply);cJSON_Delete(json);
 if(code==200){auto* answer=cJSON_Parse(reply.body.c_str());if(answer&&text(answer,"batch_id")==id){std::vector<std::array<uint8_t,16>> accepted;auto* results=cJSON_GetObjectItemCaseSensitive(answer,"results");cJSON* item; cJSON_ArrayForEach(item,results){auto status=text(item,"status");if(text(item,"device_action")!="DELETE"||(status!="RECORDED"&&status!="DUPLICATE_EVENT"&&status!="REJECTED"))continue;auto event_id=text(item,"event_id");for(const auto& sent:batch)if(uuid_string(sent.event.event_id)==event_id)accepted.push_back(sent.event.event_id);}
  {Lock lock(queue_mutex);durable->acknowledge_prefix(batch,accepted);}cJSON_Delete(answer);sync_ack();backoff=2000;return 2100;}cJSON_Delete(answer);}
 if(code==401||code==403){config_verified=false;return 3600000;}if(code==413)batch_max=std::max(uint32_t(1),batch_max.load()/2);
 if(code==422)return 3600000;backoff=std::min(backoff*2,uint32_t(300000));return std::max(reply.retry,uint32_t(backoff*(75+esp_random()%51)/100));
}
void network_task(void*){
 esp_task_wdt_add(nullptr);uint64_t next_heartbeat=0,next_upload=0,next_wifi=0;uint32_t backoff=2000,wifi_backoff=2000;
 for(;;){esp_task_wdt_reset();auto now=uint64_t(esp_timer_get_time()/1000);
  if(!connected){config_verified=false;if(now>=next_wifi){esp_wifi_connect();next_wifi=now+wifi_backoff+esp_random()%1000;wifi_backoff=std::min(wifi_backoff*2,uint32_t(60000));}}
  else if(time(nullptr)>1700000000){wifi_backoff=2000;if(now>=next_heartbeat){fetch_config();heartbeat();next_heartbeat=esp_timer_get_time()/1000+heartbeat_seconds*1000;}if(now>=next_upload){auto delay=sync_batch(backoff);next_upload=esp_timer_get_time()/1000+delay;}}
  vTaskDelay(pdMS_TO_TICKS(50));
 }
}
