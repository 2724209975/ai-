#include <winsock2.h>
#include <Windows.h>
#include "mongoose.h"
#include <chrono>
#include <memory>
#include "receive_endpoint.h"
#include "receive_policy.h"
#include "nlohmann/json.hpp"
#include "sync_msg_hook.h"
#include "wechat_service.h"

namespace p4_receive {
uint64_t Now() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
std::unique_ptr<Policy> LoadPolicy() {
  try {
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCWSTR>(&LoadPolicy), &module)) throw 1;
    wchar_t path[32768] = {};
    const DWORD size = GetModuleFileNameW(module, path, 32768);
    if (!size || size >= 32768) throw 1;
    std::wstring filename(path, size);
    filename = filename.substr(0, filename.find_last_of(L"\\/")) + L"\\receive-only.json";
    HANDLE file = CreateFileW(filename.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw 1;
    BY_HANDLE_FILE_INFORMATION info = {};
    char bytes[1024]; DWORD read = 0;
    const bool ok = GetFileInformationByHandle(file, &info) &&
        !(info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
        info.nFileSizeHigh == 0 && info.nFileSizeLow > 0 && info.nFileSizeLow <= sizeof(bytes) &&
        ReadFile(file, bytes, info.nFileSizeLow, &read, nullptr) && read == info.nFileSizeLow;
    CloseHandle(file);
    if (!ok) throw 1;
    const auto config = nlohmann::json::parse(bytes, bytes + read);
    if (!config.is_object() || config.size() != 2 || !config.at("token").is_string() ||
        !config.at("peer").is_string()) throw 1;
    return std::make_unique<Policy>(config.at("token").get<std::string>(),
                                    config.at("peer").get<std::string>(), Now());
  } catch (...) { return std::make_unique<Policy>("", "", Now()); }
}
Policy& Session() { static auto policy = LoadPolicy(); return *policy; }
void Observe(const std::string& from, uint32_t type, const std::string& id) {
  Session().Observe(from, type, id, Now());
}
void Reply(struct mg_connection* connection, int status, const nlohmann::json& value) {
  const auto json = value.dump();
  mg_http_reply(connection, status, "Content-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\n",
                "%s", json.c_str());
  connection->is_draining = 1;
}
void Handle(struct mg_connection* connection, struct mg_http_message* message) {
  try {
    const auto* authorization = mg_http_get_header(message, "Authorization");
    if (message->method.len > 4 || message->uri.len > 64 || message->body.len > 2 ||
        message->query.len != 0 || !authorization || authorization->len > 71) {
      Reply(connection, 403, {{"code", "P4_REQUEST_DENIED"}}); return;
    }
    // Duplicate authentication headers must not be interpreted differently by intermediaries.
    unsigned int auth_count = 0;
    for (const auto& header : message->headers)
      if (header.name.len && mg_vcasecmp(&header.name, "Authorization") == 0) ++auth_count;
    if (auth_count != 1) { Reply(connection, 403, {{"code", "P4_REQUEST_DENIED"}}); return; }
    const auto action = Session().Authorize(std::string(message->method.ptr, message->method.len),
        std::string(message->uri.ptr, message->uri.len), std::string(authorization->ptr, authorization->len),
        mg_http_get_header(message, "Origin") != nullptr, std::string(message->body.ptr, message->body.len), Now());
    if (action == Action::Deny) { Reply(connection, 403, {{"code", "P4_REQUEST_DENIED"}}); return; }
    if (action == Action::Status) {
      const auto snapshot = Session().Get(Now());
      Reply(connection, 200, {{"code", 0}, {"data", {
        {"protocol", "p4-5b-receive-only-v1"}, {"receiveOnly", true}, {"voiceDatabaseReady", false},
        {"text", snapshot.text}, {"image", snapshot.image}, {"voice", snapshot.voice}, {"other", snapshot.other},
        {"expired", snapshot.expired}, {"messageLimit", snapshot.message_limit}, {"latestVoiceId", snapshot.latest_voice_id}}}});
      return;
    }
    int64_t code = -1;
    if (action == Action::Login) code = wechat::WeChatService::GetInstance().CheckLogin();
    if (action == Action::Hook) code = wxhelper::SyncMsgHook::GetInstance().Hook();
    if (action == Action::Unhook) code = wxhelper::SyncMsgHook::GetInstance().Unhook();
    Reply(connection, 200, {{"code", code}, {"data", nlohmann::json::object()}});
  } catch (...) { Reply(connection, 500, {{"code", "P4_INTERNAL_FAILURE"}}); }
}
}  // namespace p4_receive
