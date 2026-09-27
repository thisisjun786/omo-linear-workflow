import { expect, test } from "bun:test";
import { createEventBus } from "@code-yeongyu/senpi";
import { subscribeGoalChannelState } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/goal/channel-state-subscriptions.js";
import {
  isContinuationHoldStateEvent,
  isWakeSourceStateEvent,
} from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/monitor-state-event.js";
import { questionWaitWire } from "../src/extension/index";

interface PersistedEntry {
  readonly customType: string;
  readonly data: unknown;
}

const savedState = {
  ids: ["question:child:custom"],
  settled: ["question:child:settled"],
  pause: { id: "packet-goal", updatedAt: 7 },
  userOverride: false,
};

test("question wait wire is accepted by pinned Senpi across hold, release, reload and persistence", () => {
  const events = createEventBus();
  const raw: Array<{ readonly name: string; readonly data: unknown }> = [];
  const wake: Array<{ readonly source: string; readonly activeCount: number }> = [];
  const holds: Array<{ readonly source: string; readonly active: boolean }> = [];
  const entries: PersistedEntry[] = [];
  events.on("continuation_hold_state", (data) => raw.push({ name: "hold", data }));
  events.on("wake_source_state", (data) => raw.push({ name: "wake", data }));
  const unsubscribe = subscribeGoalChannelState(events, {
    onWakeSource: (source, activeCount) => wake.push({ source, activeCount }),
    onContinuationHold: (source, active) => holds.push({ source, active }),
  });
  const wire = questionWaitWire({
    events,
    appendEntry: (customType, data) => entries.push({ customType, data }),
  });

  wire.appendQuestionWait(savedState);
  wire.emitQuestionWait(true, savedState.ids);
  wire.emitQuestionWait(false, []);
  wire.emitQuestionWait(true, savedState.ids); // session reload republishes persisted state

  expect(
    raw.every(({ name, data }) =>
      name === "hold" ? isContinuationHoldStateEvent(data) : isWakeSourceStateEvent(data),
    ),
  ).toBe(true);
  expect(holds).toEqual([
    { source: "olw-question", active: true },
    { source: "olw-question", active: false },
    { source: "olw-question", active: true },
  ]);
  expect(wake).toEqual([
    { source: "olw-question", activeCount: 1 },
    { source: "olw-question", activeCount: 0 },
    { source: "olw-question", activeCount: 1 },
  ]);
  expect(entries).toEqual([{ customType: "olw-question-wait", data: savedState }]);
  for (const stop of unsubscribe) stop();
});
