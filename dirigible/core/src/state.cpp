#include "dirigible/state.hpp"

namespace dirigible {

EventBus& EventBus::instance() {
    static EventBus bus;
    return bus;
}

void EventBus::on(Event event, Callback cb) {
    listeners_.push_back({event, std::move(cb)});
}

void EventBus::onPtyData(PtyCallback cb) {
    pty_listeners_.push_back(std::move(cb));
}

void EventBus::emit(Event event) {
    for (auto& slot : listeners_) {
        if (slot.event == event) {
            slot.cb();
        }
    }
}

void EventBus::emitPtyData(int pty_id, const uint8_t* data, size_t len) {
    for (auto& cb : pty_listeners_) {
        cb(pty_id, data, len);
    }
}

}  // namespace dirigible
