#include "launcher.hpp"
#ifdef _WIN32
#include <bcrypt.h>
#include <sddl.h>
#include <userenv.h>
#include <algorithm>
#include <cwctype>
#include <memory>
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
namespace pi_kanban {
namespace {
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  HANDLE release() { HANDLE old = value; value = nullptr; return old; }
};
struct Sid {
  PSID value = nullptr;
  ~Sid() { if (value) FreeSid(value); }
};
struct RegistryReadCapability {
  PSID* groups=nullptr;PSID* capabilities=nullptr;DWORD group_count=0,capability_count=0;SID_AND_ATTRIBUTES entry{};
  DWORD Initialize(){if(!DeriveCapabilitySidsFromName(L"registryRead",&groups,&group_count,&capabilities,&capability_count))return GetLastError();if(capability_count!=1)return ERROR_INVALID_DATA;entry.Sid=capabilities[0];entry.Attributes=SE_GROUP_ENABLED;return ERROR_SUCCESS;}
  ~RegistryReadCapability(){if(groups){for(DWORD i=0;i<group_count;i++)LocalFree(groups[i]);LocalFree(groups);}if(capabilities){for(DWORD i=0;i<capability_count;i++)LocalFree(capabilities[i]);LocalFree(capabilities);}}
};
struct Attributes {
  std::vector<unsigned char> bytes;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
};
bool Identifier(const std::wstring& value) {
  return !value.empty() && value.size() <= 80 && std::all_of(value.begin(), value.end(), [](wchar_t c) {
    return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
           (c >= L'0' && c <= L'9') || c == L'-' || c == L'_';
  });
}
bool LocalAbsolute(const std::wstring& value) {
  // Deliberately excludes UNC, device paths, streams, and ambiguous trailing dots/spaces.
  if (value.size() < 4 || !iswalpha(value[0]) || value[1] != L':' || value[2] != L'\\' || value.size() >= 240) return false;
  for (size_t i = 2; i < value.size(); ++i) if (value[i] == L':' || value[i] == L'/' || value[i] < L' ') return false;
  size_t begin = 3;
  while (begin < value.size()) {
    const size_t end = value.find(L'\\', begin);
    const auto part = value.substr(begin, end == std::wstring::npos ? end : end - begin);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    if (end == std::wstring::npos) break;
    begin = end + 1;
  }
  return true;
}
DWORD PinNoReparse(const std::wstring& path, bool directory, std::vector<HANDLE>& pins, HANDLE* leaf) {
  // Keep each component open without WRITE/DELETE sharing until CreateProcess completes.
  // This closes the check-to-use rename/reparse replacement window for pinned components.
  for (size_t i = 3; i <= path.size(); ++i) {
    if (i != path.size() && path[i] != L'\\') continue;
    const auto part = path.substr(0, i);
    const bool final = i == path.size();
    HANDLE h = CreateFileW(part.c_str(), final && !directory ? GENERIC_READ : FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (h == INVALID_HANDLE_VALUE) return GetLastError();
    pins.push_back(h);
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &attributes, sizeof(attributes))) return GetLastError();
    if (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return ERROR_REPARSE_TAG_INVALID;
    if (final && directory != !!(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return ERROR_DIRECTORY;
    if (final) *leaf = h;
  }
  return ERROR_SUCCESS;
}
DWORD Digest(HANDLE file, const std::array<unsigned char, 32>& expected) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  NTSTATUS status = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (status < 0) return ERROR_INVALID_FUNCTION;
  status = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0);
  std::array<unsigned char, 65536> buffer{};
  DWORD bytes = 0, error = ERROR_SUCCESS;
  while (status >= 0) {
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &bytes, nullptr)) { error = GetLastError(); break; }
    if (!bytes) break;
    status = BCryptHashData(hash, buffer.data(), bytes, 0);
  }
  std::array<unsigned char, 32> actual{};
  if (status >= 0 && !error) status = BCryptFinishHash(hash, actual.data(), static_cast<ULONG>(actual.size()), 0);
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (error) return error;
  return status < 0 || actual != expected ? ERROR_INVALID_DATA : ERROR_SUCCESS;
}
std::wstring Quote(const std::wstring& input) {
  // Windows CommandLineToArgvW escaping, including trailing backslashes.
  std::wstring output = L"\""; size_t slashes = 0;
  for (wchar_t c : input) {
    if (c == L'\\') { ++slashes; continue; }
    output.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); slashes = 0; output.push_back(c);
  }
  output.append(slashes * 2, L'\\'); output.push_back(L'"'); return output;
}
}  // namespace
std::wstring AppContainerProfileName(const std::wstring& demand,const std::wstring& role,const std::wstring& generation) {
  if(!Identifier(demand)||!Identifier(role)||!Identifier(generation))return {};
  const std::wstring identity=demand+L"|"+role+L"|"+generation;
  std::vector<unsigned char> bytes;for(wchar_t c:identity)bytes.push_back(static_cast<unsigned char>(c));
  BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
  NTSTATUS status=BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0);if(status<0)return {};
  status=BCryptCreateHash(algorithm,&hash,nullptr,0,nullptr,0,0);
  if(status>=0)status=BCryptHashData(hash,bytes.data(),static_cast<ULONG>(bytes.size()),0);
  std::array<unsigned char,32> digest{};if(status>=0)status=BCryptFinishHash(hash,digest.data(),static_cast<ULONG>(digest.size()),0);
  if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);if(status<0)return {};
  const wchar_t hex[]=L"0123456789abcdef";std::wstring name=L"pi-kanban-";for(size_t i=0;i<24;i++){name+=hex[digest[i]>>4];name+=hex[digest[i]&15];}return name;
}
DWORD ValidateDescriptor(const LaunchDescriptor& d) {
  if(d.policy_variant!=L"lpac-strict-v1"&&d.policy_variant!=L"lpac-registry-read-no-network-v2"&&d.policy_variant!=L"appcontainer-no-network-v3")return ERROR_INVALID_PARAMETER;
  if (d.version != 1 || !Identifier(d.demand) || !Identifier(d.generation)) return ERROR_INVALID_PARAMETER;
  if (d.role != L"planning" && d.role != L"implementation" && d.role != L"review" && d.role != L"boundary-review" && d.role != L"check") return ERROR_INVALID_PARAMETER;
  if (d.profile_name.empty() || d.profile_name.size()>64 || d.profile_name != AppContainerProfileName(d.demand,d.role,d.generation)) return ERROR_INVALID_PARAMETER;
  for (const auto* path : {&d.node_executable, &d.worker_entry, &d.workspace, &d.scratch}) if (!LocalAbsolute(*path)) return ERROR_BAD_PATHNAME;
  if(d.shell_executable.empty()){if(!d.shell_root.empty()||!d.shell_files.empty())return ERROR_INVALID_PARAMETER;}else{
    if(!LocalAbsolute(d.shell_executable)||!LocalAbsolute(d.shell_root)||d.shell_files.empty()||d.shell_files.size()>512)return ERROR_INVALID_PARAMETER;
    bool executable_locked=false;for(const auto& file:d.shell_files){if(!LocalAbsolute(file.path))return ERROR_INVALID_PARAMETER;if(file.path==d.shell_executable&&file.sha256==d.shell_sha256)executable_locked=true;}if(!executable_locked)return ERROR_ACCESS_DENIED;
  }
  if (d.workspace == d.scratch || d.policy_evidence.empty() || d.acl_evidence.empty() || d.private_channel_evidence.empty()) return ERROR_ACCESS_DENIED;
  if (!d.timeout_ms || d.timeout_ms > 3600000 || !d.process_limit || d.process_limit > 64 || d.memory_limit_bytes < 64ull*1024*1024 || d.output_limit_bytes == 0) return ERROR_INVALID_PARAMETER;
  if(!d.disk_limit_bytes||d.disk_limit_bytes>64ull*1024*1024*1024||!d.file_limit||d.file_limit>1000000||d.minimum_free_bytes>1024ull*1024*1024*1024||d.disk_poll_ms<25||d.disk_poll_ms>2000)return ERROR_INVALID_PARAMETER;
  if (std::all_of(d.node_sha256.begin(), d.node_sha256.end(), [](unsigned char x) { return x == 0; }) ||
      std::all_of(d.worker_sha256.begin(), d.worker_sha256.end(), [](unsigned char x) { return x == 0; })) return ERROR_INVALID_DATA;
  return ERROR_SUCCESS;
}
ControlledJob::~ControlledJob() {
  watchdog_.request_stop();
  if (watchdog_.joinable()) watchdog_.join();
  // Job handle never inherited. Last trusted owner closure kills associated processes.
  if (job_) CloseHandle(job_);
  if (process_) CloseHandle(process_);
  for (HANDLE file : pinned_files_) CloseHandle(file);
}
DWORD ControlledJob::Launch(const LaunchDescriptor& d, const PrivateHandles& channels) {
  if (job_ || process_) return ERROR_ALREADY_EXISTS;
  stage_ = "validate-descriptor";
  DWORD error = ValidateDescriptor(d); if (error) return error;
  HANDLE node = nullptr, worker = nullptr, workspace = nullptr, scratch = nullptr;
  for (const auto& entry : {std::pair{d.node_executable, false}, std::pair{d.worker_entry, false}, std::pair{d.workspace, true}, std::pair{d.scratch, true}}) {
    HANDLE* target = entry.first == d.node_executable ? &node : entry.first == d.worker_entry ? &worker : entry.first == d.workspace ? &workspace : &scratch;
    stage_ = "pin-canonical-resources";
    error = PinNoReparse(entry.first, entry.second, pinned_files_, target); if (error) return error;
  }
  stage_ = "verify-binary-digests";
  if ((error = Digest(node, d.node_sha256)) || (error = Digest(worker, d.worker_sha256))) return error;
  for(const auto& file:d.shell_files){HANDLE dependency=nullptr;stage_="pin-shell-runtime";if((error=PinNoReparse(file.path,false,pinned_files_,&dependency))||(error=Digest(dependency,file.sha256)))return error;}
  HANDLE inherited[] = {channels.requests_read, channels.reports_write, channels.logs_write};
  if (inherited[0] == inherited[1] || inherited[0] == inherited[2] || inherited[1] == inherited[2]) return ERROR_INVALID_HANDLE;
  for (HANDLE h : inherited) {
    DWORD flags = 0;
    if (!h || h == INVALID_HANDLE_VALUE || GetFileType(h) != FILE_TYPE_PIPE || !GetHandleInformation(h, &flags) || !(flags & HANDLE_FLAG_INHERIT)) return ERROR_INVALID_HANDLE;
  }
  stage_ = "derive-appcontainer-sid";
  Sid sid;
  HRESULT hr = DeriveAppContainerSidFromAppContainerName(d.profile_name.c_str(), &sid.value);
  if (FAILED(hr)) return HRESULT_CODE(hr);
  RegistryReadCapability registry;error=registry.Initialize();if(error)return error;
  SECURITY_CAPABILITIES security{};
  security.AppContainerSid = sid.value;
  // Explicit LPAC policy v2: ordinary HKLM reads needed by Winsock initialization.
  // NO internetClient, internetClientServer or privateNetworkClientServer capability.
  security.CapabilityCount = d.policy_variant==L"lpac-registry-read-no-network-v2"?1:0; security.Capabilities = security.CapabilityCount?&registry.entry:nullptr;
  stage_ = "create-job";
  Handle job{CreateJobObjectW(nullptr, nullptr)}; if (!job.value) return GetLastError();
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
  // Deliberately NO BREAKAWAY_OK / SILENT_BREAKAWAY_OK.
  limits.BasicLimitInformation.ActiveProcessLimit = d.process_limit;
  limits.JobMemoryLimit = d.memory_limit_bytes;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return GetLastError();
  stage_ = "initialize-process-attributes";
  const bool lpac=d.policy_variant!=L"appcontainer-no-network-v3";const DWORD attribute_count=lpac?3:2;
  SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, attribute_count, 0, &size);
  if (!size) return GetLastError();
  Attributes attributes; attributes.bytes.resize(size);
  auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.bytes.data());
  if (!InitializeProcThreadAttributeList(list, attribute_count, 0, &size)) return GetLastError(); attributes.list = list;
  stage_ = "set-process-attributes";
  DWORD policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof(security), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) ||
      (lpac&&!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &policy, sizeof(policy), nullptr, nullptr))) return GetLastError();
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = channels.requests_read; startup.StartupInfo.hStdOutput = channels.reports_write; startup.StartupInfo.hStdError = channels.logs_write;
  std::wstring command = Quote(d.node_executable) + L" " + Quote(d.worker_entry) + L" --controlled-run " + Quote(d.generation);
  stage_ = "get-windows-directory";
  wchar_t windows[MAX_PATH]{}; if (!GetWindowsDirectoryW(windows, MAX_PATH)) return GetLastError();
  // Explicit minimal environment. No inherited PATH, HOME, auth keys, NODE_OPTIONS, proxy or control tokens.
  std::vector<std::wstring> environment = {L"APPDATA=" + d.scratch, L"LOCALAPPDATA=" + d.scratch, L"PI_OFFLINE=1", L"SystemDrive=" + std::wstring(windows, 2), L"SystemRoot=" + std::wstring(windows), L"TEMP=" + d.scratch, L"TMP=" + d.scratch, L"USERPROFILE=" + d.scratch};
  std::sort(environment.begin(), environment.end());
  std::vector<wchar_t> block;
  for (const auto& item : environment) { block.insert(block.end(), item.begin(), item.end()); block.push_back(L'\0'); } block.push_back(L'\0');
  stage_ = "create-suspended-process";
  PROCESS_INFORMATION created{};
  if (!CreateProcessW(d.node_executable.c_str(), command.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
    block.data(), d.workspace.c_str(), &startup.StartupInfo, &created)) return GetLastError();
  ever_created_=true;
  Handle process{created.hProcess}, thread{created.hThread};
  const auto fail = [&](DWORD failure) { TerminateProcess(process.value, failure); WaitForSingleObject(process.value, 5000); return failure; };
  stage_ = "assign-job";
  if (!AssignProcessToJobObject(job.value, process.value)) return fail(GetLastError());
  BOOL in_job = FALSE;
  if (!IsProcessInJob(process.value, job.value, &in_job) || !in_job) return fail(ERROR_ACCESS_DENIED);
  stage_ = "verify-appcontainer-token";
  Handle token;
  if (!OpenProcessToken(process.value, TOKEN_QUERY, &token.value)) return fail(GetLastError());
  DWORD actual_lpac=0,lpac_bytes=0;if(!GetTokenInformation(token.value,TokenIsLessPrivilegedAppContainer,&actual_lpac,sizeof(actual_lpac),&lpac_bytes)||!!actual_lpac!=lpac)return fail(ERROR_ACCESS_DENIED);
  DWORD is_container = 0, returned = 0;
  if (!GetTokenInformation(token.value, TokenIsAppContainer, &is_container, sizeof(is_container), &returned) || !is_container) return fail(ERROR_ACCESS_DENIED);
  DWORD token_size = 0; GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &token_size);
  std::vector<unsigned char> token_info(token_size);
  if (!token_size || !GetTokenInformation(token.value, TokenAppContainerSid, token_info.data(), token_size, &returned) ||
      !EqualSid(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(token_info.data())->TokenAppContainer, sid.value)) return fail(ERROR_ACCESS_DENIED);
  DWORD capability_bytes=0;GetTokenInformation(token.value,TokenCapabilities,nullptr,0,&capability_bytes);std::vector<unsigned char> capability_info(capability_bytes);
  if(!capability_bytes||!GetTokenInformation(token.value,TokenCapabilities,capability_info.data(),capability_bytes,&capability_bytes))return fail(ERROR_ACCESS_DENIED);
  const auto* actual_capabilities=reinterpret_cast<TOKEN_GROUPS*>(capability_info.data());if(actual_capabilities->GroupCount!=security.CapabilityCount||(security.CapabilityCount&&!EqualSid(actual_capabilities->Groups[0].Sid,registry.entry.Sid)))return fail(ERROR_ACCESS_DENIED);
  FILETIME exit{}, kernel{}, user{}, birth{};
  if (!GetProcessTimes(process.value, &birth, &exit, &kernel, &user)) return fail(GetLastError());
  // No untrusted instruction has run before containment and identity checks complete.
  stage_ = "resume-contained-process";
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return fail(GetLastError());
  stage_ = "running";
  identity_ = {created.dwProcessId, birth, d.generation};
  job_ = job.release(); process_ = process.release();
  watchdog_ = std::jthread([this, timeout = d.timeout_ms](std::stop_token stop) {
    const ULONGLONG deadline = GetTickCount64() + timeout;
    while (!stop.stop_requested() && GetTickCount64() < deadline) Sleep(10);
    if (!stop.stop_requested()) Stop(ERROR_TIMEOUT);
  });
  return ERROR_SUCCESS;
}
DWORD ControlledJob::SpawnNodeCheck(const LaunchDescriptor& d, const std::vector<std::wstring>& args, HANDLE input, HANDLE output, PROCESS_INFORMATION* result) {
  return SpawnPinnedCheck(d,d.node_executable,args,input,output,result,false);
}
DWORD ControlledJob::SpawnShellCheck(const LaunchDescriptor& d,const std::vector<std::wstring>& args,HANDLE input,HANDLE output,PROCESS_INFORMATION* result){
  if(d.shell_executable.empty()||args.size()!=4||args[0]!=L"--noprofile"||args[1]!=L"--norc"||args[2]!=L"-c")return ERROR_ACCESS_DENIED;
  return SpawnPinnedCheck(d,d.shell_executable,args,input,output,result,true);
}
DWORD ControlledJob::SpawnPinnedCheck(const LaunchDescriptor& d,const std::wstring& executable,const std::vector<std::wstring>& args,HANDLE input,HANDLE output,PROCESS_INFORMATION* result,bool shell) {
  std::lock_guard lock(spawn_stop_mutex_);
  if (stopping_) return ERROR_OPERATION_ABORTED;
  if (!job_ || !result || args.empty() || args.size() > 64 || d.generation != identity_.generation) return ERROR_INVALID_PARAMETER;
  DWORD error = ValidateDescriptor(d); if (error) return error;
  size_t total = 0; for (const auto& argument : args) { total += argument.size(); if (argument.size() > 8192 || argument.find(L'\0') != std::wstring::npos) return ERROR_INVALID_PARAMETER; }
  if (total > 32768) return ERROR_INVALID_PARAMETER;
  Sid sid; const HRESULT sid_result = DeriveAppContainerSidFromAppContainerName(d.profile_name.c_str(), &sid.value); if (FAILED(sid_result)) return HRESULT_CODE(sid_result);
  RegistryReadCapability registry;error=registry.Initialize();if(error)return error;
  SECURITY_CAPABILITIES security{}; security.AppContainerSid = sid.value;security.CapabilityCount=d.policy_variant==L"lpac-registry-read-no-network-v2"?1:0;security.Capabilities=security.CapabilityCount?&registry.entry:nullptr; // Same identity and explicit registry-only policy; no network capability.
  HANDLE handles[] = {input, output};
  for (HANDLE h : handles) { DWORD flags = 0; if (!GetHandleInformation(h, &flags) || !(flags & HANDLE_FLAG_INHERIT) || GetFileType(h) != FILE_TYPE_PIPE) return ERROR_INVALID_HANDLE; }
  const bool lpac=d.policy_variant!=L"appcontainer-no-network-v3";const DWORD attribute_count=lpac?3:2;
  SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, attribute_count, 0, &size); if (!size) return GetLastError();
  Attributes attributes; attributes.bytes.resize(size); auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.bytes.data());
  if (!InitializeProcThreadAttributeList(list, attribute_count, 0, &size)) return GetLastError(); attributes.list = list;
  DWORD policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof(security), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr) ||
      (lpac&&!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &policy, sizeof(policy), nullptr, nullptr))) return GetLastError();
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list; startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input; startup.StartupInfo.hStdOutput = output; startup.StartupInfo.hStdError = output;
  std::wstring command = Quote(executable); for (const auto& argument : args) command += L" " + Quote(argument);
  wchar_t windows[MAX_PATH]{}; if (!GetWindowsDirectoryW(windows, MAX_PATH)) return GetLastError();
  std::vector<std::wstring> environment = {L"APPDATA=" + d.scratch, L"LOCALAPPDATA=" + d.scratch, L"PI_OFFLINE=1", L"SystemDrive=" + std::wstring(windows, 2), L"SystemRoot=" + std::wstring(windows), L"TEMP=" + d.scratch, L"TMP=" + d.scratch, L"USERPROFILE=" + d.scratch};
  if(shell){environment.push_back(L"LANG=C");environment.push_back(L"LC_ALL=C");environment.push_back(L"HOME="+d.scratch);environment.push_back(L"PATH="+d.shell_root+L"\\usr\\bin;"+d.shell_root+L"\\mingw64\\bin");environment.push_back(L"GIT_CONFIG_NOSYSTEM=1");environment.push_back(L"GIT_CONFIG_GLOBAL=NUL");environment.push_back(L"GIT_TERMINAL_PROMPT=0");environment.push_back(L"GCM_INTERACTIVE=never");environment.push_back(L"MSYS2_ARG_CONV_EXCL=*");}
  std::sort(environment.begin(), environment.end()); std::vector<wchar_t> block;
  for (const auto& item : environment) { block.insert(block.end(), item.begin(), item.end()); block.push_back(L'\0'); } block.push_back(L'\0');
  PROCESS_INFORMATION created{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
      block.data(), d.workspace.c_str(), &startup.StartupInfo, &created)) return GetLastError();
  Handle process{created.hProcess}, thread{created.hThread};
  const auto fail = [&](DWORD failure) { TerminateProcess(process.value, failure); WaitForSingleObject(process.value, 5000); return failure; };
  if (!AssignProcessToJobObject(job_, process.value)) return fail(GetLastError());
  BOOL in_job = FALSE; if (!IsProcessInJob(process.value, job_, &in_job) || !in_job) return fail(ERROR_ACCESS_DENIED);
  Handle token; if (!OpenProcessToken(process.value, TOKEN_QUERY, &token.value)) return fail(GetLastError());
  DWORD actual_lpac=0,lpac_bytes=0;if(!GetTokenInformation(token.value,TokenIsLessPrivilegedAppContainer,&actual_lpac,sizeof(actual_lpac),&lpac_bytes)||!!actual_lpac!=lpac)return fail(ERROR_ACCESS_DENIED);
  DWORD bytes = 0; GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &bytes); std::vector<unsigned char> data(bytes);
  if (!bytes || !GetTokenInformation(token.value, TokenAppContainerSid, data.data(), bytes, &bytes) || !EqualSid(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(data.data())->TokenAppContainer, sid.value)) return fail(ERROR_ACCESS_DENIED);
  DWORD capability_bytes=0;GetTokenInformation(token.value,TokenCapabilities,nullptr,0,&capability_bytes);std::vector<unsigned char> capability_info(capability_bytes);
  if(!capability_bytes||!GetTokenInformation(token.value,TokenCapabilities,capability_info.data(),capability_bytes,&capability_bytes))return fail(ERROR_ACCESS_DENIED);
  const auto* actual_capabilities=reinterpret_cast<TOKEN_GROUPS*>(capability_info.data());if(actual_capabilities->GroupCount!=security.CapabilityCount||(security.CapabilityCount&&!EqualSid(actual_capabilities->Groups[0].Sid,registry.entry.Sid)))return fail(ERROR_ACCESS_DENIED);
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return fail(GetLastError());
  *result = created; result->hProcess = process.release(); result->hThread = thread.release(); return ERROR_SUCCESS;
}
DWORD ControlledJob::ActiveProcesses(DWORD* count) const {
  if (!job_ || !count) return ERROR_INVALID_HANDLE;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  if (!QueryInformationJobObject(job_, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr)) return GetLastError();
  *count = info.ActiveProcesses; return ERROR_SUCCESS;
}
DWORD ControlledJob::ProcessIds(std::vector<DWORD>& ids) const {
  if (!job_) return ERROR_INVALID_HANDLE;
  std::vector<unsigned char> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 64 * sizeof(ULONG_PTR));
  auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
  if (!QueryInformationJobObject(job_, JobObjectBasicProcessIdList, list, static_cast<DWORD>(bytes.size()), nullptr)) return GetLastError();
  if (list->NumberOfAssignedProcesses != list->NumberOfProcessIdsInList) return ERROR_MORE_DATA;
  ids.clear(); for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) ids.push_back(static_cast<DWORD>(list->ProcessIdList[i]));
  return ERROR_SUCCESS;
}
DWORD ControlledJob::Stop(DWORD exit_code) {
  std::lock_guard lock(spawn_stop_mutex_);
  stopping_ = true;
  if (!job_) return ERROR_INVALID_HANDLE;
  if (!TerminateJobObject(job_, exit_code)) return GetLastError();
  const ULONGLONG deadline = GetTickCount64() + 10000;
  while (GetTickCount64() < deadline) { DWORD count = 0; DWORD error = ActiveProcesses(&count); if (error) return error; if (!count) return ERROR_SUCCESS; Sleep(10); }
  return WAIT_TIMEOUT;  // Parent exit or timeout does not release the writer lease.
}
}  // namespace pi_kanban
#endif
