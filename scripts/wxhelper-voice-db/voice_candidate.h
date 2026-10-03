#ifndef CHAT_AGENT_VOICE_CANDIDATE_H
#define CHAT_AGENT_VOICE_CANDIDATE_H
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

// Offline experimental reader. No platform offsets, schema discovery or file export.
namespace voice_candidate {
constexpr std::size_t kMaxBytes = 2 * 1024 * 1024;
constexpr std::size_t kMaxDatabases = 64;
enum class Status { Ok, InvalidId, InvalidHandles, NotFound, QueryFailed,
                    InvalidShape, InvalidBlob, TooLarge, Ambiguous };
struct Result { Status status; std::string bytes; };

inline bool IsMediaDatabaseName(const std::wstring& name) {
  if (name.size() < 12 || name.size() > 21 || name.compare(0, 8, L"MediaMSG") != 0 ||
      name.compare(name.size() - 3, 3, L".db") != 0) return false;
  const std::wstring index = name.substr(8, name.size() - 11);
  if (index.size() > 1 && index.front() == L'0') return false;
  for (wchar_t c : index) if (c < L'0' || c > L'9') return false;
  return true;
}

inline bool ValidId(const std::string& id) {
  // SQLite integer equality must never fall back to REAL for a uint64 literal.
  if (id.empty() || id.size() > 19 || id.front() < '1' || id.front() > '9') return false;
  for (char c : id) if (c < '0' || c > '9') return false;
  return id.size() < 19 || id <= "9223372036854775807";
}

template<class Api> class Statement {
 public:
  Api& api;
  uint64_t* pointer = nullptr;
  explicit Statement(Api& value) : api(value) {}
  Statement(const Statement&) = delete;
  Statement& operator=(const Statement&) = delete;
  int Finish() {
    if (!pointer) return 0;
    auto* owned = pointer; pointer = nullptr;
    return api.sqlite3_finalize(owned);
  }
  ~Statement() { Finish(); }
};

template<class Api>
Result Read(Api& api, const std::vector<uint64_t>& handles, const std::string& id) {
  if (!ValidId(id)) return {Status::InvalidId, {}};
  if (handles.empty() || handles.size() > kMaxDatabases) return {Status::InvalidHandles, {}};
  for (std::size_t i = 0; i < handles.size(); ++i) {
    if (!handles[i] || std::find(handles.begin(), handles.begin() + i, handles[i]) != handles.begin() + i)
      return {Status::InvalidHandles, {}};
  }
  try {
    const std::string sql = "SELECT Buf FROM Media WHERE Reserved0=" + id + " LIMIT 2;";
    bool found = false;
    std::string candidate;
    for (uint64_t handle : handles) {
      Statement<Api> stmt(api);
      const auto finish = [&](Status status) -> Result {
        return {stmt.Finish() == 0 ? status : Status::QueryFailed, {}};
      };
      if (api.sqlite3_prepare(handle, sql.c_str(), -1, &stmt.pointer, nullptr) != 0 || !stmt.pointer)
        return finish(Status::QueryFailed);
      if (api.sqlite3_column_count(stmt.pointer) != 1) return finish(Status::InvalidShape);
      const int first = api.sqlite3_step(stmt.pointer);
      if (first == 101) {
        if (stmt.Finish() != 0) return {Status::QueryFailed, {}};
        continue;
      }
      if (first != 100) return finish(Status::QueryFailed);
      if (found) return finish(Status::Ambiguous);
      // Reject text, NULL and numeric coercions; preserve BLOB type before reading bytes.
      if (api.sqlite3_column_type(stmt.pointer, 0) != 4) return finish(Status::InvalidBlob);
      const int length = api.sqlite3_column_bytes(stmt.pointer, 0);
      if (length <= 0) return finish(Status::InvalidBlob);
      if (static_cast<std::size_t>(length) > kMaxBytes) return finish(Status::TooLarge);
      const void* bytes = api.sqlite3_column_blob(stmt.pointer, 0);
      if (!bytes || api.sqlite3_column_bytes(stmt.pointer, 0) != length) return finish(Status::InvalidBlob);
      candidate.assign(static_cast<const char*>(bytes), static_cast<std::size_t>(length));
      const int second = api.sqlite3_step(stmt.pointer);
      if (second == 100) return finish(Status::Ambiguous);
      if (second != 101) return finish(Status::QueryFailed);
      if (stmt.Finish() != 0) return {Status::QueryFailed, {}};
      found = true;
    }
    return found ? Result{Status::Ok, std::move(candidate)} : Result{Status::NotFound, {}};
  } catch (...) {
    // RAII releases the statement on allocation failures. Never expose SQLite error text.
    return {Status::QueryFailed, {}};
  }
}
}  // namespace voice_candidate
#endif
