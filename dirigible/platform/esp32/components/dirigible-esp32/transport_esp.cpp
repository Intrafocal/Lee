/*
 * transport_esp.cpp — dirigible::ITransportFactory on plain ESP-IDF.
 *
 * Replaces the previous wrappers around screenschema's SSWebSocket /
 * SSHttpClient / SSMdns.  The behaviour those classes had earned (fragment
 * reassembly, LVGL-task dispatch, SSE line parsing, mDNS on a worker task) is
 * reimplemented here directly on esp_websocket_client, esp_http_client and
 * mdns; the named-registry lifetime model is not, because owning the handles
 * outright removes the use-after-free hazard it created.
 *
 * Wire protocol (electron/src/main/api-server.ts):
 *   WS   ws://host:9001/context/stream?token=...
 *   WS   ws://host:9001/pty/<id>/stream?token=...   (raw text in, JSON out)
 *   HTTP POST http://host:9001/command   Authorization: Bearer <token>
 * and Hester (hester/daemon/main.py), same bearer:
 *   HTTP POST http://host:9000/context/stream  → text/event-stream
 */

#include "dirigible_esp/transport_esp.hpp"

#include <cstring>
#include <utility>

#include "cJSON.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "mdns.h"

static const char *TAG = "dirigible.net";

namespace dirigible_esp {

// ===========================================================================
// WebSocketEsp
// ===========================================================================

WebSocketEsp::WebSocketEsp(uint32_t reconnect_ms)
    : reconnect_ms_(reconnect_ms) {}

WebSocketEsp::~WebSocketEsp()
{
    teardown();
    // Drop anything the (now dead) connection queued: a stale open/message
    // closure captures `this` and would run against freed state.
    dispatch_.drain();
}

void WebSocketEsp::teardown()
{
    if (!client_) return;
    esp_websocket_client_stop(client_);
    esp_websocket_client_destroy(client_);
    client_    = nullptr;
    connected_ = false;
    frame_buf_.clear();
    dispatch_.drain();
}

void WebSocketEsp::connect(const std::string& url)
{
    // A URL change (new token, new PTY) means a fresh client; esp_websocket
    // has no supported way to re-point a running one.
    if (client_ && url != url_) teardown();

    url_ = url;

    if (!client_) {
        esp_websocket_client_config_t cfg = {};
        cfg.uri                  = url_.c_str();
        cfg.reconnect_timeout_ms = reconnect_ms_;
        cfg.network_timeout_ms   = 10000;
        cfg.buffer_size          = 4096;

        client_ = esp_websocket_client_init(&cfg);
        if (!client_) {
            ESP_LOGE(TAG, "esp_websocket_client_init failed for %s", url_.c_str());
            return;
        }
        esp_websocket_register_events(client_, WEBSOCKET_EVENT_ANY,
                                      &WebSocketEsp::event_handler, this);
    }

    esp_err_t err = esp_websocket_client_start(client_);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "esp_websocket_client_start(%s): %s",
                 url_.c_str(), esp_err_to_name(err));
        return;
    }
    ESP_LOGI(TAG, "ws connect %s (reconnect=%ums)", url_.c_str(),
             (unsigned)reconnect_ms_);
}

void WebSocketEsp::disconnect()
{
    bool was_connected = connected_;
    teardown();
    if (was_connected) {
        for (auto& cb : disconnect_cbs_) cb();
    }
}

bool WebSocketEsp::isConnected() const
{
    return client_ && connected_;
}

void WebSocketEsp::sendText(const std::string& text)
{
    if (!isConnected()) {
        ESP_LOGW(TAG, "sendText: not connected, dropping %u bytes",
                 (unsigned)text.size());
        return;
    }
    int ret = esp_websocket_client_send_text(client_, text.c_str(), text.size(),
                                             pdMS_TO_TICKS(3000));
    if (ret < 0) ESP_LOGW(TAG, "sendText failed (%d)", ret);
}

void WebSocketEsp::sendJson(cJSON* obj)
{
    if (!obj) return;
    char* text = cJSON_PrintUnformatted(obj);
    cJSON_Delete(obj);           // IWebSocket::sendJson takes ownership
    if (!text) return;
    sendText(std::string(text));
    cJSON_free(text);
}

void WebSocketEsp::sendBinary(const uint8_t* data, size_t len)
{
    if (!isConnected()) return;
    int ret = esp_websocket_client_send_bin(client_, (const char*)data, len,
                                            pdMS_TO_TICKS(3000));
    if (ret < 0) ESP_LOGW(TAG, "sendBinary failed (%d)", ret);
}

