# Native OMO thread delivery proof

Observed 2026-09-22, installed OMO with Senpi 2026.9.22.

## Scenario

On a dedicated native shared host, open two independent sessions through the
public `RpcClient` API. Subscribe to the idle receiver's assistant message event
before sending. Invoke an extension RPC handler on the sender:

```js
pi.rpc.handle("oi.probe.send", (data) => {
  pi.setActiveTools([...new Set([...pi.getActiveTools(), "thread_send"])]);
  return pi.executeTool("thread_send", data);
});
```

The request uses the receiver's durable session ID, `delivery: "auto"`,
`all_scope: true`, and a unique `idempotency_key`. Message:
`Reply exactly NATIVE_EVENT_READY`.

Command: `bun .omo/evidence/probe-native-client.mjs`.

## Observations

Actual `getAllTools()` includes thread_create, thread_list, thread_read,
thread_send, thread_interrupt, thread_handoff, thread_rename, thread_set_model,
thread_set_reasoning.

Before explicit activation, executeTool returned registered-but-inactive.
After activation through the public API:

```json
{
  "kind": "ok",
  "thread_id": "01a0c8ee-7077-7301-bd52-d8785293fe1b",
  "delivery": {
    "kind": "started",
    "turn_id": "turn-1790077471778"
  },
  "message_seq": 1,
  "deduplicated": false
}
```

Independent receiver event: `TARGET_TEXT NATIVE_EVENT_READY`.
Probe result: `NATIVE_SEND_PASS`, exit 0.

This proves native idle wake and a correlated acceptance receipt, not duplicate
handling, crash recovery or hierarchy enforcement. Those remain implementation
criteria and require their own tests.

## Cleanup

Both session IDs were explicitly closed and both RpcClient transports stopped.
`omo host stop --socket /home/jun/code/omo-initiative/.omo/evidence/qa-omo.sock`
reported stopped PID 4034712 and zero sessions. Earlier PID 4031349 was also
stopped with zero sessions after the inactive-tool attempt.

Custom launch specs must be mode 0600, allow only OMO_/SENPI_/PI_ env names, and
contain extension entry paths beneath the spec parent. The QA-only spec was
temporarily placed at /home/jun/.omo-initiative-qa-launch.json, then removed.
