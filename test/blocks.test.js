import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildBlockPlan,
  blockProbeOrder,
  blockCandidate,
  blockHalfProbeOrder,
  blockHalfCandidate,
  blockRunDepthCap,
  splitBlock,
} from '../src/candidate/blocks.js';
import { parseRangeList, ipToInt, intToIp } from '../src/candidate/ipv4.js';

function collectBlockIps(block, seed = 404) {
  const ips = [];
  for (let probeIndex = 0; probeIndex < block.usable; probeIndex += 1) {
    ips.push(blockCandidate(block, probeIndex, seed).ip);
  }
  return ips;
}

test('a single /24 range yields one full block', () => {
  const plan = buildBlockPlan(['192.0.2.0/24']);
  assert.equal(plan.totalBlocks, 1);
  const [block] = plan.blocks;
  assert.equal(block.blockId, '192.0.2.0/24');
  assert.equal(block.range, '192.0.2.0/24');
  assert.equal(block.size, 256);
  assert.equal(block.usable, 254);
  assert.equal(block.startOffset, 1);
  assert.equal(block.splitDepth, 0);
  assert.equal(block.index, 0);
  assert.equal(plan.totalAddresses, 256);
  assert.equal(plan.totalUsable, 254);
});

test('wider ranges partition into /24 cells', () => {
  assert.equal(buildBlockPlan(['192.0.2.0/22']).totalBlocks, 4);
  assert.equal(buildBlockPlan(['192.0.0.0/20']).totalBlocks, 16);
  // parseCidr normalizes 192.0.2.0/22 to its network base, 192.0.0.0.
  const plan = buildBlockPlan(['192.0.2.0/22']);
  assert.deepEqual(plan.blocks.map((block) => block.blockId), [
    '192.0.0.0/24', '192.0.1.0/24', '192.0.2.0/24', '192.0.3.0/24',
  ]);
});

test('a sub-/24 range forms its own block keyed by its CIDR', () => {
  const plan = buildBlockPlan(['198.51.100.128/25']);
  assert.equal(plan.totalBlocks, 1);
  const [block] = plan.blocks;
  assert.equal(block.blockId, '198.51.100.128/25');
  assert.equal(block.size, 128);
  assert.equal(block.usable, 126);
});

test('tiny ranges keep every address usable', () => {
  const [single] = buildBlockPlan(['192.0.2.7/32']).blocks;
  assert.equal(single.usable, 1);
  assert.equal(single.startOffset, 0);
  const [pair] = buildBlockPlan(['192.0.2.0/31']).blocks;
  assert.equal(pair.usable, 2);
  const [quad] = buildBlockPlan(['192.0.2.0/30']).blocks;
  assert.equal(quad.usable, 2);
  assert.equal(quad.startOffset, 1);
});

test('duplicate and overlapping ranges merge into one block set', () => {
  assert.equal(buildBlockPlan(['192.0.2.0/24', '192.0.2.0/24']).totalBlocks, 1);
  assert.equal(buildBlockPlan(['10.0.0.0/16', '10.0.0.0/24']).totalBlocks, 256);
  assert.equal(buildBlockPlan(['10.0.0.0/24', '10.0.0.0/16']).totalBlocks, 256);
});

test('a sub-grid range covered by a cell block is absorbed either way', () => {
  assert.equal(buildBlockPlan(['203.0.113.64/26', '203.0.113.0/24']).totalBlocks, 1);
  assert.equal(buildBlockPlan(['203.0.113.0/24', '203.0.113.64/26']).totalBlocks, 1);
});

test('blocks stay grouped by catalog range in catalog order', () => {
  const plan = buildBlockPlan(['198.51.100.0/24', '192.0.2.0/23']);
  assert.deepEqual(plan.blocks.map((block) => block.rangeIndex), [0, 1, 1]);
  assert.deepEqual(plan.blocks.map((block) => block.blockId), [
    '198.51.100.0/24', '192.0.2.0/24', '192.0.3.0/24',
  ]);
});