void WebSocketEsp::onMessage(std::function<void(cJSON*)> cb)
{
    message_cbs_.push_back(std::move(cb));
}
void WebSocketEsp::onBinary(std::function<void(const uint8_t*, size_t)> cb)
{
    binary_cbs_.push_back(std::move(cb));
}
void WebSocketEsp::onConnect(std::function<void()> cb)
{
    connect_cbs_.push_back(std::move(cb));
}
void WebSocketEsp::onDisconnect(std::function<void()> cb)
{
    disconnect_cbs_.push_back(std::move(cb));
}

void WebSocketEsp::event_handler(void* arg, const char* /*base*/,
                                 int32_t event_id, void* event_data)
{
    auto* self = static_cast<WebSocketEsp*>(arg);
    auto* data = static_cast<esp_websocket_event_data_t*>(event_data);

    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        self->connected_ = true;
        ESP_LOGI(TAG, "ws connected: %s", self->url_.c_str());
        self->dispatch_.post([self]() {
            for (auto& cb : self->connect_cbs_) cb();
        });
        break;

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED: {
        bool was = self->connected_;
        self->connected_ = false;
        self->frame_buf_.clear();
        if (was) {
            ESP_LOGW(TAG, "ws disconnected: %s", self->url_.c_str());
            self->dispatch_.post([self]() {
                for (auto& cb : self->disconnect_cbs_) cb();
            });
        }
        break;
    }

    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "ws error: %s", self->url_.c_str());
        break;

    case WEBSOCKET_EVENT_DATA: {
        if (!data || data->data_len <= 0) break;
        if (data->op_code == 0x8) break;   // close frame: handled above

        // Accumulate fragments; only act on a complete message.
        self->frame_buf_.append(data->data_ptr, data->data_len);
        if ((data->payload_offset + data->data_len) < data->payload_len) break;

        std::string complete = std::move(self->frame_buf_);
        self->frame_buf_.clear();

        if (data->op_code == 0x2) {  // binary
            std::vector<uint8_t> buf(complete.begin(), complete.end());
            self->dispatch_.post([self, buf = std::move(buf)]() {
                for (auto& cb : self->binary_cbs_) cb(buf.data(), buf.size());
            });
            break;
        }

        cJSON* msg = cJSON_Parse(complete.c_str());
        if (!msg) {
            ESP_LOGW(TAG, "non-JSON ws message: %.60s", complete.c_str());
            break;
        }
        self->dispatch_.post([self, msg]() {
            for (auto& cb : self->message_cbs_) cb(msg);
            cJSON_Delete(msg);
        });
        break;
    }

    default:
        break;
    }
}

// ===========================================================================
// HttpClientEsp
// ===========================================================================

struct HttpClientEsp::Request {
    HttpClientEsp* owner;
    std::string    url;
    std::string    method;
    std::string    body;
    std::string    token;
    int            timeout_ms;
    std::function<void(int, cJSON*)> cb;
};

struct HttpClientEsp::SSERequest {
    HttpClientEsp*   owner;
    std::string      url;
    std::string      body;
    std::string      token;
    SSEEventCallback on_event;
    SSEDoneCallback  on_done;
};

HttpClientEsp::HttpClientEsp(int timeout_ms) : timeout_ms_(timeout_ms) {}
HttpClientEsp::~HttpClientEsp() { dispatch_.drain(); }

void HttpClientEsp::setAuthToken(const std::string& token) { token_ = token; }

static esp_err_t collect_body_cb(esp_http_client_event_t* evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data_len > 0) {
        auto* body = static_cast<std::string*>(evt->user_data);
        body->append(static_cast<const char*>(evt->data), evt->data_len);
    }
    return ESP_OK;
}

void HttpClientEsp::request_task(void* arg)
{
    auto* req = static_cast<Request*>(arg);

    std::string resp_body;
    resp_body.reserve(512);

    esp_http_client_config_t cfg = {};
    cfg.url               = req->url.c_str();
    cfg.timeout_ms        = req->timeout_ms > 0 ? req->timeout_ms : 5000;
    cfg.event_handler     = collect_body_cb;
    cfg.user_data         = &resp_body;
    cfg.keep_alive_enable = true;

    int status = 0;
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client) {
        if (req->method == "POST") {
            esp_http_client_set_method(client, HTTP_METHOD_POST);
            esp_http_client_set_header(client, "Content-Type", "application/json");
            if (!req->body.empty()) {
                esp_http_client_set_post_field(client, req->body.c_str(),
                                               (int)req->body.size());
            }
        }
        if (!req->token.empty()) {
            std::string bearer = "Bearer " + req->token;
            esp_http_client_set_header(client, "Authorization", bearer.c_str());
        }

        esp_err_t err = esp_http_client_perform(client);
        status = esp_http_client_get_status_code(client);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "%s %s failed: %s", req->method.c_str(),
                     req->url.c_str(), esp_err_to_name(err));
            status = 0;
        }
        esp_http_client_cleanup(client);
    }

    cJSON* parsed = resp_body.empty() ? nullptr : cJSON_Parse(resp_body.c_str());
    auto cb = std::move(req->cb);
    req->owner->dispatch_.post([cb = std::move(cb), status, parsed]() {
        // IHttpClient contract: resp is non-owning, valid only for the call.
        if (cb) cb(status, parsed);
        if (parsed) cJSON_Delete(parsed);
    });

    delete req;
    vTaskDelete(nullptr);
}

