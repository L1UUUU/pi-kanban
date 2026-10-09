// Synthetic Windows-only native launcher probes. Does not execute Pi, Node, Git Bash,
// project hooks, production code, real credentials, or public-network model requests.
#include "launcher.hpp"
#include "provision.hpp"
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <userenv.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <vector>
#pragma comment(lib, "ws2_32.lib")
using namespace pi_kanban;
namespace fs = std::filesystem;
namespace {
bool registry_read_policy=false,ordinary_appcontainer=false,all_network_validated=true;
std::wstring SelectedPolicy(){return ordinary_appcontainer?L"appcontainer-no-network-v3":registry_read_policy?L"lpac-registry-read-no-network-v2":L"lpac-strict-v1";}
void Require(bool value, const char* detail) { if (!value) throw std::runtime_error(std::string(detail) + ": " + std::to_string(GetLastError())); }
std::wstring Self() { std::vector<wchar_t> path(32768); DWORD n = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size())); Require(n > 0, "self path"); return {path.data(), n}; }
void Write(const fs::path& path, const std::string& text) { std::ofstream out(path, std::ios::binary); Require(!!out, "write fixture"); out << text; }
std::array<unsigned char, 32> Sha256(const fs::path& path) {
  std::ifstream input(path, std::ios::binary); std::vector<unsigned char> data((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; std::array<unsigned char, 32> out{};
  Require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0, "sha provider");
  Require(BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0, "sha hash");
  Require(BCryptHashData(hash, data.data(), static_cast<ULONG>(data.size()), 0) >= 0, "sha data");
  Require(BCryptFinishHash(hash, out.data(), static_cast<ULONG>(out.size()), 0) >= 0, "sha finish");
  BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); return out;
}
struct Profile {
  std::wstring name; PSID sid = nullptr;
  explicit Profile(std::wstring value) : name(std::move(value)) {
    Require(SUCCEEDED(CreateAppContainerProfile(name.c_str(), name.c_str(), L"Disposable pi-kanban synthetic CI probe", nullptr, 0, &sid)), "create disposable AppContainer");
  }
  ~Profile() { if (sid) FreeSid(sid); DeleteAppContainerProfile(name.c_str()); }
};
void Acl(const fs::path& path, PSID sid, DWORD rights, bool inherit = false) {
  // Replace only disposable test fixture DACL; keep owner/current-user and SYSTEM full access.
  HANDLE token = nullptr; Require(!!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token), "open owner token");
  DWORD size = 0; GetTokenInformation(token, TokenUser, nullptr, 0, &size); std::vector<unsigned char> user(size);
  Require(!!GetTokenInformation(token, TokenUser, user.data(), size, &size), "owner SID"); CloseHandle(token);
  BYTE system[SECURITY_MAX_SID_SIZE]{}; DWORD system_size = sizeof(system); Require(!!CreateWellKnownSid(WinLocalSystemSid, nullptr, system, &system_size), "system SID");
  EXPLICIT_ACCESSW entries[3]{};
  PSID sids[] = {reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, system, sid};
  const int count = sid ? 3 : 2;
  for (int i = 0; i < count; ++i) {
    entries[i].grfAccessPermissions = i == 2 ? rights : FILE_ALL_ACCESS;
    entries[i].grfAccessMode = SET_ACCESS; entries[i].grfInheritance = inherit ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
    entries[i].Trustee.TrusteeForm = TRUSTEE_IS_SID; entries[i].Trustee.TrusteeType = TRUSTEE_IS_USER; entries[i].Trustee.ptstrName = static_cast<LPWSTR>(sids[i]);
  }
  PACL acl = nullptr; Require(SetEntriesInAclW(static_cast<ULONG>(count), entries, nullptr, &acl) == ERROR_SUCCESS, "build test ACL");
  const DWORD result = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr);
  LocalFree(acl); Require(result == ERROR_SUCCESS, "apply test ACL");
}
std::vector<unsigned char> SidAces(const fs::path& path,PSID sid,BYTE type=255){
  PACL acl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
  Require(GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&acl,nullptr,&descriptor)==ERROR_SUCCESS,"read regression ACL");
  std::vector<unsigned char> result;
  if(acl)for(DWORD i=0;i<acl->AceCount;i++){LPVOID raw=nullptr;Require(!!GetAce(acl,i,&raw),"read regression ACE");const auto* header=static_cast<ACE_HEADER*>(raw);
    if((header->AceType==ACCESS_ALLOWED_ACE_TYPE||header->AceType==ACCESS_DENIED_ACE_TYPE)&&(type==255||header->AceType==type)&&EqualSid(const_cast<DWORD*>(&static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart),sid)){
      const auto* bytes=static_cast<unsigned char*>(raw);result.insert(result.end(),bytes,bytes+header->AceSize);}}
  if(descriptor)LocalFree(descriptor);return result;
}
void ScopedRevokeRegression(const fs::path& root){
  const auto base=root/L"revoke-regression",source=base/L"source",scratch=base/L"scratch",bin=base/L"bin";
  fs::create_directories(source/L".git");fs::create_directories(scratch);fs::create_directories(bin);
  Write(source/L".git"/L"object","synthetic protected fixture");fs::copy_file(Self(),bin/L"node.fixture");Write(bin/L"worker.fixture","synthetic worker");
  const auto generation=L"revoke-"+std::to_wstring(GetTickCount64());
  Profile unrelated(AppContainerProfileName(L"unrelated",L"review",generation));
  Acl(source/L".git",unrelated.sid,FILE_GENERIC_READ,true);
  const auto unrelated_before=SidAces(source/L".git",unrelated.sid);Require(!unrelated_before.empty(),"unrelated ACE fixture exists");
  LaunchDescriptor d;d.demand=L"revoke";d.role=L"implementation";d.generation=generation;d.profile_name=AppContainerProfileName(d.demand,d.role,generation);
  d.node_executable=(bin/L"node.fixture").wstring();d.worker_entry=(bin/L"worker.fixture").wstring();d.workspace=source.wstring();d.scratch=scratch.wstring();d.node_sha256=Sha256(d.node_executable);d.worker_sha256=Sha256(d.worker_entry);
  d.policy_evidence=L"synthetic-revoke-regression";d.acl_evidence=L"disposable-resources";d.private_channel_evidence=L"no-process-created";d.timeout_ms=10000;d.process_limit=4;d.memory_limit_bytes=128ull*1024*1024;d.output_limit_bytes=16384;
  ScopedResources scoped;Require(scoped.Provision(d,{d.node_executable,d.worker_entry},L"disposable-revoke-regression")==ERROR_SUCCESS,"provision revoke regression");
  PSID generated=nullptr;Require(SUCCEEDED(DeriveAppContainerSidFromAppContainerName(d.profile_name.c_str(),&generated)),"derive regression SID");
  Require(!SidAces(source/L".git",generated,ACCESS_DENIED_ACE_TYPE).empty(),"protected deny ACE must exist before revoke");
  Require(scoped.Revoke()==ERROR_SUCCESS,"all generated allow AND deny ACEs must revoke");
  for(const auto& path:{source,source/L".git",source/L".git"/L"object",scratch,bin/L"node.fixture",bin/L"worker.fixture"})Require(SidAces(path,generated).empty(),"generated SID absent after revoke");
  Require(SidAces(source/L".git",unrelated.sid)==unrelated_before,"unrelated ACE bytes/order preserved");FreeSid(generated);
  std::cout<<"{\"phase\":\"native-revoke-regression\",\"protectedDenyRemoved\":true,\"unrelatedAceBytesPreserved\":true}"<<std::endl;
}
bool CanRead(const fs::path& path, DWORD* error) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  *error = file == INVALID_HANDLE_VALUE ? GetLastError() : 0; if (file != INVALID_HANDLE_VALUE) CloseHandle(file); return file != INVALID_HANDLE_VALUE;
}
bool CanWrite(const fs::path& path, DWORD* error) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  *error = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  if (file == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0; const char marker[] = "SYNTHETIC-WRITE\n"; const bool ok = !!WriteFile(file, marker, sizeof(marker)-1, &written, nullptr); CloseHandle(file); return ok;
}
void Heartbeat(const fs::path& path) {
  for (;;) { HANDLE file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file != INVALID_HANDLE_VALUE) { DWORD written = 0; const char x[] = "tick\n"; WriteFile(file, x, sizeof(x)-1, &written, nullptr); CloseHandle(file); } Sleep(20); }
}
int ProbeChild() {
  // Control data only via the inherited private request handle; no shared host config path.
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE); std::vector<wchar_t> buffer(8192); DWORD bytes = 0;
  Require(!!ReadFile(input, buffer.data(), static_cast<DWORD>((buffer.size()-1)*sizeof(wchar_t)), &bytes, nullptr), "read private input");
  const std::wstring config(buffer.data(), bytes/sizeof(wchar_t)); std::wistringstream lines(config);
  std::wstring root_text, own_text, role, port_text, policy; std::getline(lines, root_text); std::getline(lines, own_text); std::getline(lines, role); std::getline(lines, port_text);std::getline(lines,policy);
  fs::path root(root_text), own(own_text); DWORD e_read = 0, e_write = 0, e_other = 0, e_db = 0, e_git = 0;
  const bool own_read = CanRead(own/L"source.txt", &e_read);
  const bool own_write = CanWrite(own/L"source.txt", &e_write);
  const bool other_read = CanRead(root/L"other"/L"private.txt", &e_other);
  const bool db_read = CanRead(root/L"host.sqlite", &e_db);
  const bool git_read = CanRead(root/L"shared-git"/L"object", &e_git);
  const auto registry_path=L"Software\\pi-kanban-native-probe\\"+root.filename().wstring();
  wchar_t registry_value[64]{};DWORD registry_bytes=sizeof(registry_value);const LSTATUS registry_status=RegGetValueW(HKEY_CURRENT_USER,registry_path.c_str(),L"private-marker",RRF_RT_REG_SZ,nullptr,registry_value,&registry_bytes);
  const bool registry_leak=registry_status==ERROR_SUCCESS;
  wchar_t leaked[64]{}; const bool env_leak = GetEnvironmentVariableW(L"FORBIDDEN_HOST_CREDENTIAL", leaked, 64) != 0;
  WSADATA sockets{}; const int wsa_startup_error = WSAStartup(MAKEWORD(2,2), &sockets); const bool sockets_ok = wsa_startup_error == 0;
  SOCKET socket_value = sockets_ok ? socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) : INVALID_SOCKET;
  sockaddr_in addr{}; addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); addr.sin_port = htons(static_cast<u_short>(std::stoi(port_text)));
  bool network=false,network_completed=false;int network_select_status=0,network_error=socket_value==INVALID_SOCKET?WSAGetLastError():0;
  if(socket_value!=INVALID_SOCKET){u_long nonblocking=1;
    if(ioctlsocket(socket_value,FIONBIO,&nonblocking)==SOCKET_ERROR)network_error=WSAGetLastError();
    else{
      const int result=connect(socket_value,reinterpret_cast<sockaddr*>(&addr),sizeof(addr));network_error=result==0?0:WSAGetLastError();
      if(result==0){network=true;network_completed=true;}
      else if(network_error!=WSAEWOULDBLOCK)network_completed=true;
      else{
        // WinSock reports failed nonblocking connects in exceptfds, NOT writefds.
        // Both readiness paths require a successful SO_ERROR query; timeout/API
        // failure remains inconclusive and cannot be counted as access denial.
        fd_set ready,failed;FD_ZERO(&ready);FD_ZERO(&failed);FD_SET(socket_value,&ready);FD_SET(socket_value,&failed);timeval timeout{1,0};
        network_select_status=select(0,nullptr,&ready,&failed,&timeout);
        if(network_select_status>0){int length=sizeof(network_error);if(getsockopt(socket_value,SOL_SOCKET,SO_ERROR,reinterpret_cast<char*>(&network_error),&length)==0){network_completed=true;network=network_error==0;}else network_error=WSAGetLastError();}
        else if(network_select_status==SOCKET_ERROR)network_error=WSAGetLastError();
      }
    }
    closesocket(socket_value);
  }
  if (sockets_ok) WSACleanup();
  std::wstring command = L"\"" + Self() + L"\" --descendant \"" + (root/L"scratch"/L"child-heartbeat.txt").wstring() + L"\"";
  STARTUPINFOW startup{}; startup.cb=sizeof(startup); PROCESS_INFORMATION spawned{};
  const bool spawned_child=!!CreateProcessW(Self().c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&spawned);
  const DWORD child_spawn_error=spawned_child?0:GetLastError();
  if(spawned_child){CloseHandle(spawned.hThread);CloseHandle(spawned.hProcess);}
  PROCESS_INFORMATION escape{};const bool escaped=!!CreateProcessW(Self().c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW|CREATE_BREAKAWAY_FROM_JOB,nullptr,nullptr,&startup,&escape);
  const DWORD breakaway_error=escaped?0:GetLastError();
  if(escaped){TerminateProcess(escape.hProcess,1);CloseHandle(escape.hThread);CloseHandle(escape.hProcess);}
  const bool expected=own_read&&(own_write==(role==L"implementation"))&&!other_read&&!db_read&&!git_read&&!env_leak&&!registry_leak&&(policy==L"strict"||(sockets_ok&&network_completed&&network_error==WSAEACCES))&&!network&&!escaped;
  std::ostringstream report;report<<"{\"phase\":\"native-child-probes\",\"role\":\""<<(role==L"implementation"?"implementation":"review")<<"\",\"ownRead\":"<<own_read<<",\"ownWrite\":"<<own_write
    <<",\"otherRead\":"<<other_read<<",\"hostDbRead\":"<<db_read<<",\"sharedGitRead\":"<<git_read<<",\"hostRegistryRead\":"<<registry_leak<<",\"hostRegistryStatus\":"<<registry_status<<",\"environmentLeak\":"<<env_leak<<",\"loopbackConnected\":"<<network
    <<",\"networkCompleted\":"<<network_completed<<",\"networkSelectStatus\":"<<network_select_status<<",\"networkError\":"<<network_error<<",\"policy\":\""<<(policy==L"registry-read"?"registry-read":policy==L"appcontainer"?"appcontainer":"strict")<<"\",\"networkDenialProven\":"<<(sockets_ok&&network_completed&&!network&&network_error==WSAEACCES)<<",\"wsaStartupError\":"<<wsa_startup_error<<",\"childSpawned\":"<<spawned_child<<",\"childSpawnError\":"<<child_spawn_error<<",\"breakawaySucceeded\":"<<escaped<<",\"breakawayError\":"<<breakaway_error<<",\"readError\":"<<e_read<<",\"writeError\":"<<e_write<<",\"crossReadError\":"<<e_other<<",\"passed\":"<<expected<<"}\n";
  const auto text=report.str();DWORD written=0;Require(!!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),text.data(),static_cast<DWORD>(text.size()),&written,nullptr),"private report");
  Heartbeat(root/L"scratch"/L"parent-heartbeat.txt"); return 0;
}
void RunRole(const fs::path& root,const std::wstring& role,SOCKET listener) {
  const auto generation=L"g"+std::to_wstring(GetTickCount64());Profile profile(AppContainerProfileName(L"A",role,generation));
  // Test root has no broad AppContainer grants; explicitly grant this identity only required resources.
  Acl(root,profile.sid,FILE_TRAVERSE|FILE_READ_ATTRIBUTES);
  for(const auto& folder:{root/L"bin",root/L"own",root/L"scratch"})fs::create_directories(folder);
  fs::copy_file(Self(),root/L"bin"/L"probe.exe",fs::copy_options::overwrite_existing);
  Write(root/L"bin"/L"entry.fixture","synthetic entry, not executable code");Write(root/L"own"/L"source.txt","allowed source");
  Acl(root/L"bin",profile.sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,true);
  Acl(root/L"bin"/L"probe.exe",profile.sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE);
  Acl(root/L"bin"/L"entry.fixture",profile.sid,FILE_GENERIC_READ);
  Acl(root/L"own",profile.sid,FILE_GENERIC_READ|(role==L"implementation"?FILE_GENERIC_WRITE:0),true);
  Acl(root/L"own"/L"source.txt",profile.sid,FILE_GENERIC_READ|(role==L"implementation"?FILE_GENERIC_WRITE:0));
  fs::remove(root/L"scratch"/L"parent-heartbeat.txt");fs::remove(root/L"scratch"/L"child-heartbeat.txt");fs::remove(root/L"scratch"/L"mediated-heartbeat.txt");
  Acl(root/L"scratch",profile.sid,FILE_ALL_ACCESS,true);
  SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};HANDLE in_read=nullptr,in_write=nullptr,out_read=nullptr,out_write=nullptr,log_read=nullptr,log_write=nullptr;
  Require(!!CreatePipe(&in_read,&in_write,&sa,0)&&!!CreatePipe(&out_read,&out_write,&sa,0)&&!!CreatePipe(&log_read,&log_write,&sa,0),"private pipes");
  SetHandleInformation(in_write,HANDLE_FLAG_INHERIT,0);SetHandleInformation(out_read,HANDLE_FLAG_INHERIT,0);SetHandleInformation(log_read,HANDLE_FLAG_INHERIT,0);
  sockaddr_in bound{};int bound_size=sizeof(bound);Require(getsockname(listener,reinterpret_cast<sockaddr*>(&bound),&bound_size)==0,"listener address");
  const auto command=root.wstring()+L"\n"+(root/L"own").wstring()+L"\n"+role+L"\n"+std::to_wstring(ntohs(bound.sin_port))+L"\n"+(ordinary_appcontainer?L"appcontainer":registry_read_policy?L"registry-read":L"strict")+L"\n";
  DWORD sent=0;Require(!!WriteFile(in_write,command.data(),static_cast<DWORD>(command.size()*sizeof(wchar_t)),&sent,nullptr),"private command");
  LaunchDescriptor d;d.policy_variant=SelectedPolicy();d.demand=L"A";d.role=role;d.generation=generation;d.profile_name=profile.name;
  d.node_executable=(root/L"bin"/L"probe.exe").wstring();d.worker_entry=(root/L"bin"/L"entry.fixture").wstring();d.workspace=(root/L"own").wstring();d.scratch=(root/L"scratch").wstring();
  d.node_sha256=Sha256(d.node_executable);d.worker_sha256=Sha256(d.worker_entry);
  d.policy_evidence=L"synthetic-ci-probe-not-G1";d.acl_evidence=L"this-test-provisioned-dacl";d.private_channel_evidence=L"candidate-under-test";
  d.timeout_ms=15000;d.process_limit=4;d.memory_limit_bytes=128ull*1024*1024;d.output_limit_bytes=16384;
  ControlledJob job;DWORD launch=job.Launch(d,{in_read,out_write,log_write});
  std::cout<<"{\"phase\":\"native-launch\",\"status\":"<<launch<<",\"stage\":\""<<job.LastStage()<<"\",\"pid\":"<<job.Identity().pid<<"}"<<std::endl;
  CloseHandle(in_read);CloseHandle(out_write);CloseHandle(log_write);
  Require(launch==ERROR_SUCCESS,"candidate launch failed (retain evidence; do not relax policy)");
  Require(job.PolicyAccessVerified()&&job.AllPackagesReadable()==ordinary_appcontainer,"trusted pre-resume policy differential must match exact candidate");
  std::cout<<"{\"phase\":\"native-policy-access\",\"exactSidReadable\":true,\"allApplicationPackagesReadable\":"<<job.AllPackagesReadable()<<",\"verifiedBeforeResume\":true}"<<std::endl;
  DWORD available=0;const ULONGLONG deadline=GetTickCount64()+7000;
  while(GetTickCount64()<deadline){if(PeekNamedPipe(out_read,nullptr,0,nullptr,&available,nullptr)&&available)break;Sleep(10);}
  Require(available>0&&available<16384,"bounded private report timeout");std::vector<char> report(available);DWORD received=0;
  Require(!!ReadFile(out_read,report.data(),available,&received,nullptr),"private report read");const std::string raw(report.data(),received);std::cout<<raw<<std::flush;
  all_network_validated=all_network_validated&&raw.find("\"networkDenialProven\":1")!=std::string::npos;
  Require(raw.find("\"passed\":1")!=std::string::npos,"one or more access probes failed");
  // Direct child creation remains recorded (including its failure). The supported command
  // path is native-mediated into the SAME SID and Job, never unrestricted Host execution.
  SECURITY_ATTRIBUTES tool_sa{sizeof(tool_sa),nullptr,TRUE};HANDLE tool_in=nullptr,tool_in_write=nullptr,tool_out=nullptr,tool_out_write=nullptr;
  Require(!!CreatePipe(&tool_in,&tool_in_write,&tool_sa,0)&&!!CreatePipe(&tool_out,&tool_out_write,&tool_sa,0),"mediated tool pipes");
  SetHandleInformation(tool_out,HANDLE_FLAG_INHERIT,0);CloseHandle(tool_in_write);PROCESS_INFORMATION tool{};
  const DWORD mediated=job.SpawnNodeCheck(d,{L"--descendant",(root/L"scratch"/L"mediated-heartbeat.txt").wstring()},tool_in,tool_out_write,&tool);
  std::cout<<"{\"phase\":\"native-mediated-tool\",\"status\":"<<mediated<<",\"pid\":"<<tool.dwProcessId<<",\"sameJobAndSidVerified\":"<<(mediated==0)<<"}"<<std::endl;
  Require(mediated==ERROR_SUCCESS,"pinned native-mediated command must run under the same SID and Job");
  CloseHandle(tool_in);CloseHandle(tool_out_write);CloseHandle(tool.hThread);CloseHandle(tool.hProcess);
  DWORD active=0;Require(job.ActiveProcesses(&active)==ERROR_SUCCESS&&active>=2,"actual mediated command membership");
  Sleep(120);const DWORD stopped=job.Stop();Require(stopped==ERROR_SUCCESS,"entire Job stop");
  const auto parent_size=fs::file_size(root/L"scratch"/L"parent-heartbeat.txt"),child_size=fs::file_size(root/L"scratch"/L"mediated-heartbeat.txt");
  Sleep(120);Require(fs::file_size(root/L"scratch"/L"parent-heartbeat.txt")==parent_size&&fs::file_size(root/L"scratch"/L"mediated-heartbeat.txt")==child_size,"writes quiescent after actual Job stop");
  Require(job.ActiveProcesses(&active)==ERROR_SUCCESS&&active==0,"Job active processes zero");
  std::cout<<"{\"phase\":\"native-stop\",\"status\":"<<stopped<<",\"activeProcesses\":"<<active<<",\"writesQuiescent\":true,\"fullG1\":false}"<<std::endl;
  CloseHandle(in_write);CloseHandle(out_read);CloseHandle(log_read);CloseHandle(tool_out);
}
} // namespace
int wmain(int argc,wchar_t** argv) {
  try{
    // This native executable substitutes for pinned Node in CTest only. Consume
    // the same fixed startup flags; actual Node/Pi compatibility is separate.
    if(argc>=3&&std::wstring(argv[1])==L"--preserve-symlinks"&&std::wstring(argv[2])==L"--preserve-symlinks-main"){argc-=2;argv+=2;}
    if(argc==3&&std::wstring(argv[1])==L"--descendant"){Heartbeat(argv[2]);return 0;}
    if(argc==4&&std::wstring(argv[2])==L"--controlled-run")return ProbeChild();
    if(argc==2&&std::wstring(argv[1])==L"--registry-read")registry_read_policy=true;
    if(argc==2&&std::wstring(argv[1])==L"--appcontainer")ordinary_appcontainer=true;
    Require(AppContainerProfileName(L"A",L"implementation",L"generation-1")==L"pi-kanban-a898bef33cf31470bdfb100d74db470c2cbf93aea19effb2","Host/native profile-name binding must match");
    const auto root=fs::temp_directory_path()/(L"pi-kanban-native-smoke-"+std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64()));
    fs::create_directories(root);Acl(root,nullptr,0);fs::create_directories(root/L"other");fs::create_directories(root/L"shared-git");
    Write(root/L"other"/L"private.txt","SYNTHETIC-OTHER-DEMAND");Write(root/L"shared-git"/L"object","SYNTHETIC-PRIVATE-OBJECT");Write(root/L"host.sqlite","SYNTHETIC-HOST-CONTROL");
    const auto registry_path=L"Software\\pi-kanban-native-probe\\"+root.filename().wstring();HKEY registry_key=nullptr;
    Require(RegCreateKeyExW(HKEY_CURRENT_USER,registry_path.c_str(),0,nullptr,REG_OPTION_VOLATILE,KEY_SET_VALUE,nullptr,&registry_key,nullptr)==ERROR_SUCCESS,"create synthetic private registry fixture");
    const wchar_t registry_marker[]=L"SYNTHETIC-HOST-SECRET";Require(RegSetValueExW(registry_key,L"private-marker",0,REG_SZ,reinterpret_cast<const BYTE*>(registry_marker),sizeof(registry_marker))==ERROR_SUCCESS,"write synthetic private registry marker");RegCloseKey(registry_key);
    SetEnvironmentVariableW(L"FORBIDDEN_HOST_CREDENTIAL",L"SYNTHETIC-NOT-A-REAL-SECRET");
    WSADATA sockets{};Require(WSAStartup(MAKEWORD(2,2),&sockets)==0,"listener sockets");SOCKET listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
    sockaddr_in bind_to{};bind_to.sin_family=AF_INET;bind_to.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    Require(bind(listener,reinterpret_cast<sockaddr*>(&bind_to),sizeof(bind_to))==0&&listen(listener,4)==0,"trusted loopback listener");
    RunRole(root,L"implementation",listener);RunRole(root,L"review",listener);ScopedRevokeRegression(root);
    closesocket(listener);WSACleanup();SetEnvironmentVariableW(L"FORBIDDEN_HOST_CREDENTIAL",nullptr);
    // Keep synthetic artifacts on failure; remove only this freshly generated root after success.
    Require(RegDeleteTreeW(HKEY_CURRENT_USER,registry_path.c_str())==ERROR_SUCCESS,"delete only own synthetic registry fixture");
    fs::remove_all(root);std::cout<<"{\"phase\":\"complete\",\"nativeSmokePassed\":true,\"policyVariant\":\""<<(ordinary_appcontainer?"appcontainer-no-network-v3":registry_read_policy?"lpac-registry-read-no-network-v2":"lpac-strict-v1")<<"\",\"networkPolicyValidated\":"<<all_network_validated<<",\"nodeGitBashPiCompatibility\":\"not-tested\",\"fullG1\":false}"<<std::endl;return 0;
  }catch(const std::exception& error){std::cerr<<"native smoke failed: "<<error.what()<<std::endl;return 1;}
}
#endif
