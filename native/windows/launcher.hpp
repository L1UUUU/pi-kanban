#pragma once
// Windows 11 x64 candidate. Not a security certification, and not wired to the Host.
// All paths and pre-provisioned ACLs come from a trusted Host descriptor verifier.
#ifdef _WIN32
#include <windows.h>
#include <array>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>
namespace pi_kanban {
struct LaunchDescriptor {
  uint32_t version = 1;
  std::wstring demand, role, generation, profile_name;
  std::wstring node_executable, worker_entry, workspace, scratch;
  std::array<unsigned char, 32> node_sha256{}, worker_sha256{};
  // Evidence binds ACL provisioning to this exact SID/resources/role/generation.
  // Candidate requires nonempty references, but the Host must verify their contents.
  std::wstring policy_evidence, acl_evidence, private_channel_evidence;
  DWORD timeout_ms = 0, process_limit = 0;
  SIZE_T memory_limit_bytes = 0;
  uint64_t output_limit_bytes = 0;
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
  DWORD ActiveProcesses(DWORD* count) const;
  DWORD ProcessIds(std::vector<DWORD>& ids) const;
  const ProcessIdentity& Identity() const { return identity_; }
  const char* LastStage() const { return stage_; }
 private:
  HANDLE job_ = nullptr, process_ = nullptr;
  std::vector<HANDLE> pinned_files_;
  ProcessIdentity identity_;
  std::jthread watchdog_;
  const char* stage_ = "not-started";
};
DWORD ValidateDescriptor(const LaunchDescriptor&);
}  // namespace pi_kanban
#endif
