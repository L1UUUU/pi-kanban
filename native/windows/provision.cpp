#include "provision.hpp"
#ifdef _WIN32
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <filesystem>
#include <algorithm>
#include <cwctype>
namespace pi_kanban {
namespace {
namespace fs=std::filesystem;
// ACL edits are read/modify/write operations on shared pinned files and their
// ancestors. Serialize across every trusted helper for this Windows user, not
// merely across threads in one helper. AppContainers receive no mutex rights.
class UserAclMutex {
 public:
  DWORD Acquire(){
    HANDLE token=nullptr;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return GetLastError();
    DWORD size=0;GetTokenInformation(token,TokenUser,nullptr,0,&size);std::vector<unsigned char> bytes(size);
    const bool queried=size&&!!GetTokenInformation(token,TokenUser,bytes.data(),size,&size);const DWORD query_error=queried?ERROR_SUCCESS:GetLastError();CloseHandle(token);if(!queried)return query_error;
    LPWSTR user=nullptr;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid,&user))return GetLastError();
    const std::wstring sid(user);LocalFree(user);
    const std::wstring sddl=L"D:P(A;;GA;;;SY)(A;;GA;;;"+sid+L")";PSECURITY_DESCRIPTOR descriptor=nullptr;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return GetLastError();
    SECURITY_ATTRIBUTES security{sizeof(security),descriptor,FALSE};
    const std::wstring name=L"Global\\pi-kanban-acl-v1-"+sid;handle_=CreateMutexW(&security,FALSE,name.c_str());const DWORD created=handle_?ERROR_SUCCESS:GetLastError();LocalFree(descriptor);if(!handle_)return created;
    const DWORD wait=WaitForSingleObject(handle_,10000);if(wait!=WAIT_OBJECT_0&&wait!=WAIT_ABANDONED)return wait==WAIT_TIMEOUT?ERROR_TIMEOUT:GetLastError();owned_=true;return ERROR_SUCCESS;
  }
  ~UserAclMutex(){if(owned_)ReleaseMutex(handle_);if(handle_)CloseHandle(handle_);}
 private:HANDLE handle_=nullptr;bool owned_=false;
};
DWORD SafeTree(const fs::path& root){
  try{if(root==root.root_path()||!root.is_absolute())return ERROR_BAD_PATHNAME;
    fs::path cursor=root;while(!cursor.empty()){const DWORD attrs=GetFileAttributesW(cursor.c_str());if(attrs==INVALID_FILE_ATTRIBUTES)return GetLastError();if(attrs&FILE_ATTRIBUTE_REPARSE_POINT)return ERROR_REPARSE_TAG_INVALID;if(cursor==cursor.root_path())break;cursor=cursor.parent_path();}
    if(fs::is_directory(root))for(const auto& entry:fs::recursive_directory_iterator(root)){const DWORD attrs=GetFileAttributesW(entry.path().c_str());if(attrs==INVALID_FILE_ATTRIBUTES)return GetLastError();if(attrs&FILE_ATTRIBUTE_REPARSE_POINT)return ERROR_REPARSE_TAG_INVALID;}
    return ERROR_SUCCESS;
  }catch(...){return ERROR_ACCESS_DENIED;}
}
DWORD Edit(const std::wstring& path,PSID sid,DWORD rights,ACCESS_MODE mode,bool inherit){
  PACL previous=nullptr,next=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
  DWORD error=GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&previous,nullptr,&descriptor);if(error)return error;
  EXPLICIT_ACCESSW entry{};entry.grfAccessPermissions=rights;entry.grfAccessMode=mode;entry.grfInheritance=inherit?SUB_CONTAINERS_AND_OBJECTS_INHERIT:NO_INHERITANCE;
  entry.Trustee.TrusteeForm=TRUSTEE_IS_SID;entry.Trustee.TrusteeType=TRUSTEE_IS_UNKNOWN;entry.Trustee.ptstrName=static_cast<LPWSTR>(sid);
  error=SetEntriesInAclW(1,&entry,previous,&next);
  if(!error)error=SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,next,nullptr);
  if(next)LocalFree(next);if(descriptor)LocalFree(descriptor);return error;
}
DWORD VerifyNoSid(const std::wstring& path,PSID sid){
  PACL acl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
  DWORD error=GetNamedSecurityInfoW(path.c_str(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION,nullptr,nullptr,&acl,nullptr,&descriptor);if(error)return error;
  if(acl)for(DWORD i=0;i<acl->AceCount;i++){LPVOID raw=nullptr;if(!GetAce(acl,i,&raw)){error=GetLastError();break;}const auto* header=static_cast<ACE_HEADER*>(raw);
    if(header->AceType==ACCESS_ALLOWED_ACE_TYPE||header->AceType==ACCESS_DENIED_ACE_TYPE){const auto* entry=static_cast<ACCESS_ALLOWED_ACE*>(raw);if(EqualSid(const_cast<DWORD*>(&entry->SidStart),sid)){error=ERROR_ACCESS_DENIED;break;}}}
  if(descriptor)LocalFree(descriptor);return error;
}
bool Contains(const std::wstring& root,const std::wstring& path){auto r=root,p=path;std::transform(r.begin(),r.end(),r.begin(),towlower);std::transform(p.begin(),p.end(),p.begin(),towlower);return p==r||(p.size()>r.size()&&p.compare(0,r.size(),r)==0&&p[r.size()]==L'\\');}
}
DWORD ScopedResources::Provision(const LaunchDescriptor& d,const std::vector<std::wstring>& readonly_roots,const std::wstring& authorization){
  std::lock_guard lock(mutex_);UserAclMutex shared_lock;const DWORD shared_status=shared_lock.Acquire();if(shared_status)return shared_status;
  if(sid_||authorization.empty()||authorization.size()>200||readonly_roots.size()!=2+d.shell_files.size())return ERROR_ACCESS_DENIED;
  DWORD error=ValidateDescriptor(d);if(error)return error;
  if(Contains(d.workspace,d.scratch)||Contains(d.scratch,d.workspace))return ERROR_ACCESS_DENIED;
  if((error=SafeTree(d.workspace))||(error=SafeTree(d.scratch)))return error;
  bool node_covered=false,worker_covered=false;
  for(const auto& root:readonly_roots){if((error=SafeTree(root)))return error;if(!fs::is_regular_file(root)||(root!=d.node_executable&&root!=d.worker_entry&&std::none_of(d.shell_files.begin(),d.shell_files.end(),[&](const auto& file){return file.path==root;})))return ERROR_ACCESS_DENIED;if(Contains(root,d.workspace)||Contains(root,d.scratch)||Contains(d.workspace,root)||Contains(d.scratch,root))return ERROR_ACCESS_DENIED;node_covered|=root==d.node_executable;worker_covered|=root==d.worker_entry;}
  if(!node_covered||!worker_covered)return ERROR_ACCESS_DENIED;
  profile_=d.profile_name;const HRESULT created=CreateAppContainerProfile(profile_.c_str(),profile_.c_str(),L"pi-kanban generation-scoped Worker",nullptr,0,&sid_);
  if(FAILED(created))return HRESULT_CODE(created); // Never reuse an old identity or its mutable grants.
  const auto grant=[&](const std::wstring& path,DWORD rights,ACCESS_MODE mode,bool inherit){const DWORD result=Edit(path,sid_,rights,mode,inherit);if(!result){changed_.push_back(path);if(inherit)recursive_.insert(path);}return result;};
  for(const auto& root:readonly_roots)if((error=grant(root,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE,GRANT_ACCESS,false)))return error;
  if((error=grant(d.workspace,FILE_GENERIC_READ|(d.role==L"implementation"?(FILE_GENERIC_WRITE|DELETE):0),GRANT_ACCESS,true)))return error;
  if((error=grant(d.scratch,FILE_ALL_ACCESS,GRANT_ACCESS,true)))return error;
  for(const auto* name:{L".git",L".local"}){const auto internal=(fs::path(d.workspace)/name).wstring();if(GetFileAttributesW(internal.c_str())!=INVALID_FILE_ATTRIBUTES&&
      (error=grant(internal,FILE_ALL_ACCESS,DENY_ACCESS,true)))return error;}
  // Traverse only ancestors; no enumeration or content permission on parent directories.
  std::vector<std::wstring> roots=readonly_roots;roots.push_back(d.workspace);roots.push_back(d.scratch);
  for(const auto& root:roots){auto parent=fs::path(root).parent_path();while(parent!=parent.root_path()&&!parent.empty()){
    if(std::find(changed_.begin(),changed_.end(),parent.wstring())==changed_.end()&&(error=grant(parent.wstring(),FILE_TRAVERSE,GRANT_ACCESS,false)))return error;
    parent=parent.parent_path();}}
  return ERROR_SUCCESS;
}
DWORD ScopedResources::Revoke(){
  std::lock_guard lock(mutex_);UserAclMutex shared_lock;const DWORD shared_status=shared_lock.Acquire();if(shared_status)return shared_status;if(profile_.empty()||!sid_)return ERROR_SUCCESS;
  DWORD first=ERROR_SUCCESS;
  for(auto it=changed_.rbegin();it!=changed_.rend();++it){const DWORD attrs=GetFileAttributesW(it->c_str());if(attrs==INVALID_FILE_ATTRIBUTES){if(!first)first=GetLastError();continue;}if(attrs&FILE_ATTRIBUTE_REPARSE_POINT){if(!first)first=ERROR_REPARSE_TAG_INVALID;continue;}
    if(recursive_.contains(*it)){const DWORD safe=SafeTree(*it);if(safe){if(!first)first=safe;continue;}}
    const DWORD result=Edit(*it,sid_,0,REVOKE_ACCESS,false);if(result&&!first)first=result;
  }
  // Verify only after every parent grant has been removed. Earlier verification
  // of a .git deny entry would still see the source parent's inherited grant.
  for(const auto& path:changed_){
    const DWORD attributes=GetFileAttributesW(path.c_str());if(attributes==INVALID_FILE_ATTRIBUTES){if(!first)first=GetLastError();continue;}if(attributes&FILE_ATTRIBUTE_REPARSE_POINT){if(!first)first=ERROR_REPARSE_TAG_INVALID;continue;}
    DWORD verified=VerifyNoSid(path,sid_);
    if(!verified&&recursive_.contains(path)){const DWORD safe=SafeTree(path);if(safe)verified=safe;else try{for(const auto& entry:fs::recursive_directory_iterator(path)){verified=VerifyNoSid(entry.path().wstring(),sid_);if(verified)break;}}catch(...){verified=ERROR_ACCESS_DENIED;}}
    if(verified&&!first)first=verified;
  }
  if(!first){changed_.clear();const HRESULT deleted=DeleteAppContainerProfile(profile_.c_str());if(FAILED(deleted))first=HRESULT_CODE(deleted);else profile_.clear();}
  return first;
}
ScopedResources::~ScopedResources(){if(sid_)FreeSid(sid_);}
}
#endif
