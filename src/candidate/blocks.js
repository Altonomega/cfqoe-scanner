// Block plan for the block-adaptive Hard Deep Scan engine.
//
// The scan unit is a /24 grid cell intersected with the catalog (spec:
// docs/HARD-SCAN-REDESIGN.md §2). A range smaller than a grid cell is not
// split: it forms its own block, keyed by its CIDR. Cells contributed by
// more than one range merge into a single block (first contributor keeps
// the range attribution), and a sub-grid range already covered by a cell
// block is absorbed by it.
//
// Usable addresses follow the existing convention (size > 2 skips network
// and broadcast), applied per block segment: a full cell has 254 usable
// hosts at offsets 1–254. A block's probe order is a seeded permutation of
// its usable addresses, so per-block progress collapses to a single
// `probed` counter — seed + counter reproduce exactly which hosts a block
// has already contributed, independent of traversal order.
import { parseCidr, intToIp } from './ipv4.js';
import { mulberry32 } from '../random.js';

export const BLOCK_GRID_PREFIX = 24;
export const MAX_BLOCK_RUN_DEPTH = 32;
export const MAX_SPLIT_DEPTH = 2;

const probeOrderCache = new WeakMap();

function usableRunForSize(size) {
  return size > 2
    ? { startOffset: 1, usable: size - 2 }
    : { startOffset: 0, usable: size };
}

function makeSegment(base, size) {
  const { startOffset, usable } = usableRunForSize(size);
  return { base, size, startOffset, usable };
}

function assembleBlock({
  blockId, range, rangeIndex, base, size, prefix, splitDepth, parentBlockId, segments,
}) {
  const usable = segments.reduce((sum, segment) => sum + segment.usable, 0);
  return {
    blockId,
    // Mirrors blockId so block objects and candidate records share one
    // shape for the `block` field (report passthrough reads candidate.block).
    block: blockId,
    range,
    rangeIndex,
    base,
    size,
    prefix,
    splitDepth,
    parentBlockId: parentBlockId ?? null,
    index: null,
    startOffset: segments.length > 0 ? segments[0].startOffset : 0,
    usable,
    segments,
  };
}

function coversSpan(block, base, size) {
  return block.base <= base && base + size <= block.base + block.size;
}

