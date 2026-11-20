// Synthetic catalog + fake probe for the Hard Scan DNA simulation harness
// (spec: docs/HARD-SCAN-REDESIGN.md §9). The fixture builds a real block
// plan over synthetic ranges, assigns each block a ground-truth success
// probability from one of the spec's five quality maps, and exposes a
// `task(candidate, round)` fake probe with the exact shape of
// probeWebsocket's observations. Everything is a pure function of the
// fixture seed: the same (block, host offset, round) always yields the
// same outcome, across calls and across processes, which is what makes
// the pre-registered pass criteria in test/hard-dna-simulation.test.js
// reproducible — and what lets a resumed run replay identically.
//
// Per-IP truth (spec §9.1): an IP in block b succeeds with probability
// q_b, except 5% of IPs in every block are individually dead (q = 0).
// Failure flavour follows the §1.2 "typical" scenario: 70% timeouts, 30%
// fast failures. Latency draws are recorded nowhere — the criteria are
// expressed in probe counts, not simulated seconds.
import { buildBlockPlan } from '../../src/candidate/blocks.js';
import { ipToInt, intToIp } from '../../src/candidate/ipv4.js';
import { mulberry32 } from '../../src/random.js';

const COLOS = ['FRA', 'LHR', 'AMS', 'WAW', 'VIE', 'PRG', 'BUD', 'OTP'];
const DEAD_IP_FRACTION = 0.05;

