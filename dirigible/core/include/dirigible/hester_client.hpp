#pragma once

#include "dirigible/transport.hpp"
#include <functional>
#include <string>

namespace dirigible {

// ---------------------------------------------------------------------------
// HesterClient — streams Hester ReAct phase events via SSE
//
// POSTs to http://{host}:{port}/context/stream and parses event:/data: lines.
// Used by Dirigible to drive the "thinking → acting → observing → responding"
// indicator while a Hester query is in flight.
//
// Reference: hester/daemon/main.py /context/stream endpoint
// ---------------------------------------------------------------------------

enum class HesterPhase {
    Preparing,
    Thinking,
    Acting,
    Observing,
    Responding,
    Unknown,
};

class HesterClient {
public:
    using PhaseCallback    = std::function<void(HesterPhase phase, const std::string& detail)>;
    using ResponseCallback = std::function<void(const std::string& text)>;
    using DoneCallback     = std::function<void(bool ok)>;
    using ErrorCallback    = std::function<void(const std::string& message)>;

    HesterClient(ITransportFactory* factory,
                 const std::string& host, int port);
    ~HesterClient();

    // Non-copyable
    HesterClient(const HesterClient&) = delete;
    HesterClient& operator=(const HesterClient&) = delete;

    // Send a chat message to Hester. Streams phases + final response.
    // session_id can be empty to start a fresh session.
    void send(const std::string& message,
              const std::string& session_id = "",
              const std::string& source = "Dirigible");

    // Callback registration (call before send())
    void onPhase(PhaseCallback cb)        { on_phase_ = std::move(cb); }
    void onResponse(ResponseCallback cb)  { on_response_ = std::move(cb); }
    void onDone(DoneCallback cb)          { on_done_ = std::move(cb); }
    void onError(ErrorCallback cb)        { on_error_ = std::move(cb); }

private:
    void handleEvent(const std::string& event, const std::string& data);
    static HesterPhase parsePhase(const std::string& name);

    ITransportFactory* factory_;
    IHttpClient* http_ = nullptr;
    std::string host_;
    int port_;

    PhaseCallback    on_phase_;
    ResponseCallback on_response_;
    DoneCallback     on_done_;
    ErrorCallback    on_error_;
};

}  // namespace dirigible
