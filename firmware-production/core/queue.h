#pragma once
#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace vidya {
constexpr uint32_t segment_bytes=16384,slot_bytes=128;
enum class TimeSource:uint8_t {rtc_synced=0,rtc_unsynced=1,ntp=2,monotonic=3};
#pragma pack(push,1)
struct Record {
 uint32_t magic=0x56455654;uint16_t format=1;uint8_t uid_length=0;TimeSource source=TimeSource::monotonic;
 uint64_t sequence=0;std::array<uint8_t,16> event_id{},boot_id{};std::array<uint8_t,10> uid{};
 uint16_t flags=0;uint64_t timestamp_ms=0,uptime_ms=0;uint32_t crc=0;std::array<uint8_t,48> reserved{};
};
struct SegmentHeader {uint32_t magic=0x56534547,format=1;uint64_t first_sequence=0;char firmware[80]{};uint32_t crc=0;uint8_t reserved[28]{};};
struct Cursor {uint64_t generation=0,acknowledged=0;uint32_t next_segment=0,crc=0;};
#pragma pack(pop)
static_assert(sizeof(Record)==128&&sizeof(SegmentHeader)==128,"Queue slots must match encrypted flash blocks");
struct Flash {
 virtual ~Flash()=default;virtual uint32_t size()const=0;
 virtual bool read(uint32_t,void*,uint32_t)=0;virtual bool read_raw(uint32_t,void*,uint32_t)=0;
 virtual bool write(uint32_t,const void*,uint32_t)=0;virtual bool erase(uint32_t,uint32_t)=0;
};
struct State {
 virtual ~State()=default;virtual bool load_cursor(unsigned,Cursor&)=0;virtual bool save_cursor(unsigned,const Cursor&)=0;
 virtual bool load_reserved(uint64_t&)=0;virtual bool save_reserved(uint64_t)=0;
};
struct Pending {Record event;std::string firmware;};
uint32_t crc32(const void*,size_t);
class Queue {
 struct Segment {uint32_t offset=0,used=0;uint64_t first=0,last=0;bool quarantined=false;std::string firmware;};
 Flash& flash;State& state;std::vector<Segment> segments;Cursor cursor{};uint64_t next=1,reserved=0;
 uint32_t pending_count=0,quarantine_count=0;bool healthy=false;
 bool persist_cursor();bool empty(uint32_t);bool allocate(uint64_t,const std::string&,Segment*&);
 public:
 Queue(Flash& f,State& s):flash(f),state(s){}
 bool begin();bool append(Record&,const std::string&);std::vector<Pending> peek(size_t max_events)const;
 bool acknowledge_prefix(const std::vector<Pending>&,const std::vector<std::array<uint8_t,16>>&);
 uint32_t pending()const{return pending_count;}uint32_t corruptions()const{return quarantine_count;}
 uint64_t purged()const{return cursor.acknowledged;}uint64_t last_sequence()const{return next-1;}
 uint32_t capacity()const{return flash.size()/segment_bytes*127;}
 uint32_t used_percent()const;bool ready()const{return healthy;}
};
}
