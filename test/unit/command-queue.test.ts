import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../../src/application/errors.js";
import { SerializedCommandQueue } from "../../src/sessions/commandQueue.js";

test("workspace commands execute in FIFO order", async () => {
  const queue = new SerializedCommandQueue();
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(async () => {
    order.push("first:start");
    await blocked;
    order.push("first:end");
    return 1;
  });
  const second = queue.enqueue(async () => {
    order.push("second");
    return 2;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("a cancelled queued command never starts", async () => {
  const queue = new SerializedCommandQueue();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue(async () => blocked);
  const controller = new AbortController();
  let started = false;
  const second = queue.enqueue(async () => {
    started = true;
  }, controller.signal);
  controller.abort();
  release();
  await first;
  await assert.rejects(
    second,
    (error: unknown) =>
      error instanceof ApplicationError && error.details.cancelled === true,
  );
  assert.equal(started, false);
});
