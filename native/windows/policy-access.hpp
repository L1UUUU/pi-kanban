#pragma once
#include "launcher.hpp"
#ifdef _WIN32
#include <bcrypt.h>
#include <sddl.h>
namespace pi_kanban {
namespace policy_access {
struct Handle{HANDLE value=INVALID_HANDLE_VALUE;~Handle(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);}};
struct Local{HLOCAL value=nullptr;~Local(){if(value)LocalFree(value);}};
// Actual filesystem access under the exact suspended process token. No undocumented
// token class, user-wide ACL modification, or Worker self-report is used as proof.
inline DWORD Verify(HANDLE token,const LaunchDescriptor& d,PSID app_sid,bool* aap_readable){
  Handle host_token;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&host_token.value))return GetLastError();
  DWORD size=0;GetTokenInformation(host_token.value,TokenUser,nullptr,0,&size);std::vector<unsigned char> user(size);
  if(!size||!GetTokenInformation(host_token.value,TokenUser,user.data(),size,&size))return GetLastError();
  LPWSTR user_text=nullptr,app_text=nullptr;
  if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,&user_text))return GetLastError();Local user_owner{user_text};
  if(!ConvertSidToStringSidW(app_sid,&app_text))return GetLastError();Local app_owner{app_text};
  std::array<unsigned char,32> challenge{};if(BCryptGenRandom(nullptr,challenge.data(),static_cast<ULONG>(challenge.size()),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0)return ERROR_INVALID_FUNCTION;
  std::wstring unique;const wchar_t hex[]=L"0123456789abcdef";for(unsigned char byte:challenge){unique+=hex[byte>>4];unique+=hex[byte&15];}
  const std::wstring base=d.scratch+L"\\.pi-native-policy-"+unique;
  const std::wstring sid_path=base+L"-sid.fixture",aap_path=base+L"-aap.fixture";
  Handle sid_file,aap_file;
  const auto create=[&](const std::wstring& path,const wchar_t* trustee,Handle& file)->DWORD{
    const std::wstring sddl=L"D:P(A;;FA;;;SY)(A;;FA;;;"+std::wstring(user_text)+L")(A;;FR;;;"+trustee+L")";
    PSECURITY_DESCRIPTOR raw=nullptr;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&raw,nullptr))return GetLastError();Local descriptor{raw};
    SECURITY_ATTRIBUTES security{sizeof(security),raw,FALSE};
    // Nonshared write/delete plus CREATE_NEW pins the exact synthetic file. Only
    // these helper-created bytes are removed, by handle closure before Resume.
    file.value=CreateFileW(path.c_str(),GENERIC_READ|GENERIC_WRITE|DELETE,FILE_SHARE_READ,&security,CREATE_NEW,FILE_ATTRIBUTE_TEMPORARY|FILE_FLAG_DELETE_ON_CLOSE,nullptr);
    if(file.value==INVALID_HANDLE_VALUE)return GetLastError();DWORD written=0;
    if(!WriteFile(file.value,challenge.data(),static_cast<DWORD>(challenge.size()),&written,nullptr)||written!=challenge.size())return ERROR_WRITE_FAULT;
    return ERROR_SUCCESS;
  };
  DWORD error=create(sid_path,app_text,sid_file);if(error)return error;error=create(aap_path,L"S-1-15-2-1",aap_file);if(error)return error;
  Handle impersonation;if(!DuplicateTokenEx(token,TOKEN_QUERY|TOKEN_IMPERSONATE,nullptr,SecurityImpersonation,TokenImpersonation,&impersonation.value))return GetLastError();
  // All strings, descriptors and allocations are complete before impersonation.
  // Every unsuccessful API is an error; it is never interpreted as LPAC denial.
  if(!ImpersonateLoggedOnUser(impersonation.value))return GetLastError();
  const auto read=[&](const std::wstring& path,bool* readable)->DWORD{
    Handle file;file.value=CreateFileW(path.c_str(),FILE_READ_DATA,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(file.value==INVALID_HANDLE_VALUE){*readable=false;return GetLastError();}
    std::array<unsigned char,32> actual{};DWORD count=0;if(!ReadFile(file.value,actual.data(),static_cast<DWORD>(actual.size()),&count,nullptr))return GetLastError();
    if(count!=challenge.size()||actual!=challenge)return ERROR_INVALID_DATA;*readable=true;return ERROR_SUCCESS;
  };
  bool sid_readable=false,packages_readable=false;const DWORD sid_status=read(sid_path,&sid_readable),aap_status=read(aap_path,&packages_readable);
  // Never run trusted finalization on a thread whose security context could not
  // be restored. Kernel Job-handle closure kills descendants; no clean receipt
  // is written, so this catastrophic failure remains unknown after restart.
  if(!RevertToSelf())::ExitProcess(ERROR_CANNOT_IMPERSONATE);
  if(sid_status||!sid_readable)return sid_status?sid_status:ERROR_ACCESS_DENIED;
  const bool ordinary=d.policy_variant==L"appcontainer-no-network-v3";
  if(ordinary?(aap_status!=ERROR_SUCCESS||!packages_readable):(aap_status!=ERROR_ACCESS_DENIED||packages_readable))return ERROR_ACCESS_DENIED;
  *aap_readable=packages_readable;return ERROR_SUCCESS;
}
}
}
#endif
