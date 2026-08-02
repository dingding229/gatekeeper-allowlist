import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { createRepository } from "../src/repository.js";

const setup = () => {
  const db = openDatabase(":memory:");
  return { db, repository: createRepository(db) };
};

test("the fourth unique IP evicts the first IP", () => {
  const { db, repository } = setup();
  const user = repository.createUser("alice");
  repository.addIp(user.id, "10.0.0.1", 4);
  repository.addIp(user.id, "10.0.0.2", 4);
  repository.addIp(user.id, "10.0.0.3", 4);
  const result = repository.addIp(user.id, "10.0.0.4", 4);

  assert.equal(result.evicted, "10.0.0.1");
  assert.deepEqual(
    repository.listUserIps(user.id).map((row) => row.ip),
    ["10.0.0.2", "10.0.0.3", "10.0.0.4"],
  );
  db.close();
});

test("reposting an existing IP is idempotent and preserves FIFO order", () => {
  const { db, repository } = setup();
  const user = repository.createUser("bob");
  repository.addIp(user.id, "2001:db8::1", 6);
  repository.addIp(user.id, "2001:db8::2", 6);

  const result = repository.addIp(user.id, "2001:db8::1", 6);
  assert.equal(result.status, "existing");
  assert.equal(repository.listUserIps(user.id).length, 2);

  repository.addIp(user.id, "2001:db8::3", 6);
  const fourth = repository.addIp(user.id, "2001:db8::4", 6);
  assert.equal(fourth.evicted, "2001:db8::1");
  db.close();
});

test("users own independent three-slot allowlists", () => {
  const { db, repository } = setup();
  const alice = repository.createUser("alice");
  const bob = repository.createUser("bob");

  for (let index = 1; index <= 4; index += 1) {
    repository.addIp(alice.id, `10.0.0.${index}`, 4);
  }
  repository.addIp(bob.id, "192.0.2.1", 4);

  assert.equal(repository.listUserIps(alice.id).length, 3);
  assert.deepEqual(
    repository.listUserIps(bob.id).map((row) => row.ip),
    ["192.0.2.1"],
  );
  db.close();
});