test('empty catalog yields an empty plan', () => {
  const plan = buildBlockPlan([]);
  assert.equal(plan.totalBlocks, 0);
  assert.equal(plan.totalAddresses, 0);
  assert.equal(plan.totalUsable, 0);
});

test('shipped catalog derives exactly 7,697 full blocks', () => {
  const catalogText = fs.readFileSync(
    new URL('../config/cloudflare-ipv4.txt', import.meta.url),
    'utf8',
  );
  const plan = buildBlockPlan(parseRangeList(catalogText));
  assert.equal(plan.totalBlocks, 7697);
  assert.equal(plan.totalAddresses, 1970432);
  assert.equal(plan.totalUsable, 1955038);
  assert.equal(new Set(plan.blocks.map((block) => block.blockId)).size, 7697);
  assert.ok(plan.blocks.every((block) => block.size === 256 && block.usable === 254));
});

test('block probe order is a deterministic permutation of usable indices', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const order = blockProbeOrder(block, 404);
  assert.equal(order.length, 254);
  assert.deepEqual(
    [...order].sort((left, right) => left - right),
    Array.from({ length: 254 }, (unused, index) => index),
  );
  assert.deepEqual(blockProbeOrder(block, 404), order);
  assert.notDeepEqual(blockProbeOrder(block, 7), order);
});

test('block candidates are stable, unique, and inside the block span', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const candidates = [];
  for (let probeIndex = 0; probeIndex < block.usable; probeIndex += 1) {
    candidates.push(blockCandidate(block, probeIndex, 404));
  }
  assert.equal(new Set(candidates.map((candidate) => candidate.ip)).size, 254);
  for (const candidate of candidates) {
    assert.equal(ipToInt(candidate.ip) - block.base, candidate.hostOffset);
    assert.ok(candidate.hostOffset >= 1 && candidate.hostOffset <= 254);
    assert.equal(candidate.block, '192.0.2.0/24');
    assert.equal(candidate.blockIndex, 0);
    assert.equal(candidate.range, '192.0.2.0/24');
  }
  assert.deepEqual(blockCandidate(block, 0, 404), candidates[0]);
  assert.equal(blockCandidate(block, 254, 404), null);
  assert.equal(blockCandidate(block, -1, 404), null);
});

test('run depth cap is min(usable, 32)', () => {
  const [full] = buildBlockPlan(['192.0.2.0/24']).blocks;
  assert.equal(blockRunDepthCap(full), 32);
  const [small] = buildBlockPlan(['192.0.2.0/30']).blocks;
  assert.equal(blockRunDepthCap(small), 2);
});

test('split halves partition the parent usable addresses', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const children = splitBlock(block);
  assert.equal(children.length, 2);
  const [lower, upper] = children;
  assert.equal(lower.blockId, '192.0.2.0/25');
  assert.equal(upper.blockId, '192.0.2.128/25');
  assert.equal(lower.usable, 127);
  assert.equal(upper.usable, 127);
  assert.equal(lower.splitDepth, 1);
  assert.equal(lower.parentBlockId, '192.0.2.0/24');

  const parentIps = new Set(collectBlockIps(block));
  const lowerIps = collectBlockIps(lower);
  const upperIps = collectBlockIps(upper);
  assert.equal(new Set([...lowerIps, ...upperIps]).size, 254);
  assert.deepEqual(new Set([...lowerIps, ...upperIps]), parentIps);
  const midpoint = block.base + 128;
  assert.ok(lowerIps.every((ip) => ipToInt(ip) < midpoint));
  assert.ok(upperIps.every((ip) => ipToInt(ip) >= midpoint));
});

