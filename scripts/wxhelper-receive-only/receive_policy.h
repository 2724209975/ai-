#ifndef CHAT_AGENT_RECEIVE_POLICY_H
#define CHAT_AGENT_RECEIVE_POLICY_H
#include <cstdint>
#include <mutex>
#include <string>
#include "voice_candidate.h"

namespace p4_receive {
enum class Action { Deny, Status, Login, Hook, Unhook };
struct Snapshot {
  uint32_t text = 0, image = 0, voice = 0, other = 0;
  bool expired = false, message_limit = false;
  std::string latest_voice_id;
};
class Policy {
 public:
  Policy(std::string token, std::string peer, uint64_t started)
      : token_(std::move(token)), peer_(std::move(peer)), started_(started) {
    valid_ = token_.size() == 64 && !peer_.empty() && peer_.size() <= 128;
    for (char c : token_) valid_ = valid_ && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
    for (char c : peer_) valid_ = valid_ && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                                          (c >= 'A' && c <= 'Z') || c == '_' || c == '-');
  }
  Action Authorize(const std::string& method, const std::string& path, const std::string& bearer,
                   bool origin_present, const std::string& body, uint64_t now) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_ || method != "POST" || origin_present || body != "{}" || bearer.size() != 71 ||
        bearer.compare(0, 7, "Bearer ") != 0) return Action::Deny;
    unsigned int difference = 0;
    for (std::size_t i = 0; i < 64; ++i)
      difference |= static_cast<unsigned char>(bearer[i + 7]) ^ static_cast<unsigned char>(token_[i]);
    if (difference != 0) return Action::Deny;
    // A valid owner can always remove the hook, including after expiry or rate exhaustion.
    if (path == "/api/unhookSyncMsg") return Action::Unhook;
    Action action = Action::Deny;
    if (path == "/api/p4ReceiveStatus") action = Action::Status;
    if (path == "/api/checkLogin") action = Action::Login;
    if (path == "/api/hookSyncMsg") action = Action::Hook;
    if (action == Action::Deny || (Expired(now) && action != Action::Status)) return Action::Deny;
    if (now / 1000 != window_) { window_ = now / 1000; window_count_ = 0; }
    if (window_count_ >= 10 || total_requests_ >= 64) return Action::Deny;
    ++window_count_; ++total_requests_;
    return action;
  }
  void Observe(const std::string& from, uint32_t type, const std::string& id, uint64_t now) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!valid_ || from != peer_ || Expired(now) || observed_ >= 16) return;
    ++observed_;
    if (type == 1) ++snapshot_.text;
    else if (type == 3) ++snapshot_.image;
    else if (type == 34) {
      ++snapshot_.voice;
      snapshot_.latest_voice_id = voice_candidate::ValidId(id) ? id : "";
    } else ++snapshot_.other;
  }
  Snapshot Get(uint64_t now) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto result = snapshot_;
    result.expired = Expired(now); result.message_limit = observed_ >= 16;
    return result;
  }
 private:
  bool Expired(uint64_t now) const { return now < started_ || now - started_ >= 600000; }
  std::mutex mutex_;
  std::string token_, peer_;
  uint64_t started_, window_ = 0;
  uint32_t window_count_ = 0, total_requests_ = 0, observed_ = 0;
  bool valid_ = false;
  Snapshot snapshot_;
};
}  // namespace p4_receive
#endif