function gaussian(rng) {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Gamma with a positive integer shape: -ln of a product of uniforms.
// Beta(a, b) is then Gamma(a) / (Gamma(a) + Gamma(b)) — exact for the
// integer shapes the clustered map uses.
function gammaInt(shape, rng) {
  let product = 1;
  for (let index = 0; index < shape; index += 1) product *= 1 - rng();
  return -Math.log(product);
}

function beta(rng, alpha, betaShape) {
  const x = gammaInt(alpha, rng);
  const y = gammaInt(betaShape, rng);
  return x / (x + y);
}

function clampRate(value) {
  return Math.min(0.98, Math.max(0.01, value));
}

// Map A "clustered" (spec §9.1): a few hot ranges (base rate ~ Beta(8, 2))
// among cold ones (~ Beta(2, 8)); block quality is the range base plus
// spatially smoothed local noise, so good blocks arrive in clusters.
function clusteredTruth(blocks, rng) {
  const truth = new Map();
  const byRange = new Map();
  for (const block of blocks) {
    if (!byRange.has(block.rangeIndex)) byRange.set(block.rangeIndex, []);
    byRange.get(block.rangeIndex).push(block);
  }
  for (const rangeBlocks of byRange.values()) {
    const hot = rng() < 0.08;
    const base = hot ? beta(rng, 8, 2) : beta(rng, 2, 8);
    const noise = rangeBlocks.map(() => gaussian(rng) * 0.08);
    rangeBlocks.forEach((block, index) => {
      const previous = noise[index - 1] ?? noise[index];
      const next = noise[index + 1] ?? noise[index];
      const smoothed = (previous + 2 * noise[index] + next) / 4;
      truth.set(block.blockId, { q: clampRate(base + smoothed) });
    });
  }
  return truth;
}

const MAP_BUILDERS = {
  // Map A — the expected real-world case.
  clustered(blocks, rng) {
    return clusteredTruth(blocks, rng);
  },
  // Map A′ "drifted": Map A with every block rate perturbed by
  // N(0, 0.05), clipped — the warm-start map of criterion 6.
  drifted(blocks, rng) {
    const truth = clusteredTruth(blocks, rng);
    for (const entry of truth.values()) {
      entry.q = clampRate(entry.q + gaussian(rng) * 0.05);
    }
    return truth;
  },
  // Map B "sparse gems": 1% of blocks are near-perfect, 9% are mediocre,
  // the rest are nearly dead — finding rare hot blocks is the design's
  // raison d'être.
  'sparse-gems'(blocks, rng) {
    const order = blocks.map((block) => block.blockId);
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    const truth = new Map();
    order.forEach((blockId, rank) => {
      const fraction = rank / order.length;
      const q = fraction < 0.01 ? 0.95 : fraction < 0.10 ? 0.5 : 0.03;
      truth.set(blockId, { q });
    });
    return truth;
  },
  // Map C "uniform null": no structure at all — the design must not lose
  // to the round-robin baseline here.
  'uniform-null'(blocks) {
    return new Map(blocks.map((block) => [block.blockId, { q: 0.25 }]));
  },
  // Map D "heterogeneous": Map A plus 3% of blocks internally split —
  // one half hot, the other nearly dead (orientation alternates).
  heterogeneous(blocks, rng) {
    const truth = clusteredTruth(blocks, rng);
    const shuffled = [...blocks];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    const heteroCount = Math.round(blocks.length * 0.03);
    shuffled.slice(0, heteroCount).forEach((block, index) => {
      const flipped = index % 2 === 1;
      truth.set(block.blockId, {
        q: 0.475,
        lowerQ: flipped ? 0.05 : 0.9,
        upperQ: flipped ? 0.9 : 0.05,
      });
    });
    return truth;
  },
};

export const VIRTUAL_MAPS = Object.keys(MAP_BUILDERS);

export function createVirtualCatalog({ ranges, map = 'clustered', seed = 20240 }) {
  if (!MAP_BUILDERS[map]) throw new Error(`Unknown virtual map: ${map}`);
  const plan = buildBlockPlan(ranges);
  const rng = mulberry32(seed);
  const truth = MAP_BUILDERS[map](plan.blocks, rng);
  const blocksByBase = [...plan.blocks].sort((left, right) => left.base - right.base);
  const probeLog = [];

  function blockOfIp(ip) {
    const address = ipToInt(ip);
    let low = 0;
    let high = blocksByBase.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const block = blocksByBase[middle];
      if (address < block.base) high = middle - 1;
      else if (address >= block.base + block.size) low = middle + 1;
      else return block;
    }
    return null;
  }

  function trueRate(block, hostOffset) {
    const entry = truth.get(block.blockId);
    if (!entry) return 0;
    if (entry.lowerQ !== undefined) {
      return hostOffset < block.size / 2 ? entry.lowerQ : entry.upperQ;
    }
    return entry.q;
  }

  function isIndividuallyDead(block, hostOffset) {
    const draw = mulberry32((block.base ^ 0xdead ^ Math.imul(hostOffset + 1, 40503)) >>> 0);
    return draw() < DEAD_IP_FRACTION;
  }

  // The fake probe: deterministic in (block, host offset, round). The
  // success draw consumes the stream first; latency and failure flavour
  // draw after it, so outcomes never depend on call order.
  async function task(candidate, round = 1) {
    const block = blockOfIp(candidate.ip);
    if (!block) throw new Error(`IP outside the virtual catalog: ${candidate.ip}`);
    const hostOffset = ipToInt(candidate.ip) - block.base;
    const stream = mulberry32(
      (block.base ^ Math.imul(hostOffset + 1, 2654435761) ^ Math.imul(round, 97)) >>> 0,
    );
    const successDraw = stream();
    const ok = !isIndividuallyDead(block, hostOffset)
      && successDraw < trueRate(block, hostOffset);
    probeLog.push({ ip: candidate.ip, blockId: block.blockId, round, ok });
    if (ok) {
      const handshakeMs = Math.round(700 * Math.exp(0.4 * gaussian(stream)) * 100) / 100;
      const colo = COLOS[block.rangeIndex % COLOS.length];
      return {
        ok: true,
        statusCode: 101,
        handshakeMs,
        connectMs: Math.round(handshakeMs * 0.4 * 100) / 100,
        cfRay: `0000000000000000-${colo}`,
        colo,
        error: null,
      };
    }
    const timeout = stream() < 0.7;
    return {
      ok: false,
      statusCode: null,
      handshakeMs: null,
      connectMs: null,
      cfRay: null,
      colo: null,
      error: timeout ? 'timeout' : 'ECONNRESET',
    };
  }

  // The true top blocks by mean success rate (heterogeneous blocks count
  // at their mean), ties broken by blockId so the set is stable.
  function topBlocks(fraction = 0.01) {
    const count = Math.max(1, Math.round(plan.blocks.length * fraction));
    return [...plan.blocks]
      .map((block) => ({ blockId: block.blockId, q: truth.get(block.blockId)?.q ?? 0 }))
      .sort((left, right) => right.q - left.q || left.blockId.localeCompare(right.blockId))
      .slice(0, count)
      .map((entry) => entry.blockId);
  }

  function heterogeneousBlockIds() {
    return plan.blocks
      .filter((block) => truth.get(block.blockId)?.lowerQ !== undefined)
      .map((block) => block.blockId);
  }

  return {
    ranges,
    plan,
    blocks: plan.blocks,
    truth,
    task,
    probeLog,
    blockOfIp,
    trueRate,
    topBlocks,
    heterogeneousBlockIds,
    resetProbeLog() {
      probeLog.length = 0;
    },
  };
}

// `count` synthetic /19 ranges (32 blocks each) inside 10.0.0.0/8 —
// documentation space would be far too small for a catalog of thousands
// of blocks, and the fixture never leaves the process.
export function virtualRanges(count = 64) {
  const ranges = [];
  for (let index = 0; index < count; index += 1) {
    ranges.push(`10.${Math.floor(index / 8)}.${(index % 8) * 32}.0/19`);
  }
  return ranges;
}

export { intToIp };
