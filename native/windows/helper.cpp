#include "launcher.hpp"
#include "json.hpp"
#include "provision.hpp"
#ifdef _WIN32
#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
using namespace pi_kanban;
namespace {
constexpr DWORD kMax=1024*1024;
std::mutex event_mutex;
bool ReadExact(HANDLE handle,void* data,DWORD length){auto* cursor=static_cast<unsigned char*>(data);while(length){DWORD read=0;if(!ReadFile(handle,cursor,length,&read,nullptr)||!read)return false;cursor+=read;length-=read;}return true;}
bool WriteExact(HANDLE handle,const void* data,DWORD length){const auto* cursor=static_cast<const unsigned char*>(data);while(length){DWORD written=0;if(!WriteFile(handle,cursor,length,&written,nullptr)||!written)return false;cursor+=written;length-=written;}return true;}
bool ReadFrame(HANDLE handle,std::string& body){unsigned char size[4]{};if(!ReadExact(handle,size,4))return false;const DWORD n=(static_cast<DWORD>(size[0])<<24)|(static_cast<DWORD>(size[1])<<16)|(static_cast<DWORD>(size[2])<<8)|size[3];if(!n||n>kMax)throw std::runtime_error("frame exceeds bound");body.resize(n);if(!ReadExact(handle,body.data(),n))throw std::runtime_error("truncated frame");return true;}
bool Frame(HANDLE handle,const std::string& body){if(body.empty()||body.size()>kMax)return false;const DWORD n=static_cast<DWORD>(body.size());const unsigned char header[]={static_cast<unsigned char>(n>>24),static_cast<unsigned char>(n>>16),static_cast<unsigned char>(n>>8),static_cast<unsigned char>(n)};return WriteExact(handle,header,4)&&WriteExact(handle,body.data(),n);}
void Event(const std::string& body){std::lock_guard lock(event_mutex);if(!Frame(GetStdHandle(STD_ERROR_HANDLE),body))ExitProcess(ERROR_BROKEN_PIPE);}
std::array<unsigned char,32> Hash(const Json& value){const auto text=value.str();if(text.size()!=64)throw std::runtime_error("SHA256 required");std::array<unsigned char,32> out{};for(size_t i=0;i<32;i++){unsigned v=0;for(size_t j=0;j<2;j++){const auto c=text[i*2+j];v*=16;if(c>=L'0'&&c<=L'9')v+=c-L'0';else if(c>=L'a'&&c<=L'f')v+=c-L'a'+10;else throw std::runtime_error("invalid SHA256");}out[i]=static_cast<unsigned char>(v);}return out;}
DWORD Dword(const Json& value){const uint64_t n=value.num();if(n>MAXDWORD)throw std::runtime_error("DWORD overflow");return static_cast<DWORD>(n);}
LaunchDescriptor Descriptor(const Json& input){
  const std::vector<std::wstring> names={L"type",L"version",L"demand",L"role",L"generation",L"profileName",L"nodeExecutable",L"workerEntry",L"workspace",L"scratch",L"nodeSha256",L"workerSha256",L"policyEvidence",L"aclEvidence",L"privateChannelEvidence",L"timeoutMs",L"processLimit",L"memoryLimitBytes",L"outputLimitBytes",L"resourceAuthorizationId",L"readonlyRuntimeRoots"};
  if(input.fields.size()!=names.size())throw std::runtime_error("unexpected launch fields");for(const auto& name:names)input.at(name);
  if(input.at(L"type").str()!=L"launch")throw std::runtime_error("launch first");
  LaunchDescriptor d;d.version=Dword(input.at(L"version"));d.demand=input.at(L"demand").str();d.role=input.at(L"role").str();d.generation=input.at(L"generation").str();d.profile_name=input.at(L"profileName").str();
  d.node_executable=input.at(L"nodeExecutable").str();d.worker_entry=input.at(L"workerEntry").str();d.workspace=input.at(L"workspace").str();d.scratch=input.at(L"scratch").str();d.node_sha256=Hash(input.at(L"nodeSha256"));d.worker_sha256=Hash(input.at(L"workerSha256"));
  d.policy_evidence=input.at(L"policyEvidence").str();d.acl_evidence=input.at(L"aclEvidence").str();d.private_channel_evidence=input.at(L"privateChannelEvidence").str();d.timeout_ms=Dword(input.at(L"timeoutMs"));d.process_limit=Dword(input.at(L"processLimit"));d.memory_limit_bytes=static_cast<SIZE_T>(input.at(L"memoryLimitBytes").num());d.output_limit_bytes=input.at(L"outputLimitBytes").num();return d;
}
void Observation(ControlledJob& job,const std::string& generation){std::vector<DWORD> ids;const DWORD error=job.ProcessIds(ids);std::string list;for(DWORD pid:ids){if(!list.empty())list+=",";list+=std::to_string(pid);}Event("{\"type\":\"native.observation\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(error)+",\"activePids\":["+list+"]}");}
}
int wmain(){
  try{
    std::string first;if(!ReadFrame(GetStdHandle(STD_INPUT_HANDLE),first)||first.size()>65536)throw std::runtime_error("bounded descriptor required");
    const auto parsed=JsonParser(first).parse();const auto d=Descriptor(parsed);const auto generation=ToUtf8(d.generation);
    const auto& runtime_roots=parsed.at(L"readonlyRuntimeRoots");if(runtime_roots.kind!=Json::Kind::array)throw std::runtime_error("runtime roots array required");std::vector<std::wstring> roots;for(const auto& root:runtime_roots.items)roots.push_back(root.str());
    ScopedResources resources;const DWORD provision=resources.Provision(d,roots,parsed.at(L"resourceAuthorizationId").str());
    Event("{\"type\":\"native.resources\",\"phase\":\"provision\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(provision)+"}");
    if(provision){resources.Revoke();return 2;}
    SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};HANDLE in_read=nullptr,in_write=nullptr,out_read=nullptr,out_write=nullptr,log_read=nullptr,log_write=nullptr;
    if(!CreatePipe(&in_read,&in_write,&sa,0)||!CreatePipe(&out_read,&out_write,&sa,0)||!CreatePipe(&log_read,&log_write,&sa,0))throw std::runtime_error("pipe creation failed");
    SetHandleInformation(in_write,HANDLE_FLAG_INHERIT,0);SetHandleInformation(out_read,HANDLE_FLAG_INHERIT,0);SetHandleInformation(log_read,HANDLE_FLAG_INHERIT,0);
    ControlledJob job;const DWORD launch=job.Launch(d,{in_read,out_write,log_write});CloseHandle(in_read);CloseHandle(out_write);CloseHandle(log_write);
    if(launch){resources.Revoke();Event("{\"type\":\"native.launch-failed\",\"status\":"+std::to_string(launch)+",\"stage\":\""+job.LastStage()+"\"}");return 2;}
    const auto& identity=job.Identity();const uint64_t birth=(static_cast<uint64_t>(identity.creation_time.dwHighDateTime)<<32)|identity.creation_time.dwLowDateTime;
    Event("{\"type\":\"native.started\",\"generation\":\""+generation+"\",\"pid\":"+std::to_string(identity.pid)+",\"birth\":\""+std::to_string(birth)+"\"}");
    std::mutex queue_mutex;std::condition_variable queue_ready;std::deque<std::string> queue;
    // All threads are bounded to this helper process. Process exit closes the only Job handle.
    std::thread([&]{for(;;){std::string body;{std::unique_lock lock(queue_mutex);queue_ready.wait(lock,[&]{return !queue.empty();});body=std::move(queue.front());queue.pop_front();}if(!Frame(in_write,body))ExitProcess(ERROR_BROKEN_PIPE);}}).detach();
    std::thread([&]{try{uint64_t bytes=0;std::string body;while(ReadFrame(out_read,body)){bytes+=body.size();if(bytes>d.output_limit_bytes){Event("{\"type\":\"native.limit\",\"reason\":\"output-limit\"}");job.Stop();ExitProcess(ERROR_BUFFER_OVERFLOW);}JsonParser(body).parse();if(!Frame(GetStdHandle(STD_OUTPUT_HANDLE),body))ExitProcess(ERROR_BROKEN_PIPE);}}catch(...){job.Stop();ExitProcess(ERROR_INVALID_DATA);}}).detach();
    std::thread([&]{uint64_t total=0;char bytes[4096];DWORD read=0;while(ReadFile(log_read,bytes,sizeof(bytes),&read,nullptr)&&read){total+=read;if(total>d.output_limit_bytes){Event("{\"type\":\"native.limit\",\"reason\":\"log-limit\"}");job.Stop();ExitProcess(ERROR_BUFFER_OVERFLOW);}}}).detach();
    std::thread([&]{for(;;){Sleep(25);DWORD active=0;if(job.ActiveProcesses(&active)==ERROR_SUCCESS&&!active){const DWORD cleanup=resources.Revoke();Event("{\"type\":\"native.resources\",\"phase\":\"revoke\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(cleanup)+"}");Observation(job,generation);ExitProcess(0);}}}).detach();
    try { std::string body;while(ReadFrame(GetStdHandle(STD_INPUT_HANDLE),body)){
      const auto command=JsonParser(body).parse();const auto type=command.at(L"type").str();
      if(type==L"stop"&&command.fields.size()==1){const DWORD stopped=job.Stop();if(!stopped){const DWORD cleanup=resources.Revoke();Event("{\"type\":\"native.resources\",\"phase\":\"revoke\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(cleanup)+"}");}Observation(job,generation);ExitProcess(stopped==0?0:3);}
      if(type==L"query"&&command.fields.size()==1){Observation(job,generation);continue;}
      if(type!=L"worker-input"||command.fields.size()!=2)throw std::runtime_error("unknown native control command");
      const auto payload=ToUtf8(Serialize(command.at(L"payload")));std::lock_guard lock(queue_mutex);if(queue.size()>=4)throw std::runtime_error("worker input backpressure");queue.push_back(payload);queue_ready.notify_one();
    }
    job.Stop();const DWORD cleanup=resources.Revoke();Event("{\"type\":\"native.resources\",\"phase\":\"revoke\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(cleanup)+"}");Observation(job,generation);ExitProcess(0);
    } catch (...) { job.Stop();Event("{\"type\":\"native.error\",\"reason\":\"invalid-control\"}");ExitProcess(ERROR_INVALID_DATA); }
  }catch(const std::exception&){Event("{\"type\":\"native.error\",\"reason\":\"invalid-launch-or-control\"}");return 1;}
}
#endif