export function buildBlockPlan(ranges, { prefix = BLOCK_GRID_PREFIX } = {}) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid block grid prefix: ${prefix}`);
  }
  const cellSize = 2 ** (32 - prefix);
  const blocks = [];
  const cellOwners = new Map();

  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
    const parsed = parseCidr(ranges[rangeIndex]);
    const rangeId = `${parsed.network}/${parsed.prefix}`;

    if (parsed.prefix > prefix) {
      // Sub-grid range: its own block, unless a cell block already covers
      // it or the same range line was already planned.
      const cellBase = Math.floor(parsed.base / cellSize) * cellSize;
      const owner = cellOwners.get(cellBase);
      if (owner && coversSpan(owner, parsed.base, parsed.size)) continue;
      if (blocks.some((block) => block.blockId === rangeId)) continue;
      blocks.push(assembleBlock({
        blockId: rangeId,
        range: rangeId,
        rangeIndex,
        base: parsed.base,
        size: parsed.size,
        prefix: parsed.prefix,
        splitDepth: 0,
        segments: [makeSegment(parsed.base, parsed.size)],
      }));
      continue;
    }

    const cellCount = parsed.size / cellSize;
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const cellBase = parsed.base + cellIndex * cellSize;
      if (cellOwners.has(cellBase)) continue;
      const block = assembleBlock({
        blockId: `${intToIp(cellBase)}/${prefix}`,
        range: rangeId,
        rangeIndex,
        base: cellBase,
        size: cellSize,
        prefix,
        splitDepth: 0,
        segments: [makeSegment(cellBase, cellSize)],
      });
      cellOwners.set(cellBase, block);
      blocks.push(block);
      // A sub-grid block planned earlier may sit inside this new cell; the
      // cell covers its addresses, so the standalone block is absorbed.
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const candidate = blocks[index];
        if (candidate !== block && candidate.prefix > prefix
          && coversSpan(block, candidate.base, candidate.size)) {
          blocks.splice(index, 1);
        }
      }
    }
  }

  // Plan order is the primer's stratification order: blocks grouped by
  // catalog range (ranges in catalog order, bases ascending within a
  // range), which the construction above already produces.
  for (let index = 0; index < blocks.length; index += 1) {
    blocks[index].index = index;
  }

  return {
    blocks,
    totalBlocks: blocks.length,
    totalAddresses: blocks.reduce((sum, block) => sum + block.size, 0),
    totalUsable: blocks.reduce((sum, block) => sum + block.usable, 0),
  };
}

// The block's full usable-address permutation: a Fisher–Yates shuffle of
// usable indices driven by a per-block stream, mulberry32(seed XOR base),
// so the order is an unbiased draw with no fixed-offset aliasing and is a
// pure function of (catalog, seed, block). The returned array is cached
// per (block, seed) and shared — treat it as read-only.
export function blockProbeOrder(block, seed = 404) {
  let bySeed = probeOrderCache.get(block);
  if (!bySeed) {
    bySeed = new Map();
    probeOrderCache.set(block, bySeed);
  }
  const cached = bySeed.get(seed);
  if (cached) return cached;

  const order = [];
  for (let index = 0; index < block.usable; index += 1) order.push(index);
  const random = mulberry32((seed ^ block.base) >>> 0);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [order[index], order[swapIndex]] = [order[swapIndex], order[index]];
  }
  bySeed.set(seed, order);
  return order;
}

function addressAtUsableIndex(block, usableIndex) {
  let remaining = usableIndex;
  for (const segment of block.segments) {
    if (remaining < segment.usable) {
      return segment.base + segment.startOffset + remaining;
    }
    remaining -= segment.usable;
  }
  return null;
}

// The candidate at a position in the block's probe order. Stable across
// calls for the same (block, probeIndex, seed); returns null once the
// block's usable addresses are exhausted, mirroring the traversal
// functions in hard-order.js.
export function blockCandidate(block, probeIndex, seed = 404) {
  if (!Number.isInteger(probeIndex) || probeIndex < 0 || probeIndex >= block.usable) {
    return null;
  }
  const usableIndex = blockProbeOrder(block, seed)[probeIndex];
  const address = addressAtUsableIndex(block, usableIndex);
  if (address === null) return null;
  return {
    ip: intToIp(address),
    range: block.range,
    block: block.blockId,
    blockId: block.blockId,
    blockIndex: block.index,
    hostOffset: address - block.base,
    probeIndex,
  };
}

// Run probes (primer + expansion) a block may receive in one run, spec
// §4.3: beyond 32 the Wilson interval narrows only as 1/√n while per-IP
// precision becomes the SPRT stage's job.
export function blockRunDepthCap(block) {
  return Math.min(block.usable, MAX_BLOCK_RUN_DEPTH);
}

function clipSegmentsToSpan(segments, spanBase, spanSize) {
  const spanEnd = spanBase + spanSize;
  const clipped = [];
  for (const segment of segments) {
    const runBase = segment.base + segment.startOffset;
    const runEnd = runBase + segment.usable;
    const overlapBase = Math.max(runBase, spanBase);
    const overlapEnd = Math.min(runEnd, spanEnd);
    if (overlapEnd <= overlapBase) continue;
    clipped.push({
      base: overlapBase,
      size: overlapEnd - overlapBase,
      startOffset: 0,
      usable: overlapEnd - overlapBase,
    });
  }
  return clipped;
}

// Splits a block into its two address halves (spec §5.3): the children
// inherit the parent's usable addresses, partitioned at the span midpoint,
// so a split costs no probes and strands no address. Returns null when the
// block may not split further (split depth cap, spec §5.2) or a half would
// hold no usable address. Statistical trigger conditions live in
// measurement/bandit.js (shouldSplitBlock); this is the structural split.
export function splitBlock(block, { maxSplitDepth = MAX_SPLIT_DEPTH } = {}) {
  if (block.splitDepth >= maxSplitDepth) return null;
  if (block.size < 2 || block.size % 2 !== 0) return null;
  const halfSize = block.size / 2;
  const children = [];
  for (let half = 0; half < 2; half += 1) {
    const childBase = block.base + half * halfSize;
    children.push(assembleBlock({
      blockId: `${intToIp(childBase)}/${block.prefix + 1}`,
      range: block.range,
      rangeIndex: block.rangeIndex,
      base: childBase,
      size: halfSize,
      prefix: block.prefix + 1,
      splitDepth: block.splitDepth + 1,
      parentBlockId: block.blockId,
      segments: clipSegmentsToSpan(block.segments, childBase, halfSize),
    }));
  }
  if (children.some((child) => child.usable === 0)) return null;
  return children;
}
