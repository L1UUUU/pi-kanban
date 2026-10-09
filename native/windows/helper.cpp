#include "launcher.hpp"
#include "json.hpp"
#include "provision.hpp"
#include "recovery.hpp"
#include "disk.hpp"
#ifdef _WIN32
#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
#include <atomic>
#include <algorithm>
#include <functional>
#include <memory>
using namespace pi_kanban;
namespace {
constexpr DWORD kMax=1024*1024;
std::mutex event_mutex;
std::function<void(DWORD)> shutdown_handler;
std::atomic<bool> shutdown_started=false;
[[noreturn]] void Shutdown(DWORD code){
  if(shutdown_started.exchange(true)){for(;;)Sleep(10);}
  // Cleanup is bounded even if an unexpected filesystem/API call never returns.
  std::thread([]{Sleep(20000);::ExitProcess(ERROR_TIMEOUT);}).detach();
  if(shutdown_handler)shutdown_handler(code);
  ::ExitProcess(code);
}
bool ReadExact(HANDLE handle,void* data,DWORD length){auto* cursor=static_cast<unsigned char*>(data);while(length){DWORD read=0;if(!ReadFile(handle,cursor,length,&read,nullptr)||!read)return false;cursor+=read;length-=read;}return true;}
bool WriteExact(HANDLE handle,const void* data,DWORD length){const auto* cursor=static_cast<const unsigned char*>(data);while(length){DWORD written=0;if(!WriteFile(handle,cursor,length,&written,nullptr)||!written)return false;cursor+=written;length-=written;}return true;}
bool ReadFrame(HANDLE handle,std::string& body){unsigned char size[4]{};if(!ReadExact(handle,size,4))return false;const DWORD n=(static_cast<DWORD>(size[0])<<24)|(static_cast<DWORD>(size[1])<<16)|(static_cast<DWORD>(size[2])<<8)|size[3];if(!n||n>kMax)throw std::runtime_error("frame exceeds bound");body.resize(n);if(!ReadExact(handle,body.data(),n))throw std::runtime_error("truncated frame");return true;}
bool Frame(HANDLE handle,const std::string& body){if(body.empty()||body.size()>kMax)return false;const DWORD n=static_cast<DWORD>(body.size());const unsigned char header[]={static_cast<unsigned char>(n>>24),static_cast<unsigned char>(n>>16),static_cast<unsigned char>(n>>8),static_cast<unsigned char>(n)};return WriteExact(handle,header,4)&&WriteExact(handle,body.data(),n);}
void Event(const std::string& body){bool sent=false;{std::lock_guard lock(event_mutex);sent=Frame(GetStdHandle(STD_ERROR_HANDLE),body);}if(!sent)Shutdown(ERROR_BROKEN_PIPE);}
std::string ResourceFailures(const ScopedResources& resources){std::string out="[";for(const auto& failure:resources.Failures()){if(out.size()>1)out+=",";out+="{\"phase\":\""+failure.phase+"\",\"path\":"+ToUtf8(JsonString(failure.path))+",\"status\":"+std::to_string(failure.status)+"}";}return out+"]";}
std::array<unsigned char,32> Hash(const Json& value){const auto text=value.str();if(text.size()!=64)throw std::runtime_error("SHA256 required");std::array<unsigned char,32> out{};for(size_t i=0;i<32;i++){unsigned v=0;for(size_t j=0;j<2;j++){const auto c=text[i*2+j];v*=16;if(c>=L'0'&&c<=L'9')v+=c-L'0';else if(c>=L'a'&&c<=L'f')v+=c-L'a'+10;else throw std::runtime_error("invalid SHA256");}out[i]=static_cast<unsigned char>(v);}return out;}
DWORD Dword(const Json& value){const uint64_t n=value.num();if(n>MAXDWORD)throw std::runtime_error("DWORD overflow");return static_cast<DWORD>(n);}
LaunchDescriptor Descriptor(const Json& input){
  const std::vector<std::wstring> names={L"type",L"version",L"policyVariant",L"demand",L"role",L"generation",L"profileName",L"nodeExecutable",L"workerEntry",L"workspace",L"scratch",L"nodeSha256",L"workerSha256",L"policyEvidence",L"aclEvidence",L"privateChannelEvidence",L"timeoutMs",L"processLimit",L"memoryLimitBytes",L"outputLimitBytes",L"resourceAuthorizationId",L"readonlyRuntimeRoots",L"recoveryReceiptPath",L"recoveryKey",L"recoveryContextSha256",L"diskLimitBytes",L"fileLimit",L"minimumFreeBytes",L"diskPollMs",L"shellExecutable",L"shellRootPath",L"shellSha256",L"shellFiles"};
  if(input.fields.size()!=names.size())throw std::runtime_error("unexpected launch fields");for(const auto& name:names)input.at(name);
  if(input.at(L"type").str()!=L"launch")throw std::runtime_error("launch first");
  LaunchDescriptor d;d.version=Dword(input.at(L"version"));d.policy_variant=input.at(L"policyVariant").str();d.demand=input.at(L"demand").str();d.role=input.at(L"role").str();d.generation=input.at(L"generation").str();d.profile_name=input.at(L"profileName").str();
  d.node_executable=input.at(L"nodeExecutable").str();d.worker_entry=input.at(L"workerEntry").str();d.workspace=input.at(L"workspace").str();d.scratch=input.at(L"scratch").str();d.node_sha256=Hash(input.at(L"nodeSha256"));d.worker_sha256=Hash(input.at(L"workerSha256"));
  d.policy_evidence=input.at(L"policyEvidence").str();d.acl_evidence=input.at(L"aclEvidence").str();d.private_channel_evidence=input.at(L"privateChannelEvidence").str();d.timeout_ms=Dword(input.at(L"timeoutMs"));d.process_limit=Dword(input.at(L"processLimit"));d.memory_limit_bytes=static_cast<SIZE_T>(input.at(L"memoryLimitBytes").num());d.output_limit_bytes=input.at(L"outputLimitBytes").num();d.disk_limit_bytes=input.at(L"diskLimitBytes").num();d.file_limit=Dword(input.at(L"fileLimit"));d.minimum_free_bytes=input.at(L"minimumFreeBytes").num();d.disk_poll_ms=Dword(input.at(L"diskPollMs"));d.shell_executable=input.at(L"shellExecutable").str();d.shell_root=input.at(L"shellRootPath").str();
  const auto& files=input.at(L"shellFiles");if(files.kind!=Json::Kind::array||files.items.size()>512)throw std::runtime_error("bounded shell files required");if(!d.shell_executable.empty())d.shell_sha256=Hash(input.at(L"shellSha256"));else if(!input.at(L"shellSha256").str().empty())throw std::runtime_error("disabled shell hash");for(const auto& file:files.items){if(file.fields.size()!=2)throw std::runtime_error("shell lock fields");d.shell_files.push_back({file.at(L"path").str(),Hash(file.at(L"sha256"))});}return d;
}
std::string Base64(const std::string& bytes){static constexpr char chars[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";std::string out;for(size_t i=0;i<bytes.size();i+=3){const uint32_t a=static_cast<unsigned char>(bytes[i]),b=i+1<bytes.size()?static_cast<unsigned char>(bytes[i+1]):0,c=i+2<bytes.size()?static_cast<unsigned char>(bytes[i+2]):0;const uint32_t n=(a<<16)|(b<<8)|c;out+=chars[(n>>18)&63];out+=chars[(n>>12)&63];out+=i+1<bytes.size()?chars[(n>>6)&63]:'=';out+=i+2<bytes.size()?chars[n&63]:'=';}return out;}
std::string ProcessListJson(const std::vector<DWORD>& ids){std::string out="[";for(const DWORD pid:ids){if(out.size()>1)out+=",";out+=std::to_string(pid);}return out+"]";}
void Check(ControlledJob& job,const LaunchDescriptor& d,const Json command,std::atomic<bool>& checking){
  try{
    const auto request_id=command.at(L"requestId").str();
    if(request_id.empty()||request_id.size()>200||std::any_of(request_id.begin(),request_id.end(),[](wchar_t c){return !((c>=L'a'&&c<=L'z')||(c>=L'A'&&c<=L'Z')||(c>=L'0'&&c<=L'9')||c==L'-');}))throw std::runtime_error("invalid check identity");
    const auto id=ToUtf8(JsonString(request_id));const auto& input_args=command.at(L"args");
    if(command.fields.size()!=5||input_args.kind!=Json::Kind::array||input_args.items.empty()||input_args.items.size()>64)throw std::runtime_error("invalid check arguments");
    const DWORD timeout=Dword(command.at(L"timeoutMs")),limit=Dword(command.at(L"maxOutputBytes"));if(!timeout||timeout>d.timeout_ms||timeout>120000||!limit||limit>524288)throw std::runtime_error("invalid check bounds");
    std::vector<std::wstring> args;for(const auto& item:input_args.items)args.push_back(item.str());
    SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};HANDLE in_read=nullptr,in_write=nullptr,out_read=nullptr,out_write=nullptr;
    if(!CreatePipe(&in_read,&in_write,&security,0)||!CreatePipe(&out_read,&out_write,&security,0))throw std::runtime_error("check pipes");
    SetHandleInformation(out_read,HANDLE_FLAG_INHERIT,0);CloseHandle(in_write);
    std::vector<DWORD> baseline;if(job.ProcessIds(baseline))throw std::runtime_error("Job census before check");
    PROCESS_INFORMATION process{};const bool shell=command.at(L"type").str()==L"run-shell";const DWORD launched=shell?job.SpawnShellCheck(d,args,in_read,out_write,&process):job.SpawnNodeCheck(d,args,in_read,out_write,&process);CloseHandle(in_read);CloseHandle(out_write);
    if(launched){CloseHandle(out_read);checking=false;Event("{\"type\":\"native.check-result\",\"requestId\":"+id+",\"generation\":\""+ToUtf8(d.generation)+"\",\"pid\":0,\"status\":"+std::to_string(launched)+",\"reason\":\"launch-failed\",\"exitCode\":null,\"outputBase64\":\"\",\"arguments\":"+ToUtf8(Serialize(input_args))+"}");return;}
    FILETIME birth{},exited{},kernel{},user{};
    if(!GetProcessTimes(process.hProcess,&birth,&exited,&kernel,&user))throw std::runtime_error("check process identity");
    const uint64_t creation=(static_cast<uint64_t>(birth.dwHighDateTime)<<32)|birth.dwLowDateTime;
    CloseHandle(process.hThread);std::atomic<bool> output_done=false,overflow=false;std::string output;DWORD output_read_status=ERROR_SUCCESS;
    std::thread reader([&]{char buffer[4096];DWORD received=0;for(;;){const BOOL read=ReadFile(out_read,buffer,sizeof(buffer),&received,nullptr);if(!read){output_read_status=GetLastError();break;}if(!received)break;if(output.size()+received>limit){overflow=true;job.Stop();break;}output.append(buffer,received);}output_done=true;});
    const DWORD waited=WaitForSingleObject(process.hProcess,timeout);std::string reason="exited";
    if(waited!=WAIT_OBJECT_0){reason="timeout";job.Stop();WaitForSingleObject(process.hProcess,5000);}
    DWORD exit_code=STILL_ACTIVE;const bool exit_confirmed=!!GetExitCodeProcess(process.hProcess,&exit_code)&&exit_code!=STILL_ACTIVE;CloseHandle(process.hProcess);
    if(!exit_confirmed){job.Stop();reason="descendants-survived";}
    std::vector<DWORD> after;const DWORD census_error=job.ProcessIds(after);
    if(census_error){reason="descendants-survived";job.Stop();}
    std::vector<DWORD> unexpected;for(const DWORD pid:after)if(pid!=process.dwProcessId&&std::find(baseline.begin(),baseline.end(),pid)==baseline.end())unexpected.push_back(pid);
    if(!unexpected.empty()){reason="descendants-survived";job.Stop();}
    const ULONGLONG drain_started=GetTickCount64();
    for(unsigned i=0;i<25&&!output_done;i++)Sleep(10);
    const bool drain_timed_out=!output_done;const ULONGLONG drain_wait_ms=GetTickCount64()-drain_started;
    if(drain_timed_out){reason="descendants-survived";job.Stop();}
    reader.join();CloseHandle(out_read);if(overflow)reason="output-limit";
    // Observation only: preserve the existing failure reasons and 25 x 10 ms
    // drain bound, but distinguish unexpected Job PIDs from reader completion.
    const std::string completion="{\"waitStatus\":"+std::to_string(waited)+",\"exitConfirmed\":"+(exit_confirmed?"true":"false")+",\"censusStatus\":"+std::to_string(census_error)+",\"baselinePids\":"+ProcessListJson(baseline)+",\"afterPids\":"+ProcessListJson(after)+",\"unexpectedPids\":"+ProcessListJson(unexpected)+",\"outputDrainTimedOut\":"+(drain_timed_out?"true":"false")+",\"outputDrainWaitMs\":"+std::to_string(drain_wait_ms)+",\"outputReadStatus\":"+std::to_string(output_read_status)+"}";
    // Release once before publishing. A second clear after Event could overwrite
    // the true value belonging to the next check queued on receipt delivery.
    checking=false;Event("{\"type\":\"native.check-result\",\"requestId\":"+id+",\"generation\":\""+ToUtf8(d.generation)+"\",\"pid\":"+std::to_string(process.dwProcessId)+",\"birth\":\""+std::to_string(creation)+"\",\"status\":"+std::to_string(census_error)+",\"reason\":\""+reason+"\",\"exitCode\":"+std::to_string(exit_code)+",\"outputBase64\":\""+Base64(output)+"\",\"arguments\":"+ToUtf8(Serialize(input_args))+",\"completion\":"+completion+"}");
  }catch(...){Shutdown(ERROR_INVALID_DATA);}
}
void Observation(ControlledJob& job,const std::string& generation){std::vector<DWORD> ids;const DWORD error=job.ProcessIds(ids);std::string list;for(DWORD pid:ids){if(!list.empty())list+=",";list+=std::to_string(pid);}Event("{\"type\":\"native.observation\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(error)+",\"activePids\":["+list+"]}");}
}
int wmain(){
  try{
    std::string first;if(!ReadFrame(GetStdHandle(STD_INPUT_HANDLE),first)||first.size()>262144)throw std::runtime_error("bounded descriptor required");
    const auto parsed=JsonParser(first).parse();const auto d=Descriptor(parsed);const auto generation=ToUtf8(d.generation);
    const auto& runtime_roots=parsed.at(L"readonlyRuntimeRoots");if(runtime_roots.kind!=Json::Kind::array)throw std::runtime_error("runtime roots array required");std::vector<std::wstring> roots;for(const auto& root:runtime_roots.items)roots.push_back(root.str());
    struct Lifetime{Json launch;ScopedResources resources;ControlledJob job;std::mutex disk_mutex;std::string disk_event;};
    const auto lifetime=std::make_shared<Lifetime>();lifetime->launch=parsed;
    auto& resources=lifetime->resources;auto& job=lifetime->job;
    shutdown_handler=[lifetime,generation](DWORD code){
      auto& controlled=lifetime->job;auto& scoped=lifetime->resources;
      const bool launched=controlled.Identity().pid!=0,never_created=!controlled.EverCreated();
      const DWORD stopped=launched?controlled.Stop():ERROR_SUCCESS;
      const DWORD cleanup=stopped?stopped:scoped.Revoke();
      std::vector<DWORD> ids;const DWORD census=launched?controlled.ProcessIds(ids):ERROR_INVALID_HANDLE;
      const DWORD receipt=!stopped&&!cleanup&&((launched&&!census&&ids.empty())||never_created)?WriteRecoveryReceipt(lifetime->launch,controlled.Identity(),code,never_created):ERROR_INVALID_DATA;
      std::string list;for(DWORD pid:ids){if(!list.empty())list+=",";list+=std::to_string(pid);}
      const auto failures=ResourceFailures(scoped);
      std::vector<std::string> messages={
        "{\"type\":\"native.finalizing\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(code)+"}",
        "{\"type\":\"native.resources\",\"phase\":\"revoke\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(cleanup)+",\"failures\":"+failures+"}",
        "{\"type\":\"native.recovery\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(receipt)+"}",
        "{\"type\":\"native.observation\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(census)+",\"activePids\":["+list+"]}"};
      {std::lock_guard lock(lifetime->disk_mutex);if(!lifetime->disk_event.empty())messages.insert(messages.begin(),lifetime->disk_event);}
      // Persisted proof precedes any potentially broken/full Host pipe. Best-effort
      // lifecycle delivery cannot deadlock cleanup or recursively call Event.
      HANDLE delivered=CreateEventW(nullptr,TRUE,FALSE,nullptr);
      if(delivered){std::thread([messages,delivered]{std::lock_guard lock(event_mutex);for(const auto& message:messages)if(!Frame(GetStdHandle(STD_ERROR_HANDLE),message))break;SetEvent(delivered);}).detach();if(WaitForSingleObject(delivered,250)==WAIT_OBJECT_0)CloseHandle(delivered);}
      ::ExitProcess(code?code:(stopped?stopped:cleanup));
    };
    const DWORD provision=resources.Provision(d,roots,parsed.at(L"resourceAuthorizationId").str());
    Event("{\"type\":\"native.resources\",\"phase\":\"provision\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(provision)+",\"failures\":"+ResourceFailures(resources)+"}");
    if(provision)Shutdown(provision);
    SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};HANDLE in_read=nullptr,in_write=nullptr,out_read=nullptr,out_write=nullptr,log_read=nullptr,log_write=nullptr;
    if(!CreatePipe(&in_read,&in_write,&sa,0)||!CreatePipe(&out_read,&out_write,&sa,0)||!CreatePipe(&log_read,&log_write,&sa,0))throw std::runtime_error("pipe creation failed");
    SetHandleInformation(in_write,HANDLE_FLAG_INHERIT,0);SetHandleInformation(out_read,HANDLE_FLAG_INHERIT,0);SetHandleInformation(log_read,HANDLE_FLAG_INHERIT,0);
    const auto measure_disk=[lifetime,d,generation]{std::lock_guard policy_lock(lifetime->job.PolicyProbeMutex());const auto observed=ObserveDisk(d);std::lock_guard lock(lifetime->disk_mutex);lifetime->disk_event="{\"type\":\"native.disk-observation\",\"generation\":\""+generation+"\",\"status\":"+std::to_string(observed.status)+",\"bytes\":"+std::to_string(observed.bytes)+",\"entries\":"+std::to_string(observed.entries)+",\"workspaceFreeBytes\":"+std::to_string(observed.workspace_free)+",\"scratchFreeBytes\":"+std::to_string(observed.scratch_free)+",\"freeSpaceObserved\":"+(observed.free_space_observed?"true":"false")+",\"diskLimitBytes\":"+std::to_string(d.disk_limit_bytes)+",\"fileLimit\":"+std::to_string(d.file_limit)+",\"minimumFreeBytes\":"+std::to_string(d.minimum_free_bytes)+",\"pollMs\":"+std::to_string(d.disk_poll_ms)+",\"hardQuota\":false}";return observed.status;};
    const DWORD initial_disk=measure_disk();if(initial_disk)Shutdown(initial_disk);
    const DWORD launch=job.Launch(d,{in_read,out_write,log_write});CloseHandle(in_read);CloseHandle(out_write);CloseHandle(log_write);
    if(launch){Event("{\"type\":\"native.launch-failed\",\"status\":"+std::to_string(launch)+",\"stage\":\""+job.LastStage()+"\"}");Shutdown(launch);}
    const auto& identity=job.Identity();const uint64_t birth=(static_cast<uint64_t>(identity.creation_time.dwHighDateTime)<<32)|identity.creation_time.dwLowDateTime;
    Event("{\"type\":\"native.started\",\"generation\":\""+generation+"\",\"pid\":"+std::to_string(identity.pid)+",\"birth\":\""+std::to_string(birth)+"\",\"policyVariant\":\""+ToUtf8(d.policy_variant)+"\",\"policyAccessVerified\":"+(job.PolicyAccessVerified()?"true":"false")+",\"allApplicationPackagesReadable\":"+(job.AllPackagesReadable()?"true":"false")+"}");
    std::atomic<bool> checking=false,worker_output_done=false,worker_log_done=false;
    std::thread([measure_disk,poll=d.disk_poll_ms]{for(;;){Sleep(poll);const DWORD status=measure_disk();if(status)Shutdown(status);}}).detach();
    std::mutex queue_mutex;std::condition_variable queue_ready;std::deque<std::string> queue;
    // All threads are bounded to this helper process. Process exit closes the only Job handle.
    std::thread([&]{for(;;){std::string body;{std::unique_lock lock(queue_mutex);queue_ready.wait(lock,[&]{return !queue.empty();});body=std::move(queue.front());queue.pop_front();}if(!Frame(in_write,body))Shutdown(ERROR_BROKEN_PIPE);}}).detach();
    std::thread([&]{try{uint64_t bytes=0;std::string body;while(ReadFrame(out_read,body)){bytes+=body.size();if(bytes>d.output_limit_bytes){Shutdown(ERROR_BUFFER_OVERFLOW);}JsonParser(body).parse();if(!Frame(GetStdHandle(STD_OUTPUT_HANDLE),body))Shutdown(ERROR_BROKEN_PIPE);}worker_output_done=true;}catch(...){Shutdown(ERROR_INVALID_DATA);}}).detach();
    std::thread([&]{uint64_t total=0;char bytes[4096];DWORD read=0;while(ReadFile(log_read,bytes,sizeof(bytes),&read,nullptr)&&read){total+=read;if(total>d.output_limit_bytes){Shutdown(ERROR_BUFFER_OVERFLOW);}Event("{\"type\":\"native.worker-log\",\"generation\":\""+generation+"\",\"bytesBase64\":\""+Base64(std::string(bytes,read))+"\"}");}worker_log_done=true;}).detach();
    std::thread([&]{for(;;){Sleep(25);DWORD active=0;if(!checking&&job.ActiveProcesses(&active)==ERROR_SUCCESS&&!active){for(unsigned n=0;n<100&&(!worker_output_done||!worker_log_done);n++)Sleep(10);if(!worker_output_done||!worker_log_done){Shutdown(ERROR_TIMEOUT);}Shutdown(0);}}}).detach();
    try { std::string body;while(ReadFrame(GetStdHandle(STD_INPUT_HANDLE),body)){
      const auto command=JsonParser(body).parse();const auto type=command.at(L"type").str();
      if(type==L"run-node"||type==L"run-shell"){if(checking.exchange(true))throw std::runtime_error("check already active");std::thread([&,command]{Check(job,d,command,checking);}).detach();continue;}
      if(type==L"stop"&&command.fields.size()==1)Shutdown(0);
      if(type==L"query"&&command.fields.size()==1){Observation(job,generation);continue;}
      if(type!=L"worker-input"||command.fields.size()!=2)throw std::runtime_error("unknown native control command");
      const auto payload=ToUtf8(Serialize(command.at(L"payload")));std::lock_guard lock(queue_mutex);if(queue.size()>=4)throw std::runtime_error("worker input backpressure");queue.push_back(payload);queue_ready.notify_one();
    }
    Shutdown(0);
    } catch (...) { Shutdown(ERROR_INVALID_DATA); }
  }catch(const std::exception&){Shutdown(ERROR_INVALID_DATA);}
}
#endif
