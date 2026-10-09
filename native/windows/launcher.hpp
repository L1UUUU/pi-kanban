#pragma once
// Windows x64 native containment candidate, wired through the gated Host driver.
// Not a security certification. Only trusted helper descriptors and scoped ACLs enter here.
#ifdef _WIN32
#include <windows.h>
#include <array>
#include <cstdint>
#include <string>
#include <thread>
#include <mutex>
#include <vector>
namespace pi_kanban {
struct LockedRuntimeFile {std::wstring path;std::array<unsigned char,32> sha256{};};
struct LaunchDescriptor {
  uint32_t version = 1;
  std::wstring policy_variant=L"lpac-strict-v1";
  std::wstring demand, role, generation, profile_name;
  std::wstring node_executable, worker_entry, workspace, scratch;
  std::wstring shell_executable,shell_root;
  std::array<unsigned char,32> shell_sha256{};
  std::vector<LockedRuntimeFile> shell_files;
  std::array<unsigned char, 32> node_sha256{}, worker_sha256{};
  // Evidence binds ACL provisioning to this exact SID/resources/role/generation.
  // Candidate requires nonempty references, but the Host must verify their contents.
  std::wstring policy_evidence, acl_evidence, private_channel_evidence;
  DWORD timeout_ms = 0, process_limit = 0;
  SIZE_T memory_limit_bytes = 0;
  uint64_t output_limit_bytes = 0;
  uint64_t disk_limit_bytes = 1024ull*1024*1024, minimum_free_bytes = 256ull*1024*1024;
  DWORD file_limit = 100000, disk_poll_ms = 250;
};
struct PrivateHandles {
  // Anonymous pipes created and owned by trusted helper, no global pipe name.
  HANDLE requests_read = INVALID_HANDLE_VALUE;
  HANDLE reports_write = INVALID_HANDLE_VALUE;
  HANDLE logs_write = INVALID_HANDLE_VALUE;
};
struct ProcessIdentity {
  DWORD pid = 0;
  FILETIME creation_time{};
  std::wstring generation;
};
class ControlledJob {
 public:
  ControlledJob() = default;
  ~ControlledJob();
  ControlledJob(const ControlledJob&) = delete;
  ControlledJob& operator=(const ControlledJob&) = delete;
  // Descriptor requires already-provisioned resource ACLs. Does not change ACLs or install anything.
  DWORD Launch(const LaunchDescriptor&, const PrivateHandles&);
  DWORD Stop(DWORD exit_code = ERROR_CANCELLED);
  DWORD SpawnNodeCheck(const LaunchDescriptor&, const std::vector<std::wstring>& args, HANDLE input, HANDLE output, PROCESS_INFORMATION* process);
  DWORD SpawnShellCheck(const LaunchDescriptor&, const std::vector<std::wstring>& args, HANDLE input, HANDLE output, PROCESS_INFORMATION* process);
  DWORD ActiveProcesses(DWORD* count) const;
  DWORD ProcessIds(std::vector<DWORD>& ids) const;
  bool EverCreated() const {return ever_created_;}
  const ProcessIdentity& Identity() const { return identity_; }
  const char* LastStage() const { return stage_; }
 private:
  DWORD SpawnPinnedCheck(const LaunchDescriptor&,const std::wstring& executable,const std::vector<std::wstring>& args,HANDLE input,HANDLE output,PROCESS_INFORMATION* result,bool shell);
  HANDLE job_ = nullptr, process_ = nullptr;
  std::vector<HANDLE> pinned_files_;
  ProcessIdentity identity_;
  std::jthread watchdog_;
  const char* stage_ = "not-started";
  // Serialize child creation with terminal stop. Once stopped no new process may
  // enter this generation, including a command already queued on the Host pipe.
  std::mutex spawn_stop_mutex_;
  bool stopping_ = false;
  bool ever_created_ = false;
};
std::wstring AppContainerProfileName(const std::wstring& demand,const std::wstring& role,const std::wstring& generation);
DWORD ValidateDescriptor(const LaunchDescriptor&);
}  // namespace pi_kanban
#endif