void HttpClientEsp::get(const std::string& url,
                        std::function<void(int, cJSON*)> cb)
{
    auto* req = new Request{ this, url, "GET", "", token_, timeout_ms_, std::move(cb) };
    if (xTaskCreate(request_task, "dir_http", 6144, req, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate(dir_http) failed");
        auto failed = std::move(req->cb);
        delete req;
        if (failed) failed(0, nullptr);
    }
}

void HttpClientEsp::post(const std::string& url, cJSON* body,
                         std::function<void(int, cJSON*)> cb)
{
    std::string body_str;
    if (body) {
        char* s = cJSON_PrintUnformatted(body);
        if (s) { body_str = s; cJSON_free(s); }
        cJSON_Delete(body);
    }
    auto* req = new Request{ this, url, "POST", std::move(body_str), token_,
                             timeout_ms_, std::move(cb) };
    if (xTaskCreate(request_task, "dir_http", 6144, req, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate(dir_http) failed");
        auto failed = std::move(req->cb);
        delete req;
        if (failed) failed(0, nullptr);
    }
}

void HttpClientEsp::sse_task(void* arg)
{
    auto* req = static_cast<SSERequest*>(arg);
    auto  fail = [&]() {
        auto done = req->on_done;
        req->owner->dispatch_.post([done]() { if (done) done(false); });
    };

    esp_http_client_config_t cfg = {};
    cfg.url               = req->url.c_str();
    cfg.timeout_ms        = 0;      // no idle timeout — long-lived stream
    cfg.keep_alive_enable = true;

    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (!client) { fail(); delete req; vTaskDelete(nullptr); return; }

    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "Accept", "text/event-stream");
    if (!req->token.empty()) {
        std::string bearer = "Bearer " + req->token;
        esp_http_client_set_header(client, "Authorization", bearer.c_str());
    }
    if (!req->body.empty()) {
        esp_http_client_set_post_field(client, req->body.c_str(),
                                       (int)req->body.size());
    }

    if (esp_http_client_open(client, (int)req->body.size()) != ESP_OK) {
        ESP_LOGE(TAG, "SSE open failed: %s", req->url.c_str());
        esp_http_client_cleanup(client);
        fail(); delete req; vTaskDelete(nullptr); return;
    }

    esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (status < 200 || status >= 300) {
        ESP_LOGE(TAG, "SSE bad status %d from %s", status, req->url.c_str());
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        fail(); delete req; vTaskDelete(nullptr); return;
    }

    // Read loop — parse `event:` / `data:` lines as they arrive; a blank line
    // terminates an event.
    std::string line_buf, cur_event, cur_data;
    char chunk[512];

    auto dispatch_event = [&](const std::string& ev, const std::string& d) {
        auto cb = req->on_event;
        req->owner->dispatch_.post([cb, ev, d]() { if (cb) cb(ev, d); });
    };

    while (true) {
        int n = esp_http_client_read(client, chunk, sizeof(chunk));
        if (n <= 0) break;  // EOF or error
        line_buf.append(chunk, n);

        size_t pos;
        while ((pos = line_buf.find('\n')) != std::string::npos) {
            std::string line = line_buf.substr(0, pos);
            line_buf.erase(0, pos + 1);
            if (!line.empty() && line.back() == '\r') line.pop_back();

            if (line.empty()) {
                if (!cur_data.empty() || !cur_event.empty()) {
                    dispatch_event(cur_event, cur_data);
                    cur_event.clear();
                    cur_data.clear();
                }
                continue;
            }
            if (line.compare(0, 6, "event:") == 0) {
                cur_event = line.substr(6);
                if (!cur_event.empty() && cur_event.front() == ' ') cur_event.erase(0, 1);
            } else if (line.compare(0, 5, "data:") == 0) {
                std::string d = line.substr(5);
                if (!d.empty() && d.front() == ' ') d.erase(0, 1);
                if (!cur_data.empty()) cur_data += "\n";
                cur_data += d;
            }
            // id:, retry: and comment lines are ignored.
        }
    }

    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    auto done = req->on_done;
    req->owner->dispatch_.post([done]() { if (done) done(true); });

    delete req;
    vTaskDelete(nullptr);
}

void HttpClientEsp::postSSE(const std::string& url, cJSON* body,
                            SSEEventCallback on_event, SSEDoneCallback on_done)
{
    std::string body_str;
    if (body) {
        char* s = cJSON_PrintUnformatted(body);
        if (s) { body_str = s; cJSON_free(s); }
        cJSON_Delete(body);
    }
    auto* req = new SSERequest{ this, url, std::move(body_str), token_,
                                std::move(on_event), std::move(on_done) };
    if (xTaskCreate(sse_task, "dir_sse", 8192, req, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate(dir_sse) failed");
        auto done = std::move(req->on_done);
        delete req;
        if (done) done(false);
    }
}

// ===========================================================================
// DiscoveryEsp
// ===========================================================================

namespace {

bool g_mdns_up = false;

bool mdns_ensure()
{
    if (g_mdns_up) return true;
    esp_err_t err = mdns_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mdns_init failed: %s", esp_err_to_name(err));
        return false;
    }
    g_mdns_up = true;
    return true;
}

struct QueryArgs {
    std::string service_type;
    std::string proto;
    uint32_t    timeout_ms;
    std::function<void(std::vector<dirigible::DiscoveryResult>)> cb;
};

struct DeliverArgs {
    std::function<void(std::vector<dirigible::DiscoveryResult>)> cb;
    std::vector<dirigible::DiscoveryResult>* results;
};

void deliver_on_lvgl(void* arg)
{
    auto* d = static_cast<DeliverArgs*>(arg);
    if (d->cb) d->cb(std::move(*d->results));
    delete d->results;
    delete d;
}

void query_task(void* arg)
{
    auto* a = static_cast<QueryArgs*>(arg);
    auto* results = new std::vector<dirigible::DiscoveryResult>();

    mdns_result_t* found = nullptr;
    esp_err_t err = mdns_query_ptr(a->service_type.c_str(), a->proto.c_str(),
                                   a->timeout_ms, 20 /* max results */, &found);
    if (err == ESP_OK && found) {
        for (mdns_result_t* r = found; r; r = r->next) {
            dirigible::DiscoveryResult res;
            if (r->hostname) res.hostname = r->hostname;
            // The service instance name (Lee advertises the machine's friendly
            // name) is not part of DiscoveryResult, so it rides in txt.
            if (r->instance_name) res.txt["instance"] = r->instance_name;
            res.port = r->port;
            for (mdns_ip_addr_t* ip = r->addr; ip; ip = ip->next) {
                if (ip->addr.type == ESP_IPADDR_TYPE_V4) {
                    char buf[16];
                    esp_ip4addr_ntoa(&ip->addr.u_addr.ip4, buf, sizeof(buf));
                    res.ipv4 = buf;
                    break;
                }
            }
            for (size_t i = 0; i < r->txt_count; i++) {
                if (r->txt[i].key && r->txt[i].value) {
                    res.txt[r->txt[i].key] = r->txt[i].value;
                }
            }
            results->push_back(std::move(res));
        }
        mdns_query_results_free(found);
    } else if (err != ESP_OK) {
        ESP_LOGW(TAG, "mdns_query_ptr(%s.%s) failed: %s",
                 a->service_type.c_str(), a->proto.c_str(), esp_err_to_name(err));
    }

    lv_async_call(deliver_on_lvgl, new DeliverArgs{ std::move(a->cb), results });
    delete a;
    vTaskDelete(nullptr);
}

}  // namespace

void DiscoveryEsp::query(const std::string& service_type,
                         const std::string& proto,
                         uint32_t timeout_ms,
                         std::function<void(std::vector<dirigible::DiscoveryResult>)> cb)
{
    if (!mdns_ensure()) { if (cb) cb({}); return; }
    auto* args = new QueryArgs{ service_type, proto, timeout_ms, std::move(cb) };
    if (xTaskCreate(query_task, "dir_mdns", 4096, args, 4, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate(dir_mdns) failed");
        auto failed = std::move(args->cb);
        delete args;
        if (failed) failed({});
    }
}

// ===========================================================================
// TransportFactoryEsp
// ===========================================================================

dirigible::IWebSocket* TransportFactoryEsp::createWebSocket(uint32_t reconnect_ms)
{
    return new WebSocketEsp(reconnect_ms);
}
dirigible::IHttpClient* TransportFactoryEsp::createHttpClient(int timeout_ms)
{
    return new HttpClientEsp(timeout_ms);
}
dirigible::IDiscovery* TransportFactoryEsp::createDiscovery()
{
    return new DiscoveryEsp();
}

}  // namespace dirigible_esp
