#pragma once

#include "dirigible/transport.hpp"
#include <functional>
#include <string>

namespace dirigible {

// ---------------------------------------------------------------------------
// PairingClient — code-approval pairing against Lee's /pair/* routes (E19)
//
// The device shows a 6-digit code on its own screen, POSTs it with a random
// nonce to an unauthenticated endpoint, and the user approves it in a native
// dialog on the Lee machine.  The token then arrives over the poll.  Nobody
// types 36 characters on a thumb keyboard.
//
//   POST /pair/request  {device, kind, code, nonce} -> {status:"pending",
//                                                       expires_in}
//   GET  /pair/poll?nonce=…  -> {status:"pending"|"denied"|"expired"}
//                             | {status:"approved", token, hester_port, name}
//
// Neither request carries a bearer — that is the whole point — so this client
// never calls IHttpClient::setAuthToken().
//
// Unlike HesterClient the host and port are settable rather than fixed at
// construction: pairing retries against a different host within one flow, and
// a single long-lived instance avoids deleting an IHttpClient while one of its
// request tasks is still in flight.
//
// Reference: electron/src/main/api-server.ts, electron/src/main/pairing-store.ts
// ---------------------------------------------------------------------------

class PairingClient {
public:
    enum class Status {
        Pending,    // waiting for the user
        Approved,   // grant is filled in
        Denied,     // user pressed Deny
        Expired,    // nonce unknown, timed out, or token already collected
        Error,      // transport failure / unparseable reply
    };

    struct Grant {
        std::string token;
        int         hester_port = 9000;
        std::string name;
    };

    /// ok=false means the request never landed; `error` is a short line fit to
    /// show on a 184 px column.
    using RequestCallback = std::function<void(bool ok, int expires_in,
                                               const std::string& error)>;
    using PollCallback    = std::function<void(Status status, const Grant& grant)>;

    PairingClient(ITransportFactory* factory,
                  const std::string& host = "", int port = 9001);
    ~PairingClient();

    // Non-copyable
    PairingClient(const PairingClient&) = delete;
    PairingClient& operator=(const PairingClient&) = delete;

    void setHost(const std::string& host, int port);

    void requestPair(const std::string& device,
                     const std::string& kind,
                     const std::string& code,
                     const std::string& nonce,
                     RequestCallback cb);

    void poll(const std::string& nonce, PollCallback cb);

    /// "483 910"-style grouping for the on-screen code.  Digits only, so it
    /// stays unambiguous in a mono font (no O/0, I/1, S/5 to confuse).
    static std::string formatCode(const std::string& code);

private:
    static Status parseStatus(const char* s);

    ITransportFactory* factory_;
    IHttpClient*       http_ = nullptr;
    std::string        host_;
    int                port_;
};

}  // namespace dirigible
