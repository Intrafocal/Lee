#include "dirigible/pairing_client.hpp"
#include "cJSON.h"

namespace dirigible {

PairingClient::PairingClient(ITransportFactory* factory,
                             const std::string& host, int port)
    : factory_(factory), host_(host), port_(port) {
    // 8 s: long enough for a sleepy laptop to answer, short enough that a dead
    // host reports back inside one 1.5 s poll gap's worth of patience.
    http_ = factory_->createHttpClient(8000);
}

PairingClient::~PairingClient() {
    delete http_;
}

void PairingClient::setHost(const std::string& host, int port) {
    host_ = host;
    port_ = port > 0 ? port : 9001;
}

void PairingClient::requestPair(const std::string& device,
                                const std::string& kind,
                                const std::string& code,
                                const std::string& nonce,
                                RequestCallback cb) {
    if (!http_ || host_.empty()) {
        if (cb) cb(false, 0, "No host");
        return;
    }

    cJSON* body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "device", device.c_str());
    cJSON_AddStringToObject(body, "kind",   kind.c_str());
    cJSON_AddStringToObject(body, "code",   code.c_str());
    cJSON_AddStringToObject(body, "nonce",  nonce.c_str());

    const std::string url = "http://" + host_ + ":" + std::to_string(port_)
                          + "/pair/request";

    http_->post(url, body, [cb](int status, cJSON* resp) {
        if (status == 200) {
            int expires = 120;
            if (resp) {
                cJSON* e = cJSON_GetObjectItemCaseSensitive(resp, "expires_in");
                if (e && cJSON_IsNumber(e)) expires = e->valueint;
            }
            if (cb) cb(true, expires, "");
            return;
        }

        std::string err;
        if (resp) {
            cJSON* e = cJSON_GetObjectItemCaseSensitive(resp, "error");
            if (e && cJSON_IsString(e)) err = e->valuestring;
        }
        if (err.empty()) {
            if (status == 0)        err = "Lee unreachable";
            else if (status == 404) err = "Pairing is off in Lee";
            else if (status == 429) err = "Lee is busy - wait 2 min";
            else                    err = "Lee said " + std::to_string(status);
        }
        if (cb) cb(false, 0, err);
    });
}

void PairingClient::poll(const std::string& nonce, PollCallback cb) {
    if (!http_ || host_.empty()) {
        if (cb) cb(Status::Error, Grant{});
        return;
    }

    const std::string url = "http://" + host_ + ":" + std::to_string(port_)
                          + "/pair/poll?nonce=" + nonce;

    http_->get(url, [cb](int status, cJSON* resp) {
        if (status != 200 || !resp) {
            if (cb) cb(Status::Error, Grant{});
            return;
        }

        cJSON* s = cJSON_GetObjectItemCaseSensitive(resp, "status");
        const Status st = (s && cJSON_IsString(s)) ? parseStatus(s->valuestring)
                                                   : Status::Error;
        Grant grant;
        if (st == Status::Approved) {
            cJSON* t = cJSON_GetObjectItemCaseSensitive(resp, "token");
            if (t && cJSON_IsString(t)) grant.token = t->valuestring;

            cJSON* h = cJSON_GetObjectItemCaseSensitive(resp, "hester_port");
            if (h && cJSON_IsNumber(h) && h->valueint > 0) grant.hester_port = h->valueint;

            cJSON* n = cJSON_GetObjectItemCaseSensitive(resp, "name");
            if (n && cJSON_IsString(n)) grant.name = n->valuestring;

            // An "approved" with no token is a protocol error, not a grant —
            // saying so beats writing an empty bearer into NVS.
            if (grant.token.empty()) {
                if (cb) cb(Status::Error, Grant{});
                return;
            }
        }
        if (cb) cb(st, grant);
    });
}

PairingClient::Status PairingClient::parseStatus(const char* s) {
    if (!s) return Status::Error;
    const std::string v(s);
    if (v == "pending")  return Status::Pending;
    if (v == "approved") return Status::Approved;
    if (v == "denied")   return Status::Denied;
    if (v == "expired")  return Status::Expired;
    return Status::Error;
}

std::string PairingClient::formatCode(const std::string& code) {
    if (code.size() != 6) return code;
    return code.substr(0, 3) + " " + code.substr(3, 3);
}

}  // namespace dirigible
