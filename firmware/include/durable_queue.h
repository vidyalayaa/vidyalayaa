#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <vector>
#include <algorithm>
struct QueueItem { String path; String eventId; String payload; uint64_t sequence; bool acknowledged; QueueItem(const String& p,const String& id,const String& body,uint64_t seq,bool ack=false):path(p),eventId(id),payload(body),sequence(seq),acknowledged(ack){} };
inline uint32_t crc32(const uint8_t* data,size_t size){uint32_t crc=0xffffffff;while(size--){crc^=*data++;for(int k=0;k<8;k++)crc=(crc>>1)^(0xedb88320u&-(int32_t)(crc&1));}return ~crc;}
class DurableQueue {
 Preferences state;
 public:
 std::vector<QueueItem> items; uint32_t corruptionCount=0; uint64_t purged=0;
 bool begin(){if(!LittleFS.begin(false))return false;state.begin("queue",false);purged=state.getULong64("purged",0);File root=LittleFS.open("/");File f=root.openNextFile();while(f){String path=String(f.name());if(!path.startsWith("/"))path="/"+path;if(path.endsWith(".evt")){uint32_t header[3];if(f.read((uint8_t*)header,sizeof(header))!=sizeof(header)||header[0]!=0x56494459||header[1]>2048||header[1]==0){corrupt(path);f=root.openNextFile();continue;}String payload;payload.reserve(header[1]);while(f.available())payload+=(char)f.read();if(payload.length()!=header[1]||crc32((const uint8_t*)payload.c_str(),payload.length())!=header[2]){corrupt(path);f=root.openNextFile();continue;}uint64_t sequence=strtoull(path.substring(1).c_str(),nullptr,10);items.push_back({path,"",payload,sequence,false});}f=root.openNextFile();}std::sort(items.begin(),items.end(),[](const QueueItem&a,const QueueItem&b){return a.sequence<b.sequence;});return true;}
 uint64_t reserveSequence(){uint64_t n=state.getULong64("next",1);if(state.putULong64("next",n+1)!=sizeof(uint64_t))return 0;return n;}
 bool append(uint64_t sequence,const String& id,const String& payload){if(LittleFS.totalBytes()-LittleFS.usedBytes()<8192)return false;char name[48];snprintf(name,sizeof(name),"/%020llu.evt",(unsigned long long)sequence);String tmp=String(name)+".tmp";File f=LittleFS.open(tmp,"w");if(!f)return false;uint32_t header[]={0x56494459,(uint32_t)payload.length(),crc32((const uint8_t*)payload.c_str(),payload.length())};bool ok=f.write((uint8_t*)header,sizeof(header))==sizeof(header)&&f.print(payload)==payload.length();f.flush();f.close();if(!ok||!LittleFS.rename(tmp,name))return false;items.push_back({String(name),id,payload,sequence,false});return true;}
 // A response is matched to a persisted event UUID, never to a batch number.
 bool purgeContiguous(){bool changed=false;while(!items.empty()&&items.front().acknowledged){const uint64_t n=items.front().sequence;if(!LittleFS.remove(items.front().path))break;if(state.putULong64("purged",n)!=sizeof(uint64_t))return changed;purged=n;items.erase(items.begin());changed=true;}return changed;}
 uint64_t lastSequence(){return state.getULong64("next",1)-1;}
 int usedPercent(){return LittleFS.totalBytes()?100ULL*LittleFS.usedBytes()/LittleFS.totalBytes():100;}
 private:void corrupt(const String&path){corruptionCount++;LittleFS.rename(path,path+".bad");}
};