test('splits recurse to /26 and stop at the depth cap', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const [lower] = splitBlock(block);
  const grandchildren = splitBlock(lower);
  assert.equal(grandchildren[0].blockId, '192.0.2.0/26');
  assert.equal(grandchildren[1].blockId, '192.0.2.64/26');
  assert.equal(grandchildren[0].usable + grandchildren[1].usable, 127);
  assert.equal(splitBlock(grandchildren[0]), null);
});

test('unsplittable blocks return null', () => {
  const [single] = buildBlockPlan(['192.0.2.7/32']).blocks;
  assert.equal(splitBlock(single), null);
});

test('half streams partition the usable addresses at the span midpoint', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const lower = blockHalfProbeOrder(block, 'lower', 404);
  const upper = blockHalfProbeOrder(block, 'upper', 404);
  // Usable offsets 1–254 split at the midpoint 128: 127 addresses each.
  assert.equal(lower.length, 127);
  assert.equal(upper.length, 127);
  assert.equal(new Set(lower).size, 127);
  assert.equal(new Set(upper).size, 127);
  assert.ok(lower.every((address) => address - block.base < 128));
  assert.ok(upper.every((address) => address - block.base >= 128));
  // Together the halves cover exactly the block's usable addresses.
  const usable = new Set(collectBlockIps(block));
  assert.deepEqual(
    new Set([...lower, ...upper].map((address) => intToIp(address))),
    usable,
  );
});

test('half candidates are deterministic, contained, and exhaust cleanly', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const first = blockHalfCandidate(block, 'upper', 5, 777);
  assert.deepEqual(blockHalfCandidate(block, 'upper', 5, 777), first);
  assert.equal(first.blockId, block.blockId);
  assert.ok(first.hostOffset >= 128);
  const seen = new Set();
  for (let index = 0; index < 127; index += 1) {
    const candidate = blockHalfCandidate(block, 'lower', index, 777);
    assert.ok(candidate.hostOffset < 128);
    assert.ok(!seen.has(candidate.ip));
    seen.add(candidate.ip);
  }
  assert.equal(blockHalfCandidate(block, 'lower', 127, 777), null);
  assert.equal(blockHalfCandidate(block, 'lower', -1, 777), null);
  assert.equal(blockHalfCandidate(block, 'middle', 0, 777), null);
  assert.deepEqual(blockHalfProbeOrder(block, 'middle', 777), []);
});

test('half streams are independent of the main permutation and each other', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const mainBefore = collectBlockIps(block, 99);
  const lower = blockHalfProbeOrder(block, 'lower', 99).map(intToIp);
  const upper = blockHalfProbeOrder(block, 'upper', 99).map(intToIp);
  // Drawing from the half streams leaves the main order untouched.
  assert.deepEqual(collectBlockIps(block, 99), mainBefore);
  // The lower half's stream is not the main order filtered to the half,
  // and a different seed produces a different half order.
  const mainLower = mainBefore.filter((ip) => ipToInt(ip) - block.base < 128);
  assert.notDeepEqual(lower, mainLower);
  assert.notDeepEqual(blockHalfProbeOrder(block, 'lower', 100).map(intToIp), lower);
  assert.notDeepEqual(upper, lower);
});

test('half streams work on split children', () => {
  const [block] = buildBlockPlan(['192.0.2.0/24']).blocks;
  const [lowerChild] = splitBlock(block);
  const lower = blockHalfProbeOrder(lowerChild, 'lower', 404);
  const upper = blockHalfProbeOrder(lowerChild, 'upper', 404);
  // The child's usable offsets are 1–127; its midpoint is 64.
  assert.equal(lower.length, 63);
  assert.equal(upper.length, 64);
  assert.ok(lower.every((address) => address - lowerChild.base < 64));
  assert.ok(upper.every((address) => address - lowerChild.base >= 64));
  const candidate = blockHalfCandidate(lowerChild, 'upper', 0, 404);
  assert.equal(candidate.blockId, lowerChild.blockId);
  assert.ok(candidate.hostOffset >= 64 && candidate.hostOffset < 128);
});
