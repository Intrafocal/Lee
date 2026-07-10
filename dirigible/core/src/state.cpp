#include "dirigible/state.hpp"

namespace dirigible {

EventBus& EventBus::instance() {
    static EventBus bus;
    return bus;
}

void EventBus::on(Event event, Callback cb) {
    listeners_.push_back({event, std::move(cb)});
}

void EventBus::emit(Event event) {
    for (auto& slot : listeners_) {
        if (slot.event == event) {
            slot.cb();
        }
    }
}

}  // namespace dirigible
