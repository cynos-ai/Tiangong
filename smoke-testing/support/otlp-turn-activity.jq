def observed_phase($phase): any(.[]; .phase == $phase);
def observed_outcome($name; $outcome): any(.[]; .name == $name and .outcome == $outcome);
{
  peerTransportStart: observed_phase("peer.transport.start"),
  peerTransportPing: observed_phase("peer.transport.ping"),
  peerTransportPong: observed_phase("peer.transport.pong"),
  openclawTurnStarted: observed_phase("openclaw.turn.start"),
  requestReady: observed_phase("model.request.ready"),
  responseReceived: observed_phase("model.response.received"),
  responseStarted: observed_phase("model.response.start"),
  responseProgress: observed_phase("model.response.progress"),
  retryObserved: observed_phase("model.retry"),
  modelComplete: observed_outcome("gen_ai.chat"; "complete"),
  modelTimedOut: observed_outcome("gen_ai.chat"; "timeout"),
  modelAborted: observed_outcome("gen_ai.chat"; "upstream_abort")
}
